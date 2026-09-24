import { ofTrip, perList, type Writer } from '$lib/store/store.svelte';
import { PLANNER_VERSION } from '$lib/plan/planner';
import type { PlanResult, PlannedDay, PlannedStop, Warning } from '$lib/plan/planner';
import type { Day } from './days';
import type { Leg, LegSource, Mode } from '$lib/plan/modes';
import { pointKey, type TravelTable } from '$lib/plan/travel';

/**
 * A stop as it is stored. This is the plan of record: once Regenerate has run,
 * every view reads these rows rather than re-deriving times, so a plan does not
 * quietly re-time itself because the page was opened on a different day or
 * because a provider answered differently.
 */
export type PlanStopRow = {
	/** The stop's own identity, kept across saves. */
	id: string;
	/**
	 * Which visit this card is: the placement it was drawn from. Null for an
	 * anchor, which is nobody's visit, and for plans stored before a place
	 * could be visited twice.
	 */
	placement_id: string | null;
	day_index: number;
	/**
	 * The order the plan was written in. Not what orders a day -- the clock
	 * does -- but loadPlan reads it, and orderedRows keeps the journey cards
	 * at either end of a day in exactly this order, which is the ticket's.
	 */
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
	/** Null on plans stored before legs said where their numbers came from. */
	leg_source: LegSource | null;
	warnings: Warning[];
	busyness: number | null;
	exit_lat: number | null;
	exit_lng: number | null;
};

/**
 * What makes a stop the same stop between one save and the next.
 *
 * A real stop is the visit it draws: the placement, not the place. Two coffees
 * at the same cafe on one day are two cards and two rows, and keying them by
 * what they are of would have them claim each other's.
 *
 * An anchor is nobody's visit, so it is the day it belongs to, what kind of
 * anchor it is, what it is called -- and which time it says that, because a
 * day starts and ends at the hotel. Without the count both of those are
 * "0:hotel:Hotel Artemide", the same stored row is claimed twice, and the
 * whole save is refused.
 *
 * A journey card -- a terminal, a service -- holds the instant off its
 * ticket, and that instant is what it is. Counting would pair the nth
 * airport before an edit to the legs with the nth one after it, which need
 * not be the same card; and the journey time the server routed for one
 * would be drawn under the other.
 */
type Identified = {
	placementId?: string | null;
	poiId: string | null;
	anchorKind?: string | null;
	name: string;
	/** When the card happens, in ms. */
	at: number;
};

const isTicket = (s: Identified) => s.anchorKind === 'terminal' || s.anchorKind === 'service';

const identity = (dayIndex: number, s: Identified, nth = 0) =>
	s.placementId ??
	s.poiId ??
	`${dayIndex}:${s.anchorKind ?? ''}:${s.name}:${isTicket(s) ? `@${s.at}` : nth}`;

/** Identity, counting repeats of the same anchor within its day. */
function identities(dayIndex: number, stops: Identified[]): string[] {
	const seen = new Map<string, number>();
	return stops.map((s) => {
		const base = identity(dayIndex, s);
		const nth = seen.get(base) ?? 0;
		seen.set(base, nth + 1);
		return identity(dayIndex, s, nth);
	});
}

const toRow = (
	tripId: string,
	dayIndex: number,
	orderIndex: number,
	s: PlannedStop,
	id: string | null
) => ({
	id,
	trip_id: tripId,
	day_index: dayIndex,
	order_index: orderIndex,
	poi_id: s.poiId,
	placement_id: s.placementId ?? null,
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
	leg_source: s.legIn?.source ?? null,
	warnings: s.warnings,
	busyness: s.busyness,
	exit_lat: s.exitAt?.lat ?? null,
	exit_lng: s.exitAt?.lng ?? null
});

/**
 * Write the trip's plan: this is the plan now.
 *
 * A stop keeps its row. The plan used to be deleted and written again on every
 * save, which gave the same place a new id each time -- fine while the client
 * that built the plan was the only thing that wrote it, and not fine now that
 * a real travel time is looked up after the fact and written back to the stop
 * it belongs to. An answer that arrives for a row the next save has already
 * deleted is an answer thrown away.
 *
 * `known` is the plan as it is stored, which is where the ids come from. A
 * stop the scheduler has just invented has none, and is given one here, so
 * the device can draw it before the server has seen it.
 *
 * Returns when the plan was made. Everything the traveller changed before
 * this moment is reflected in it, and anything stamped after it is genuinely
 * newer than the plan -- which is exactly what staleCount goes on to measure.
 */
