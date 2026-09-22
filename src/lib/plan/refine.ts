import type { PlannedDay } from './planner';
import { legRoute, type LegRoute } from './route';
import { pointKey, tableFrom, type TravelCell, type TravelTable } from './travel';
import type { LatLng } from '$lib/trip/days';
import type { Mode } from './modes';
import { pool } from '$lib/pool';

type RouteFn = (
	from: LatLng,
	to: LatLng,
	mode: Mode,
	departAt: string | null
) => Promise<LegRoute | null>;

/**
 * How many legs to route at once. Sequential took the better part of a minute
 * on a four-day trip, and firing all of them spends the quota in one tap.
 */
const LANES = 6;

export type RefineProgress = { done: number; total: number };

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
export async function routedTable(
	days: PlannedDay[],
	route: RouteFn = legRoute,
	onProgress?: (p: RefineProgress) => void
): Promise<TravelTable> {
	// Collect first, route second. Every leg of a settled plan is independent
	// of every other, so there is nothing to await in between.
	const legs: { from: LatLng; to: LatLng; mode: Mode; departAt: string }[] = [];
	const seen = new Set<string>();

	for (const day of days) {
		for (let i = 1; i < day.stops.length; i++) {
			const from = day.stops[i - 1];
			const to = day.stops[i];
			const mode = to.legIn?.mode;
			if (!mode) continue;

			// A stop you leave from somewhere else is left from there.
			const leaves = from.exitAt ?? from.at;
			const key = `${pointKey(leaves)}>${pointKey(to.at)}|${mode}`;
			if (seen.has(key)) continue;
			seen.add(key);

			// Depart when the plan says the traveller leaves. A transit answer
			// for the wrong hour is a different journey.
			legs.push({ from: leaves, to: to.at, mode, departAt: from.depart.toISOString() });
		}
	}

	let done = 0;
	onProgress?.({ done, total: legs.length });

	const routed = await pool(legs, LANES, async (l) => {
		const answer = await route(l.from, l.to, l.mode, l.departAt);
		onProgress?.({ done: ++done, total: legs.length });
		return answer;
	});

	const cells: TravelCell[] = [];
	routed.forEach((answer, i) => {
		if (!answer) return;
		cells.push({
			from: pointKey(legs[i].from),
			to: pointKey(legs[i].to),
			minutes: answer.minutes,
			km: answer.km,
			source: 'google'
		});
	});
	return tableFrom(cells);
}
