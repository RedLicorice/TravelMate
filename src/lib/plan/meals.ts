/**
 * Meal slots.
 *
 * A restaurant is not a sight: visiting it at 15:40 because that is where the
 * route happened to arrive is wrong in a way no amount of walking-distance
 * optimisation fixes. Meals are scheduled against the clock first and the map
 * second.
 */
export type MealSlot = { name: 'lunch' | 'dinner'; from: number; to: number };

/** Local wall-clock hours. Continental habits; a per-trip override is future work. */
export const SLOTS: MealSlot[] = [
	{ name: 'lunch', from: 12, to: 15 },
	{ name: 'dinner', from: 19, to: 22 }
];

const MEAL_CATEGORIES = new Set([
	'restaurant',
	'fast_food',
	'food_court',
	'cafe',
	'pub',
	'bar',
	'biergarten',
	'bakery',
	'ice_cream'
]);

export const isMeal = (category: string | null | undefined) =>
	MEAL_CATEGORIES.has(category ?? '');

/** At most one lunch and one dinner: nobody eats three sit-down meals a day. */
export const MEALS_PER_DAY = SLOTS.length;

const hourIn = (at: Date, tz: string) =>
	Number(
		new Intl.DateTimeFormat('en-GB', {
			timeZone: tz,
			hour: '2-digit',
			minute: '2-digit',
			hour12: false
		})
			.format(at)
			.split(':')[0]
	) %
		24 +
	Number(
		new Intl.DateTimeFormat('en-GB', {
			timeZone: tz,
			hour: '2-digit',
			minute: '2-digit',
			hour12: false
		})
			.format(at)
			.split(':')[1]
	) /
		60;

/**
 * How badly a meal misses its slot, in hours. Zero when it lands inside one.
 * Measured against whichever slot is nearest, so an early lunch is judged
 * against lunch rather than against last night's dinner.
 */
export function mealMiss(at: Date, tz: string): number {
	const h = hourIn(at, tz);
	return Math.min(...SLOTS.map((s) => (h < s.from ? s.from - h : h > s.to ? h - s.to : 0)));
}

/**
 * If `at` falls before a meal slot begins later the same local day, the instant
 * that slot opens. Null when it is already inside one, or past the last.
 *
 * This is what lets the planner wait rather than eat lunch at nine because the
 * route happened to arrive then.
 *
 * ponytail: adds whole hours to the instant, so a meal slot on the day the
 * clocks change shifts by an hour. Nobody has complained about lunch being at
 * 13:00 twice a year.
 */
export function waitUntilSlot(at: Date, tz: string): Date | null {
	const h = hourIn(at, tz);
	const next = SLOTS.filter((s) => s.from > h).sort((a, b) => a.from - b.from)[0];
	return next ? new Date(at.getTime() + (next.from - h) * 3_600_000) : null;
}

/** The slot a given time falls in, or null between meals. */
export function slotAt(at: Date, tz: string): MealSlot['name'] | null {
	const h = hourIn(at, tz);
	return SLOTS.find((s) => h >= s.from && h <= s.to)?.name ?? null;
}
