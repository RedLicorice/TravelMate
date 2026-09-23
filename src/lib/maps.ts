import { formatter } from '$lib/clock';
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
/**
 * A single place on Google Maps. Named as well as pinned, so the app opens on
 * the place's own card rather than on a bare dropped pin.
 */
export function placeUrl(at: LatLng, name?: string | null): string {
	const params = new URLSearchParams({ api: '1', query: `${at.lat},${at.lng}` });
	if (name) params.set('query', `${name}, ${at.lat},${at.lng}`);
	return `https://www.google.com/maps/search/?${params}`;
}

/**
 * One leg in Google Maps, from A to B in its mode.
 *
 * Google's documented links (Maps URLs) take no departure time, so a transit
 * leg is opened with the older link form, which does -- and which Google Maps
 * still reads. If it ever stops reading the time, Maps opens on "leave now",
 * which is all the documented link would have done anyway. Walking, cycling
 * and driving do not depend on the hour, and use the documented link.
 */
export function legUrl(
	from: LatLng,
	to: LatLng,
	mode: Mode,
	departAt?: string | null,
	timezone?: string
): string {
	if (mode === 'transit' && departAt && timezone) {
		const when = new Date(departAt);
		const date = formatter('en-US', { timeZone: timezone, month: '2-digit', day: '2-digit', year: 'numeric' }).format(when);
		const time = formatter('en-US', { timeZone: timezone, hour: 'numeric', minute: '2-digit', hour12: true })
			.format(when)
			.replace(/\s/g, '')
			.toLowerCase();
		const q = new URLSearchParams({ saddr: coord(from), daddr: coord(to), dirflg: 'r', ttype: 'dep', date, time });
		return `https://maps.google.com/maps?${q}`;
	}
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
