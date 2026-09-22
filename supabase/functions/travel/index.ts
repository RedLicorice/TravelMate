import { createClient } from 'jsr:@supabase/supabase-js@2';
import { cors } from '../_shared/cors.ts';
import { signedIn } from '../_shared/caller.ts';
import { afford } from '../_shared/budget.ts';
import { isMode, isPoint, isWhen, type LatLng, type Mode } from '../_shared/input.ts';

const MATRIX = 'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix';

/** Google's travel modes. carshare is a car you do not own. */
const TRAVEL_MODE: Record<Mode, string> = {
	walk: 'WALK',
	bike: 'BICYCLE',
	transit: 'TRANSIT',
	car: 'DRIVE',
	carshare: 'DRIVE'
};

/** Transit matrices are capped at 100 elements; road modes at 625. */
const MAX_ELEMENTS: Record<string, number> = { TRANSIT: 100 };
const DEFAULT_MAX_ELEMENTS = 625;

const key = (p: LatLng) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;

/**
 * Journeys are cached per departure hour, because a transit journey at 08:00
 * is a different journey from the same one at 23:00. Modes whose duration does
 * not depend on departure share one bucket rather than storing 24 identical
 * rows.
 */
const bucketOf = (mode: Mode, departAt: string | null) =>
	mode === 'transit' && departAt ? `h${new Date(departAt).getUTCHours()}` : 'any';

/** Timetables change; roads do not. */
const ttlDays = (mode: Mode) => (mode === 'transit' ? 7 : 30);

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { ...cors, 'Content-Type': 'application/json' }
	});

type Cell = { from: string; to: string; minutes: number; km: number; source: string };

Deno.serve(async (req) => {
	if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

	// Paid work, so it is done for a traveller and nobody else.
	const traveller = await signedIn(req);
	if (!traveller) return json({ cells: [] }, 401);

	try {
		const { points, mode, departAt } = (await req.json()) as {
			points: LatLng[];
			mode: Mode;
			departAt: string | null;
		};

		if (!Array.isArray(points) || points.length < 2) return json({ cells: [] });
		// Everything below this line is spent: a coordinate goes into a billed
		// request, and a mode Google does not know is a drive nobody asked for.
		if (!isMode(mode) || !points.every(isPoint) || !isWhen(departAt)) {
			return json({ cells: [], error: 'bad_request' }, 400);
		}

		const travelMode = TRAVEL_MODE[mode];
		const cap = MAX_ELEMENTS[travelMode] ?? DEFAULT_MAX_ELEMENTS;
		// Refusing beats truncating: a partial matrix looks like a complete one
		// and would quietly mis-order a day.
		if (points.length * points.length > cap) {
			return json({ cells: [], error: 'too_many_points' });
		}

		const bucket = bucketOf(mode, departAt);
		const keys = points.map(key);
		const db = createClient(
			Deno.env.get('SUPABASE_URL')!,
			Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
		);

		// 1. What is already known and still fresh?
		const { data: cached } = await db
			.from('travel_cache')
			.select('from_key,to_key,minutes,km,source')
			.eq('mode', mode)
			.eq('depart_bucket', bucket)
			.gt('expires_at', new Date().toISOString())
			.in('from_key', keys)
			.in('to_key', keys);

		const have = new Map(
			(cached ?? []).map((c) => [
				`${c.from_key}>${c.to_key}`,
				{ from: c.from_key, to: c.to_key, minutes: c.minutes, km: Number(c.km), source: c.source }
			])
		);
		const complete = keys.every((f) => keys.every((t) => f === t || have.has(`${f}>${t}`)));
		if (complete) return json({ cells: [...have.values()] });

		// 2. Ask for the whole matrix. Billing is per element requested, so the
		//    gaps alone would be cheaper; a full matrix is asked for because it
		//    keeps the cache coherent -- every pair answered at the same
		//    departure, from the same provider, expiring together.
		const waypoints = points.map((p) => ({
			waypoint: { location: { latLng: { latitude: p.lat, longitude: p.lng } } }
		}));
		const body: Record<string, unknown> = {
			origins: waypoints,
			destinations: waypoints,
			travelMode
		};
		// departureTime is required for TRANSIT and meaningless without it.
		// routingPreference is a DRIVE-only field that TRANSIT rejects.
		if (travelMode === 'TRANSIT') body.departureTime = departAt ?? new Date().toISOString();

		// Charged for the whole matrix before it is asked for, because that is
		// what Google bills whether the answer is useful or not.
		if (!(await afford(db, traveller, waypoints.length * waypoints.length))) {
			return json({ cells: [...have.values()], error: 'budget' }, 429);
		}

		const res = await fetch(MATRIX, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Goog-Api-Key': Deno.env.get('GOOGLE_MAPS_KEY')!,
				'X-Goog-FieldMask': 'originIndex,destinationIndex,duration,distanceMeters,condition'
			},
			body: JSON.stringify(body)
		});

		if (!res.ok) {
			// The caller has a fallback chain. Returning what we have beats a 500
			// that stops the trip rendering at all.
			const detail = await res.text();
			console.error('routes error', res.status, detail.slice(0, 400));
			return json({ cells: [...have.values()], error: `routes_${res.status}` });
		}

		const elements = (await res.json()) as {
			originIndex: number;
			destinationIndex: number;
			duration?: string;
			distanceMeters?: number;
			condition?: string;
		}[];

		const expires = new Date(Date.now() + ttlDays(mode) * 86_400_000).toISOString();
		const rows = elements
			.filter((e) => e.condition === 'ROUTE_EXISTS' && e.originIndex !== e.destinationIndex)
			.map((e) => ({
				from_key: keys[e.originIndex],
				to_key: keys[e.destinationIndex],
				mode,
				depart_bucket: bucket,
				minutes: Math.round(Number(String(e.duration ?? '0s').replace('s', '')) / 60),
				km: Math.round((e.distanceMeters ?? 0) / 100) / 10,
				source: 'google',
				expires_at: expires
			}))
			// A zero-minute leg between two different points is the matrix saying
			// "no answer", not a journey that takes no time.
			.filter((r) => r.minutes > 0);

		if (rows.length) await db.from('travel_cache').upsert(rows);

		const cells: Cell[] = rows.map((r) => ({
			from: r.from_key,
			to: r.to_key,
			minutes: r.minutes,
			km: r.km,
			source: 'google'
		}));
		// Anything Google could not route falls back to what was cached.
		for (const cell of have.values()) {
			if (!cells.some((c) => c.from === cell.from && c.to === cell.to)) cells.push(cell);
		}
		return json({ cells });
	} catch (error) {
		console.error('travel function failed', error);
		// The caller gets no exception text: it names internal types and
		// constraints, and it is read by whoever asked, not by us.
		return json({ cells: [], error: 'internal' }, 500);
	}
});