export function savePlan(
	w: Writer,
	tripId: string,
	result: PlanResult,
	known: PlanStopRow[] = [],
	/** The days the result is for, when it is not the whole trip. */
	days?: number[]
): string {
	const ids = new Map<string, string>();
	const byDay = new Map<number, PlanStopRow[]>();
	for (const r of known) byDay.set(r.day_index, [...(byDay.get(r.day_index) ?? []), r]);
	for (const [day, rows] of byDay) {
		const ordered = orderedRows(rows);
		const keys = identities(
			day,
			ordered.map((r) => ({
				placementId: r.placement_id,
				poiId: r.poi_id,
				anchorKind: r.anchor_kind,
				name: r.name,
				at: Date.parse(r.starts_at)
			}))
		);
		keys.forEach((key, i) => ids.set(key, ordered[i].id));
	}

	const rows = result.days.flatMap((d) => {
		const keys = identities(d.index, d.stops.map((st) => ({ ...st, at: st.arrive.getTime() })));
		return d.stops.map((s, i) => toRow(tripId, d.index, i, s, s.id ?? ids.get(keys[i]) ?? null));
	});

	// One stored row cannot be two stops. If the same id is claimed twice --
	// two days that both once ended at the hotel, say -- the later claim is a
	// new row.
	const claimed = new Set<string>();
	for (const row of rows) {
		if (row.id && !claimed.has(row.id)) claimed.add(row.id);
		else row.id = crypto.randomUUID();
	}

	return w.plan(
		tripId,
		rows.map(({ trip_id: _ignored, ...rest }) => rest),
		PLANNER_VERSION,
		days
	);
}

/** The plan as stored, by day and in the order it was written. */
const inWrittenOrder = perList((list: PlanStopRow[]) =>
	[...list].sort((a, b) => a.day_index - b.day_index || a.order_index - b.order_index)
);
export const loadPlan = (tripId: string): PlanStopRow[] =>
	inWrittenOrder(ofTrip<PlanStopRow>('plan_stops', tripId));

/**
 * A day's rows in the order they happen.
 *
 * By the clock, which is what orders a day -- except for the journeys at
 * either end of the trip. A journey is atomic: airport, flight, airport;
 * station, train, station. It is the tickets the traveller holds, in the
 * order the tickets say, and it is not theirs to rearrange and not the
 * plan's either. So the run of journey cards the day opens with stays as it
 * was written, the run it closes with likewise, and the clock orders what
 * lies between them -- which is the part of the day anybody can move.
 */
const isJourney = (r: PlanStopRow) => r.anchor_kind === 'terminal' || r.anchor_kind === 'service';

export function orderedRows(rows: PlanStopRow[]): PlanStopRow[] {
	const days = new Map<number, PlanStopRow[]>();
	for (const r of rows) days.set(r.day_index, [...(days.get(r.day_index) ?? []), r]);
	const out: PlanStopRow[] = [];
	for (const day of [...days.keys()].sort((a, b) => a - b)) {
		const stored = days.get(day)!;
		let head = 0;
		while (head < stored.length && isJourney(stored[head])) head++;
		let tail = stored.length;
		while (tail > head && isJourney(stored[tail - 1])) tail--;
		out.push(
			...stored.slice(0, head),
			...stored.slice(head, tail).sort((a, b) => a.starts_at.localeCompare(b.starts_at)),
			...stored.slice(tail)
		);
	}
	return out;
}

const toLeg = (row: PlanStopRow): Leg | null => {
	if (row.leg_mode === null) return null;
	const km = Number(row.leg_km ?? 0);
	// Two cards standing in the same place have no leg between them. Plans
	// stored before that was true carry a transit overhead on a leg of zero
	// length, and would show "12 min · 0 km · transit" until regenerated.
	if (km === 0) return null;
	return {
		mode: row.leg_mode as Mode,
		minutes: row.leg_minutes ?? 0,
		km,
		// A plan stored before legs said where they came from was routed the
		// old way, synchronously, before it was saved. Taking it as routed is
		// what stops every old trip asking to be looked up again.
		source: (row.leg_source ?? 'routed') as LegSource
	};
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

	for (const row of orderedRows(rows)) {
		planned[row.day_index]?.stops.push({
			id: row.id,
			placementId: row.placement_id,
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
 * The journeys a stored plan already knows for real.
 *
 * The scheduler asks for travel by where it is going, not by which stop it is
 * timing, so what was looked up for one arrangement of a day is still true
 * after the cards are moved about. This is how a refined time survives the
 * next drag without being asked for again.
 */
export function tableFromPlan(rows: PlanStopRow[]): TravelTable {
	const known = new Map<string, { minutes: number; km: number }>();
	const byDay = new Map<number, PlanStopRow[]>();
	for (const row of rows) {
		const day = byDay.get(row.day_index) ?? [];
		day.push(row);
		byDay.set(row.day_index, day);
	}
	for (const day of byDay.values()) {
		// In the order the day was walked: each row's leg was measured from
		// the row walked before it. Sorting by start time instead paired a leg
		// with whichever card happened to start earlier -- two cards at the
		// same minute, or times that had moved -- and a journey measured from
		// Kinkaku-ji was reused as one from Kiyomizu-dera.
		const ordered = [...day].sort((a, b) => a.order_index - b.order_index);
		ordered.forEach((row, i) => {
			const previous = ordered[i - 1];
			if (!previous || row.leg_source !== 'routed' || !row.leg_mode) return;
			const from = {
				lat: previous.exit_lat ?? previous.lat,
				lng: previous.exit_lng ?? previous.lng
			};
			known.set(`${pointKey(from)}>${pointKey({ lat: row.lat, lng: row.lng })}|${row.leg_mode}`, {
				minutes: row.leg_minutes ?? 0,
				km: Number(row.leg_km ?? 0)
			});
		});
	}
	return {
		get(from, to, mode) {
			const cell = known.get(`${pointKey(from)}>${pointKey(to)}|${mode}`);
			return cell ? { ...cell, source: 'routed' as const } : null;
		}
	};
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
