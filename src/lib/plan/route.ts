import type { LatLng } from '$lib/trip/days';
import type { Mode } from './modes';

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
 * Valhalla returns an encoded polyline at precision 6, not the 5 that most
 * decoders assume. Decoding at the wrong precision puts the route in the
 * wrong hemisphere rather than subtly off.
 */
export function decodePolyline6(encoded: string): LatLng[] {
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
		points.push({ lat: lat / 1e6, lng: lng / 1e6 });
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
