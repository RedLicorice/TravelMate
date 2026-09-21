import type { LatLng } from '$lib/trip/days';
import type { Mode } from '$lib/plan/modes';

/**
 * Handing off to a maps app.
 *
 * This app does not navigate. Its estimates exist to order stops; when the
 * traveller is actually standing on a corner they want the thing that already
 * does turn-by-turn well.
 */
const TRAVEL_MODE: Record<Mode, string> = {
	walk: 'walking',
	bike: 'bicycling',
	transit: 'transit',
	car: 'driving',
	carshare: 'driving'
};

const coord = (p: LatLng) => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;

/** Directions for one hop. */
export function legUrl(from: LatLng, to: LatLng, mode: Mode): string {
	const params = new URLSearchParams({
		api: '1',
		origin: coord(from),
		destination: coord(to),
		travelmode: TRAVEL_MODE[mode] ?? 'walking'
	});
	return `https://www.google.com/maps/dir/?${params}`;
}

/**
 * The points a day's route actually passes through.
 *
 * A stop you leave from somewhere else contributes two: where you got on and
 * where you got off. Without the second one the handoff would draw a straight
 * line across the river and the walk out would start from the wrong bank.
 */
export function routePoints(stops: { at: LatLng; exitAt?: LatLng | null }[]): LatLng[] {
	return stops.flatMap((s) => (s.exitAt ? [s.at, s.exitAt] : [s.at]));
}

/**
 * The whole day as one route. Google takes at most nine waypoints between
 * origin and destination; a longer day is truncated rather than rejected,
 * because most of the day is still more useful than none of it.
 */
export const MAX_WAYPOINTS = 9;

export function dayUrl(points: LatLng[], mode: Mode): string | null {
	if (points.length < 2) return null;
	const origin = points[0];
	const destination = points[points.length - 1];
	const middle = points.slice(1, -1).slice(0, MAX_WAYPOINTS);

	const params = new URLSearchParams({
		api: '1',
		origin: coord(origin),
		destination: coord(destination),
		travelmode: TRAVEL_MODE[mode] ?? 'walking'
	});
	if (middle.length) params.set('waypoints', middle.map(coord).join('|'));
	return `https://www.google.com/maps/dir/?${params}`;
}

/** True when a day had to be trimmed to fit, so the UI can say so. */
export const dayTruncated = (points: LatLng[]) => points.slice(1, -1).length > MAX_WAYPOINTS;
