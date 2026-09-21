import type { LatLng } from '$lib/trip/days';
import { supabase } from '$lib/supabase';
import { haversineKm } from './geo';
import type { Mode } from './modes';

const pointKeyOf = (p: LatLng) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;

/**
 * Real routed geometry for drawing a day on the map.
 *
 * Display only. The planner's travel times are still haversine estimates
 * resolved synchronously; this draws the line the traveller would actually
 * walk. Those two can disagree, and the leg minutes on the timeline remain the
 * planner's, not this service's.
 *
 * Valhalla rather than the OSRM demo: that demo answers every profile with the
 * same car route -- foot, bike and driving come back byte-identical -- so a
 * "walking" line from it would follow one-way systems and skip pedestrian
 * streets. Valhalla routes pedestrians properly.
 */
const ENDPOINT = 'https://valhalla1.openstreetmap.de/route';

const COSTING: Record<Mode, string> = {
	walk: 'pedestrian',
	bike: 'bicycle',
	car: 'auto',
	carshare: 'auto',
	// No GTFS on the public instance, so a bus route cannot be drawn. Walking
	// is the closest honest shape for the corridor it follows.
	transit: 'pedestrian'
};

/**
 * Decode an encoded polyline.
 *
 * Precision matters and the two sources disagree: Google encodes at 5, Valhalla
 * at 6. Decoding at the wrong one puts the route in the wrong hemisphere rather
 * than subtly off, so the caller always states which it has.
 */
export function decodePolyline(encoded: string, precision: 5 | 6): LatLng[] {
	const scale = precision === 6 ? 1e6 : 1e5;
	const points: LatLng[] = [];
	let index = 0;
	let lat = 0;
	let lng = 0;

	while (index < encoded.length) {
		for (const axis of ['lat', 'lng'] as const) {
			let result = 0;
			let shift = 0;
			let byte: number;
			do {
				byte = encoded.charCodeAt(index++) - 63;
				result |= (byte & 0x1f) << shift;
				shift += 5;
			} while (byte >= 0x20);
			const delta = result & 1 ? ~(result >> 1) : result >> 1;
			if (axis === 'lat') lat += delta;
			else lng += delta;
		}
		points.push({ lat: lat / scale, lng: lng / scale });
	}
	return points;
}

const cache = new Map<string, LatLng[] | null>();

const keyOf = (points: LatLng[], mode: Mode) =>
	`${mode}|${points.map((p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join(';')}`;

/**
 * The shape of a day's route, or null when it cannot be drawn. Null is a
 * normal answer: the service may be down, or there may be no road between two
 * points. The caller falls back to straight lines.
 */
export async function routeShape(
	points: LatLng[],
	mode: Mode,
	signal?: AbortSignal
): Promise<LatLng[] | null> {
	if (points.length < 2) return null;
	// Valhalla's public instance is a shared courtesy service; a day with fifty
	// stops is not a reasonable request to send it.
	if (points.length > 25) return null;

	const key = keyOf(points, mode);
	if (cache.has(key)) return cache.get(key)!;

	try {
		const res = await fetch(ENDPOINT, {
			method: 'POST',
			signal,
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				locations: points.map((p) => ({ lat: p.lat, lon: p.lng })),
				costing: COSTING[mode] ?? 'pedestrian',
				directions_options: { units: 'kilometers' }
			})
		});
		if (!res.ok) throw new Error(String(res.status));
		const body = await res.json();
		const shape = (body?.trip?.legs ?? [])
			.flatMap((leg: { shape?: string }) => (leg.shape ? decodePolyline6(leg.shape) : []));
		const result = shape.length > 1 ? shape : null;
		cache.set(key, result);
		return result;
	} catch {
		// Cache the failure too: a day that cannot be routed should not retry on
		// every re-render while the traveller drags things about.
		cache.set(key, null);
		return null;
	}
}

/** Valhalla's, kept as a named shorthand so existing callers read the same. */
export const decodePolyline6 = (encoded: string) => decodePolyline(encoded, 6);

export type RouteStep = {
	kind: 'transit' | 'walk' | 'drive' | 'wait';
	/** Raw, so steps sum without the drift of rounding each one. */
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
 * Collapse a run of walking (or driving) into one step. Turn-by-turn belongs to
 * the maps app the Open in Maps button hands off to; what this panel is for is
 * what to catch and when, and twenty "turn left" lines bury that.
 *
 * Seconds are summed and re-rounded once, so a fifteen-leg walk still totals
 * what the route said rather than fifteen roundings of it.
 */
export function groupSteps(steps: RouteStep[]): RouteStep[] {
	const out: RouteStep[] = [];
	for (const step of steps) {
		const prev = out[out.length - 1];
		const mergeable = step.kind === 'walk' || step.kind === 'drive';
		if (prev && mergeable && prev.kind === step.kind) {
			const seconds = prev.seconds + step.seconds;
			out[out.length - 1] = {
				kind: prev.kind,
				seconds,
				minutes: Math.round(seconds / 60),
				// Where the run started and where it ends up; the turns between
				// them are the part being dropped.
				from: prev.from,
				to: step.to ?? prev.to
			};
		} else {
			out.push(mergeable ? { ...step, instruction: undefined } : step);
		}
	}
	return out;
}

export type LegRoute = {
	/** Door to door, waits included -- what the leg actually costs. */
	minutes: number;
	/**
	 * Time actually moving. Google's own duration, which excludes waiting for
	 * the first service: the difference is time standing on a platform.
	 */
	movingMinutes: number;
	km: number;
	polyline: string | null;
	steps: RouteStep[];
	source: 'google' | 'cache';
};

const legCache = new Map<string, LegRoute | null>();

/**
 * The routed detail of one leg: what to actually catch, and the line to draw.
 *
 * Asked only for the legs of a settled plan -- n-1 of them, not n² pairs --
 * which is the only point at which a plan is concrete enough to route.
 */
export async function legRoute(
	from: LatLng,
	to: LatLng,
	mode: Mode,
	departAt: string | null,
	options: { prefer?: 'rail' | null } = {}
): Promise<LegRoute | null> {
	const prefer =
		// Left to itself the router puts an airport run on a coach, which is
		// cheap and slow. Rail is what people mean by the train from the airport.
		options.prefer ?? (mode === 'transit' && haversineKm(from, to) > 20 ? 'rail' : null);

	const key = `${pointKeyOf(from)}>${pointKeyOf(to)}|${mode}|${departAt ?? 'any'}|${prefer ?? ''}`;
	if (legCache.has(key)) return legCache.get(key)!;

	try {
		const { data, error } = await supabase.functions.invoke('route', {
			body: { from, to, mode, departAt, prefer }
		});
		const route = error ? null : ((data?.route ?? null) as LegRoute | null);
		legCache.set(key, route);
		return route;
	} catch {
		// Offline, or the function is down. The leg still shows its estimate.
		legCache.set(key, null);
		return null;
	}
}
