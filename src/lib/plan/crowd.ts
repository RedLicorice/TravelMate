import { formatter } from '$lib/clock';
/**
 * Crowd avoidance.
 *
 * Crowding at tourist sites is overwhelmingly predictable from category and
 * clock, and the planner never needs a headcount -- only a relative preference
 * to nudge a stop earlier or later.
 *
 * Resolution happens BEFORE planning, never inside it. The planner is pure and
 * synchronous because it re-runs on every drag and hundreds of times inside
 * 2-opt; making the lookup async in place would drag that whole loop async.
 * So the chain resolves every venue-hour up front into a plain table, and the
 * planner reads that table synchronously.
 */
import { zonedInstant } from '$lib/trip/days';

export type Busyness = number; // 0 = empty, 1 = packed

export type CrowdKey = string;
export const crowdKey = (poiId: string, date: string, hour: number): CrowdKey =>
	`${poiId}|${date}|${hour}`;

export type CrowdRequest = {
	poiId: string;
	category: string | null;
	/** YYYY-MM-DD in the trip's zone. */
	date: string;
	/** Local hour, 0-23. */
	hour: number;
	/** The instant that local hour falls on. */
	at: Date;
};

/**
 * A source of busyness. Batch by design: a network provider should answer many
 * venue-hours in one request, not one at a time.
 *
 * Keys absent from the returned map mean "no opinion", and fall through to the
 * next provider in the chain.
 */
export interface CrowdProvider {
	readonly name: string;
	lookup(requests: CrowdRequest[], tz: string): Promise<Map<CrowdKey, Busyness>>;
}

/** What the planner consumes: a plain synchronous lookup. */
export type CrowdCurves = {
	at(poiId: string, when: Date, tz: string): Busyness;
};

/** Busy windows as [startHour, endHour, busyness] in local time. */
const CURVES: Record<string, [number, number, number][]> = {
	museum: [
		[10, 11, 0.6],
		[11, 15, 0.9],
		[15, 17, 0.5]
	],
	gallery: [
		[11, 15, 0.9],
		[15, 17, 0.5]
	],
	attraction: [
		[11, 16, 0.8],
		[16, 19, 0.6]
	],
	viewpoint: [
		[11, 17, 0.4],
		[17, 20, 0.95]
	],
	restaurant: [
		[13, 14, 0.95],
		[20, 22, 0.95]
	],
	cafe: [[8, 10, 0.7]],
	marketplace: [[9, 13, 0.8]],
	place_of_worship: [[10, 12, 0.6]],
	park: [[12, 16, 0.4]],
	zoo: [[11, 15, 0.8]]
};

export const BASELINE = 0.2; // a tourist city is never actually empty

/** The busy windows known for a category, busiest first. Empty when unknown. */
export function busyWindows(category: string | null): { from: number; to: number; level: number }[] {
	return (CURVES[category ?? ''] ?? [])
		.map(([from, to, level]) => ({ from, to, level }))
		.sort((a, b) => b.level - a.level);
}

/** 14 -> '14:00'. Curves are whole hours. */
export const hourLabel = (h: number) => `${String(h).padStart(2, '0')}:00`;

const localParts = (at: Date, tz: string) => {
	const f = formatter('en-CA', {
		timeZone: tz,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		hour12: false
	}).formatToParts(at);
	const g = (t: string) => f.find((p) => p.type === t)!.value;
	return { date: `${g('year')}-${g('month')}-${g('day')}`, hour: Number(g('hour')) % 24 };
};

const weekdayIn = (at: Date, tz: string) =>
	formatter('en-GB', { timeZone: tz, weekday: 'short' }).format(at);

/** The table's own answer for one venue-hour. Local, instant, never null. */
export function categoryBusyness(category: string | null, at: Date, tz: string): Busyness {
	const { hour } = localParts(at, tz);
	let busy = BASELINE;
	for (const [from, to, level] of CURVES[category ?? ''] ?? []) {
		if (hour >= from && hour < to) busy = Math.max(busy, level);
	}
	// Markets and churches are a different animal at the weekend.
	const day = weekdayIn(at, tz);
	if (category === 'marketplace' && day === 'Sat') busy = Math.min(1, busy + 0.15);
	if (category === 'place_of_worship' && day === 'Sun') busy = Math.min(1, busy + 0.3);
	return busy;
}

/**
 * The terminal provider. Answers every request, so the chain always resolves
 * and callers never handle a missing value. This is what makes the fallback
 * real rather than aspirational.
 */
export const categoryCrowd: CrowdProvider = {
	name: 'category-table',
	async lookup(requests, tz) {
		const out = new Map<CrowdKey, Busyness>();
		for (const r of requests) {
			out.set(crowdKey(r.poiId, r.date, r.hour), categoryBusyness(r.category, r.at, tz));
		}
		return out;
	}
};

const fromTable = (table: Map<CrowdKey, Busyness>): CrowdCurves => ({
	at(poiId, when, tz) {
		const { date, hour } = localParts(when, tz);
		return table.get(crowdKey(poiId, date, hour)) ?? BASELINE;
	}
});

type PoiLike = { id: string; category: string | null };
type DayLike = { date: string };

/** Every venue-hour the planner could possibly ask about. */
function requestsFor(pois: PoiLike[], days: DayLike[], tz: string): CrowdRequest[] {
	const out: CrowdRequest[] = [];
	for (const day of days) {
		for (let hour = 0; hour < 24; hour++) {
			// The instant at which this LOCAL hour happens. Building it as UTC
			// instead keys every cell by one hour and fills it with another:
			// in Europe/Rome the table would be two hours out of step.
			const at = zonedInstant(day.date, `${String(hour).padStart(2, '0')}:30`, tz);
			for (const p of pois) {
				out.push({ poiId: p.id, category: p.category, date: day.date, hour, at });
			}
		}
	}
	return out;
}

/**
 * Table-only curves, resolved synchronously. The default, and what the tests
 * use: no network, no await, identical answers to the chain when the table is
 * the only provider.
 */
export function categoryCurves(pois: PoiLike[], days: DayLike[], tz: string): CrowdCurves {
	const table = new Map<CrowdKey, Busyness>();
	for (const r of requestsFor(pois, days, tz)) {
		table.set(crowdKey(r.poiId, r.date, r.hour), categoryBusyness(r.category, r.at, tz));
	}
	return fromTable(table);
}

/**
 * Resolve the whole chain ahead of planning.
 *
 * Providers are asked in order and only for what is still unanswered, so a
 * paid source is never billed for venue-hours an earlier provider already
 * covered. A provider that throws is skipped rather than failing the plan:
 * degraded busyness is worth far less than a trip that will not render.
 */
export async function resolveCurves(
	pois: PoiLike[],
	days: DayLike[],
	tz: string,
	providers: CrowdProvider[] = [categoryCrowd]
): Promise<CrowdCurves> {
	const pending = requestsFor(pois, days, tz);
	const table = new Map<CrowdKey, Busyness>();

	for (const provider of providers) {
		const outstanding = pending.filter((r) => !table.has(crowdKey(r.poiId, r.date, r.hour)));
		if (!outstanding.length) break;
		try {
			const answered = await provider.lookup(outstanding, tz);
			for (const [key, value] of answered) {
				if (!table.has(key)) table.set(key, value);
			}
		} catch {
			// A provider being down is not a reason for the trip to be.
			continue;
		}
	}
	return fromTable(table);
}
