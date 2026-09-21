import { supabase } from '$lib/supabase';
import { PLANNER_VERSION } from '$lib/plan/planner';
import type { PlanResult, PlannedDay, PlannedStop, Warning } from '$lib/plan/planner';
import type { Day } from './days';
import type { Leg, Mode } from '$lib/plan/modes';

/**
 * A stop as it is stored. This is the plan of record: once Regenerate has run,
 * every view reads these rows rather than re-deriving times, so a plan does not
 * quietly re-time itself because the page was opened on a different day or
 * because a provider answered differently.
 */
export type PlanStopRow = {
	day_index: number;
	order_index: number;
	poi_id: string | null;
	name: string;
	lat: number;
	lng: number;
	anchor: boolean;
	anchor_kind: 'hotel' | 'terminal' | 'service' | 'chore' | 'meal' | null;
	time_label: string | null;
	starts_at: string;
	ends_at: string;
	duration_min: number;
	pinned: boolean;
	leg_mode: string | null;
	leg_minutes: number | null;
	leg_km: number | null;
	warnings: Warning[];
	busyness: number | null;
	exit_lat: number | null;
	exit_lng: number | null;
};

const toRow = (tripId: string, dayIndex: number, orderIndex: number, s: PlannedStop) => ({
	trip_id: tripId,
	day_index: dayIndex,
	order_index: orderIndex,
	poi_id: s.poiId,
	name: s.name,
	lat: s.at.lat,
	lng: s.at.lng,
	anchor: s.anchor,
	anchor_kind: s.anchorKind ?? null,
	time_label: s.timeLabel ?? null,
	starts_at: s.arrive.toISOString(),
	ends_at: s.depart.toISOString(),
	duration_min: s.durationMin,
	pinned: s.pinned ?? false,
	leg_mode: s.legIn?.mode ?? null,
	leg_minutes: s.legIn?.minutes ?? null,
	leg_km: s.legIn?.km ?? null,
	warnings: s.warnings,
	busyness: s.busyness,
	exit_lat: s.exitAt?.lat ?? null,
	exit_lng: s.exitAt?.lng ?? null
});

/**
 * Replace the trip's plan. Delete-then-insert rather than a diff: plan_stops is
 * derived data that Regenerate can always produce again, so the cost of a
 * failure between the two halves is one more tap, not lost work.
 *
 * `plan_generated_at` is written last and on purpose. Everything the traveller
 * changed before this moment is now reflected in the plan, and anything stamped
 * after it is genuinely newer than the plan -- which is exactly what staleCount
 * goes on to measure.
 */
export async function savePlan(tripId: string, result: PlanResult): Promise<string> {
	const rows = result.days.flatMap((d) =>
		d.stops.map((s, i) => toRow(tripId, d.index, i, s))
	);

	const del = await supabase.from('plan_stops').delete().eq('trip_id', tripId);
	if (del.error) throw new Error(del.error.message);

	if (rows.length) {
		const ins = await supabase.from('plan_stops').insert(rows);
		if (ins.error) throw new Error(ins.error.message);
	}

	const generatedAt = new Date().toISOString();
	const { error } = await supabase
		.from('trips')
		.update({ plan_generated_at: generatedAt, plan_version: PLANNER_VERSION })
		.eq('id', tripId);
	if (error) throw new Error(error.message);
	return generatedAt;
}

export async function loadPlan(tripId: string): Promise<PlanStopRow[]> {
	const { data, error } = await supabase
		.from('plan_stops')
		.select(
			'day_index,order_index,poi_id,name,lat,lng,anchor,anchor_kind,time_label,starts_at,ends_at,duration_min,pinned,leg_mode,leg_minutes,leg_km,warnings,busyness,exit_lat,exit_lng'
		)
		.eq('trip_id', tripId)
		.order('day_index', { ascending: true })
		.order('order_index', { ascending: true });
	if (error) throw new Error(error.message);
	return (data ?? []) as PlanStopRow[];
}

const toLeg = (row: PlanStopRow): Leg | null => {
	if (row.leg_mode === null) return null;
	const km = Number(row.leg_km ?? 0);
	// Two cards standing in the same place have no leg between them. Plans
	// stored before that was true carry a transit overhead on a leg of zero
	// length, and would show "12 min · 0 km · transit" until regenerated.
	if (km === 0) return null;
	return { mode: row.leg_mode as Mode, minutes: row.leg_minutes ?? 0, km };
};

/**
 * Rebuild the shape the views draw from stored rows.
 *
 * `days` supplies each day's calendar date -- which lives on the trip, not on
 * a stop, so a day the plan left empty still appears with its date on it --
 * and its waypoints, which say whether an anchor is the hotel, a terminal, a
 * service or a chore. Plans stored before that was recorded have none, and
 * every view needs the same answer, so it is resolved here rather than in each
 * of them.
 */
export function toPlannedDays(rows: PlanStopRow[], days: Day[]): PlannedDay[] {
	if (!rows.length && !days.length) return [];

	const spanned = rows.reduce((n, r) => Math.max(n, r.day_index + 1), 0);
	const count = Math.max(days.length, spanned);

	/** Name -> kind, from the day's own anchors. */
	const kindsFor = (index: number) =>
		new Map(
			[...(days[index]?.fixedStart ?? []), ...(days[index]?.fixedEnd ?? [])].map((w) => [
				w.name,
				w.kind
			])
		);
	const kinds = Array.from({ length: count }, (_, i) => kindsFor(i));

	const planned: PlannedDay[] = Array.from({ length: count }, (_, index) => ({
		index,
		date: days[index]?.date ?? '',
		stops: [],
		overflowed: []
	}));

	for (const row of [...rows].sort(
		(a, b) => a.day_index - b.day_index || a.order_index - b.order_index
	)) {
		planned[row.day_index]?.stops.push({
			poiId: row.poi_id,
			name: row.name,
			at: { lat: row.lat, lng: row.lng },
			arrive: new Date(row.starts_at),
			depart: new Date(row.ends_at),
			durationMin: row.duration_min,
			legIn: toLeg(row),
			anchor: row.anchor,
			anchorKind: row.anchor_kind ?? (row.anchor ? kinds[row.day_index]?.get(row.name) ?? 'hotel' : null),
			timeLabel: row.time_label,
			busyness: row.busyness === null ? null : Number(row.busyness),
			warnings: row.warnings ?? [],
			exitAt:
				row.exit_lat !== null && row.exit_lng !== null
					? { lat: row.exit_lat, lng: row.exit_lng }
					: null
		});
	}
	return planned;
}

/**
 * How many places have changed since the plan was made. Counted once for the
 * line beside Regenerate -- the wishlist already says which stop is which, so
 * this only has to answer "is the plan behind, and by how much".
 */
export function staleCount(
	pois: { created_at: string; updated_at?: string | null }[],
	planGeneratedAt: string | null
): number {
	// Never regenerated: every place is waiting on the first plan.
	if (!planGeneratedAt) return pois.length;
	const cutoff = Date.parse(planGeneratedAt);
	return pois.filter((p) => {
		const touched = Date.parse(p.updated_at ?? p.created_at);
		return Math.max(touched, Date.parse(p.created_at)) > cutoff;
	}).length;
}
