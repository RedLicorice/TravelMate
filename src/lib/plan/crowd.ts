/**
 * Crowd avoidance.
 *
 * Crowding at tourist sites is overwhelmingly predictable from category and
 * clock, and the planner never needs a headcount -- only a relative preference
 * to nudge a stop earlier or later. So this is a lookup table: no key, no
 * billing, no provider that can deprecate it.
 *
 * Shaped as a provider chain so a measured source can go in front of it. The
 * table is the terminal provider and never returns null, which is what makes
 * the fallback real rather than aspirational.
 *
 * ponytail: this chain is SYNCHRONOUS and resolved inside the planner's clock
 * walk, which the design doc says it should not be. A network provider cannot
 * be added without first moving resolution ahead of planning -- resolve every
 * (poi, candidate hour) up front into a plain lookup, pass that into plan(),
 * and keep walkClock reading it synchronously. Going async in place would drag
 * the 2-opt scoring loop async, and that loop runs hundreds of times per
 * replan. Today the only provider is a local table, so nothing is broken; the
 * refactor is the price of the first real provider, not of this one.
 */
export type Busyness = number; // 0 = empty, 1 = packed

export interface CrowdProvider {
	readonly name: string;
	busyness(category: string | null, at: Date, tz: string): Busyness | null;
}

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

const BASELINE = 0.2; // a tourist city is never actually empty

/** The busy windows known for a category, busiest first. Empty when unknown. */
export function busyWindows(category: string | null): { from: number; to: number; level: number }[] {
	return (CURVES[category ?? ''] ?? [])
		.map(([from, to, level]) => ({ from, to, level }))
		.sort((a, b) => b.level - a.level);
}

/** 14 -> '14:00'. Curves are whole hours. */
export const hourLabel = (h: number) => `${String(h).padStart(2, '0')}:00`;

const hourIn = (at: Date, tz: string) =>
	Number(
		new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }).format(at)
	) % 24;

const weekdayIn = (at: Date, tz: string) =>
	new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short' }).format(at);

export const categoryCrowd: CrowdProvider = {
	name: 'category-table',
	busyness(category, at, tz) {
		const hour = hourIn(at, tz);
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
};

/**
 * First non-null answer wins. The table is last and never returns null, so the
 * chain always resolves and callers never handle a missing value.
 */
export function resolveCrowd(
	providers: CrowdProvider[],
	category: string | null,
	at: Date,
	tz: string
): Busyness {
	for (const p of providers) {
		const v = p.busyness(category, at, tz);
		if (v !== null) return v;
	}
	return BASELINE;
}
