import { createClient } from 'jsr:@supabase/supabase-js@2';
import { cors } from '../_shared/cors.ts';
import { signedIn } from '../_shared/caller.ts';

type LatLng = { lat: number; lng: number };
type Mode = 'walk' | 'bike' | 'transit' | 'car' | 'carshare';

const ROUTES = 'https://routes.googleapis.com/directions/v2:computeRoutes';

/**
 * Bump whenever the shape of a cached step changes. Rows written by an older
 * function stop matching rather than being served to a client that expects
 * fields they do not have.
 */
const SCHEMA_VERSION = 3;

const TRAVEL_MODE: Record<Mode, string> = {
	walk: 'WALK',
	bike: 'BICYCLE',
	transit: 'TRANSIT',
	car: 'DRIVE',
	carshare: 'DRIVE'
};

/**
 * Only what is drawn or read. A field mask is required, and asking for
 * everything is both slower and billed at a higher tier.
 */
const FIELDS = [
	'routes.duration',
	'routes.distanceMeters',
	'routes.polyline.encodedPolyline',
	'routes.legs.steps.travelMode',
	'routes.legs.steps.staticDuration',
	'routes.legs.steps.distanceMeters',
	'routes.legs.steps.navigationInstruction.instructions',
	'routes.legs.steps.transitDetails'
].join(',');

const key = (p: LatLng) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;
const bucketOf = (mode: Mode, departAt: string | null, prefer?: string | null) =>
	mode === 'transit' && departAt
		? `h${new Date(departAt).getUTCHours()}${prefer ? `:${prefer}` : ''}`
		: 'any';
const ttlDays = (mode: Mode) => (mode === 'transit' ? 7 : 30);

/**
 * Google returns durations as "1234s". Kept in seconds all the way through:
 * rounding each of twenty steps to a minute and then adding them up drifts by
 * several minutes, which is enough to invent or hide a connection.
 */
const secondsOf = (duration: string | undefined) =>
	Number(String(duration ?? '0s').replace('s', '')) || 0;

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { ...cors, 'Content-Type': 'application/json' }
	});

type Step = {
	kind: 'transit' | 'walk' | 'drive' | 'wait';
	/** Raw, so a client can sum steps without drift. */
	seconds: number;
	line?: string;
	headsign?: string;
	from?: string;
	to?: string;
	departAt?: string;
	arriveAt?: string;
	minutes: number;
	stops?: number;
	instruction?: string;
};

/**
 * Google's step shape, reduced to what a traveller standing in a station needs.
 *
 * Waiting is emitted as its own step rather than left as the difference between
 * the total and the sum of the parts. Standing on a platform for eleven minutes
 * is part of the journey, and a plan that hides it claims free time it does not
 * have.
 */
function toSteps(legs: Record<string, unknown>[], departedAt: string | null): Step[] {
	const out: Step[] = [];
	// Walking steps carry no clock, so the clock is carried here: it starts when
	// the traveller sets off and advances by each step.
	let clock = departedAt ? new Date(departedAt).getTime() : null;

	for (const leg of legs ?? []) {
		for (const raw of ((leg.steps ?? []) as Record<string, unknown>[])) {
			const transit = raw.transitDetails as Record<string, unknown> | undefined;
			const seconds = secondsOf(raw.staticDuration as string);

			if (transit) {
				const line = (transit.transitLine ?? {}) as Record<string, unknown>;
				const stopDetails = (transit.stopDetails ?? {}) as Record<string, unknown>;
				const departure = (stopDetails.departureStop ?? {}) as Record<string, unknown>;
				const arrival = (stopDetails.arrivalStop ?? {}) as Record<string, unknown>;

				const departAt = stopDetails.departureTime as string | undefined;
				if (clock !== null && departAt) {
					const waitSeconds = Math.round((new Date(departAt).getTime() - clock) / 1000);
					// Under half a minute is stepping onto a train that is already
					// there, not waiting for one.
					if (waitSeconds >= 30) {
						out.push({
							kind: 'wait',
							seconds: waitSeconds,
							minutes: Math.round(waitSeconds / 60),
							to: departure.name as string,
							line: (line.nameShort as string) ?? (line.name as string)
						});
					}
				}

				out.push({
					kind: 'transit',
					// nameShort is "Central" where name is "Central line"; the short
					// form is what is written on the platform.
					line: (line.nameShort as string) ?? (line.name as string) ?? 'Service',
					headsign: transit.headsign as string,
					from: departure.name as string,
					to: arrival.name as string,
					departAt,
					arriveAt: stopDetails.arrivalTime as string,
					stops: transit.stopCount as number,
					seconds,
					minutes: Math.round(seconds / 60)
				});
				const arriveAt = stopDetails.arrivalTime as string | undefined;
				clock = arriveAt ? new Date(arriveAt).getTime() : clock;
			} else {
				const travelMode = String(raw.travelMode ?? 'WALK').toLowerCase();
				// Every step, including the short connecting walks. Dropping them
				// is how a plan quietly claims more free time than it has: four
				// "under a minute" transfers is a quarter of an hour.
				out.push({
					kind: travelMode === 'drive' ? 'drive' : 'walk',
					seconds,
					minutes: Math.round(seconds / 60),
					instruction: (
						(raw.navigationInstruction ?? {}) as Record<string, unknown>
					).instructions as string
				});
				// Advance by seconds, never by the rounded minutes above.
				if (clock !== null) clock += seconds * 1000;
			}
		}
	}
	return out;
}

