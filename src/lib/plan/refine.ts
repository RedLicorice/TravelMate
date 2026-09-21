import type { PlannedDay } from './planner';
import { legRoute, type LegRoute } from './route';
import { pointKey, tableFrom, type TravelCell, type TravelTable } from './travel';
import type { LatLng } from '$lib/trip/days';
import type { Mode } from './modes';

type RouteFn = (
	from: LatLng,
	to: LatLng,
	mode: Mode,
	departAt: string | null
) => Promise<LegRoute | null>;

/**
 * Tier 2: route the legs of a settled plan and hand back a table of what they
 * actually cost.
 *
 * The matrix that ordered the day is an estimate -- it has to be, because it
 * prices n² pairs before anyone knows which ones the plan will use. Once the
 * order is fixed there are only n-1 legs left, and each can be routed properly.
 * The airport transfer is where the two most disagree: a straight-line transit
 * estimate put Stansted to central London at over three hours, and the routed
 * answer is closer to two.
 *
 * Cells are marked `google` so the transit band is not applied on top: a routed
 * figure already contains its own walking, waiting and changes.
 */
export async function routedTable(days: PlannedDay[], route: RouteFn = legRoute): Promise<TravelTable> {
	const cells: TravelCell[] = [];
	const seen = new Set<string>();

	for (const day of days) {
		for (let i = 1; i < day.stops.length; i++) {
			const from = day.stops[i - 1];
			const to = day.stops[i];
			const mode = to.legIn?.mode;
			if (!mode) continue;

			const key = `${pointKey(from.at)}>${pointKey(to.at)}|${mode}`;
			if (seen.has(key)) continue;
			seen.add(key);

			// Depart when the plan says the traveller leaves. A transit answer
			// for the wrong hour is a different journey.
			const routed = await route(from.at, to.at, mode, from.depart.toISOString());
			if (!routed) continue;

			cells.push({
				from: pointKey(from.at),
				to: pointKey(to.at),
				minutes: routed.minutes,
				km: routed.km,
				source: 'google'
			});
		}
	}
	return tableFrom(cells);
}
