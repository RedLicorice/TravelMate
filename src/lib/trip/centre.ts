import type { LatLng } from './days';
import type { PlacementRow } from './placements';

/**
 * Where a day is: the middle of the places on it.
 *
 * Its stops, and its meals at a chosen place -- not the hotel and its cards,
 * not time to yourself or a meal still to decide (both are wherever the day
 * already is), not the journey. For a day Replan arranged this is the point
 * it clustered the day around; for a day built by hand, the middle of what
 * was put there. Worked out from the day as it stands, so it follows every
 * change. Null for a day with no places. An average of coordinates: a city
 * is small enough for that to be the middle.
 */
export function dayCentre(
	placements: PlacementRow[],
	placeOf: (poiId: string) => LatLng | undefined,
	day: number
): LatLng | null {
	const points = placements
		.filter((pl) => pl.day_index === day && !pl.skipped && pl.poi_id && (pl.kind === 'stop' || pl.kind === 'meal'))
		.map((pl) => placeOf(pl.poi_id!))
		.filter((p): p is LatLng => !!p);
	if (!points.length) return null;
	return {
		lat: points.reduce((s, p) => s + p.lat, 0) / points.length,
		lng: points.reduce((s, p) => s + p.lng, 0) / points.length
	};
}