Deno.serve(async (req) => {
	if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

	// Paid work, so it is done for a traveller and nobody else.
	if (!(await signedIn(req))) return json({ route: null }, 401);

	try {
		const { from, to, mode, departAt, prefer } = (await req.json()) as {
			from: LatLng;
			to: LatLng;
			mode: Mode;
			departAt: string | null;
			/** 'rail' biases away from coaches on long airport runs. */
			prefer?: 'rail' | null;
		};
		if (!from || !to) return json({ route: null });

		const bucket = bucketOf(mode, departAt, prefer);
		const db = createClient(
			Deno.env.get('SUPABASE_URL')!,
			Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
		);

		const { data: cached } = await db
			.from('route_cache')
			.select('minutes,moving_minutes,km,polyline,steps')
			.eq('from_key', key(from))
			.eq('to_key', key(to))
			.eq('mode', mode)
			.eq('depart_bucket', bucket)
			.eq('schema_version', SCHEMA_VERSION)
			.gt('expires_at', new Date().toISOString())
			.maybeSingle();
		if (cached) {
			return json({
				route: {
					minutes: cached.minutes,
					movingMinutes: cached.moving_minutes,
					km: Number(cached.km),
					polyline: cached.polyline,
					steps: cached.steps,
					source: 'cache'
				}
			});
		}

		const travelMode = TRAVEL_MODE[mode] ?? 'WALK';
		const body: Record<string, unknown> = {
			origin: { location: { latLng: { latitude: from.lat, longitude: from.lng } } },
			destination: { location: { latLng: { latitude: to.lat, longitude: to.lng } } },
			travelMode,
			polylineQuality: 'OVERVIEW'
		};
		// Transit needs a departure, and one in the past returns no routes at
		// all -- silently, with no error.
		if (travelMode === 'TRANSIT') {
			const when = departAt ? new Date(departAt) : new Date();
			body.departureTime = (when.getTime() > Date.now() ? when : new Date()).toISOString();
			if (prefer === 'rail') {
				// Left to itself the router will put an airport run on a coach,
				// which is cheap and slow. Rail is what people mean by "the train
				// from the airport".
				body.transitPreferences = {
					allowedTravelModes: ['TRAIN', 'SUBWAY', 'LIGHT_RAIL', 'RAIL'],
					routingPreference: 'FEWER_TRANSFERS'
				};
			}
		}

		const res = await fetch(ROUTES, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Goog-Api-Key': Deno.env.get('GOOGLE_MAPS_KEY')!,
				'X-Goog-FieldMask': FIELDS
			},
			body: JSON.stringify(body)
		});
		if (!res.ok) {
			console.error('routes error', res.status, (await res.text()).slice(0, 400));
			return json({ route: null, error: `routes_${res.status}` });
		}

		const parsed = await res.json();
		const route = (parsed.routes ?? [])[0];
		if (!route) return json({ route: null, error: 'no_route' });

		const steps = toSteps(route.legs ?? [], (body.departureTime as string) ?? null);

		// Google's duration measures the journey once it has begun: it does not
		// include standing on the platform waiting for the first service. A
		// traveller who has to leave at a given time pays that wait too, so the
		// cost of this leg is every step, waits included. Using the bare
		// duration is how a plan claims free time that does not exist.
		const doorToDoor = steps.reduce((sum, step) => sum + step.seconds, 0);
		const moving = secondsOf(route.duration);

		const row = {
			from_key: key(from),
			to_key: key(to),
			mode,
			depart_bucket: bucket,
			minutes: Math.round(Math.max(doorToDoor, moving) / 60),
			moving_minutes: Math.round(moving / 60),
			km: Math.round((route.distanceMeters ?? 0) / 100) / 10,
			polyline: route.polyline?.encodedPolyline ?? null,
			steps,
			schema_version: SCHEMA_VERSION,
			expires_at: new Date(Date.now() + ttlDays(mode) * 86_400_000).toISOString()
		};
		await db.from('route_cache').upsert(row);

		return json({
			route: {
				minutes: row.minutes,
				movingMinutes: row.moving_minutes,
				km: row.km,
				polyline: row.polyline,
				steps: row.steps,
				source: 'google'
			}
		});
	} catch (error) {
		console.error('route function failed', error);
		return json({ route: null, error: String(error) });
	}
});
