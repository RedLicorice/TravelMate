import type { LatLng } from '$lib/trip/days';
import { supabase } from '$lib/supabase';
import type { LegSource, Mode } from './modes';

/**
 * Real travel times, resolved before planning.
 *
 * The planner is synchronous -- it re-runs on every drag and hundreds of times
 * inside 2-opt -- so nothing here may be awaited from inside it. Every pair of
 * stops on a day is resolved up front into a plain table, in one matrix
 * request per mode, and the planner reads that table.
 *
 * Google answers, through the travel Edge Function that holds the key: roads
 * and footpaths, and transit on real timetables at the day's departure hour.
 * What it cannot answer -- offline, over budget, a transit day too long for
 * one matrix -- the phone's straight-line estimate covers (modes.ts), marked
 * as an estimate. Only the time a journey takes is kept; the way it goes is
 * Google Maps' to show.
 */
/** Rounded coordinates, so the same place keys identically every time. */
export const pointKey = (p: LatLng) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;

export type TravelTable = {
	/**
	 * Minutes and km, or null when nothing was resolved for this pair.
	 *
	 * `source` is what the answer is worth: a table that does not say is
	 * offering an estimate. `departAt` is offered to tables that answer per
	 * departure hour; the rest ignore it.
	 */
	get(
		from: LatLng,
		to: LatLng,
		mode: Mode,
		departAt?: string | null
	): { minutes: number; km: number; source?: LegSource } | null;
};

/**
 * The departure band a journey is cached under.
 *
 * Must match depart_bucket in the travel and route functions exactly, or the
 * client asks for an hour the server has already answered. A transit journey
 * at 08:00 is a different journey from the same one at 23:00; a road one is
 * not, so it shares a single bucket rather than storing 24 identical rows.
 */
export const departBucket = (mode: Mode, departAt: string | null | undefined) =>
	mode === 'transit' && departAt ? `h${new Date(departAt).getUTCHours()}` : 'any';

/** One answered pair, as the Edge Function returns it. */
export type TravelCell = {
	from: string;
	to: string;
	minutes: number;
	km: number;
	source: 'google';
};

/** Two tables consulted in order; the first with an answer wins. */
export const firstOf = (tables: TravelTable[]): TravelTable => ({
	get(from, to, mode) {
		for (const table of tables) {
			const answer = table.get(from, to, mode);
			if (answer) return answer;
		}
		return null;
	}
});

/**
 * Every pair among `points`, for each mode in use, as Google has it.
 *
 * One request per mode, not one per leg: a day of ten stops is a hundred
 * pairs, and the 2-opt search needs all of them because it reorders freely.
 * A pair Google did not answer is missing from the table, and the planner's
 * estimate stands in for it.
 */
export async function resolveTravel(
	points: LatLng[],
	modes: Mode[],
	departAt?: string | null
): Promise<TravelTable> {
	if (points.length < 2) return noTravel;
	const cells = new Map<string, TravelCell>();
	for (const mode of new Set(modes)) {
		try {
			const { data, error } = await supabase.functions.invoke('travel', {
				body: { points, mode, departAt: departAt ?? null }
			});
			if (error) continue;
			// Per mode: the same pair takes a different time on foot and on a train.
			for (const cell of (data?.cells ?? []) as TravelCell[]) cells.set(`${mode}|${cell.from}>${cell.to}`, cell);
		} catch {
			// Offline, or the function is down: the estimate stands in.
		}
	}
	return {
		get(from, to, mode) {
			const cell = cells.get(`${mode}|${pointKey(from)}>${pointKey(to)}`);
			return cell ? { minutes: cell.minutes, km: cell.km, source: 'routed' } : null;
		}
	};
}

export const noTravel: TravelTable = { get: () => null };
