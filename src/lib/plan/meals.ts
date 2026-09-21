/**
 * Meal slots.
 *
 * A restaurant is not a sight: visiting it at 15:40 because that is where the
 * route happened to arrive is wrong in a way no amount of walking-distance
 * optimisation fixes. Meals are scheduled against the clock first and the map
 * second.
 */
export type MealName = 'breakfast' | 'lunch' | 'dinner';
export type MealSlot = { name: MealName; from: number; to: number };

/** Local wall-clock 'HH:MM' pairs, as stored per person. */
export type MealWindows = Record<MealName, { from: string; to: string }>;

/** Continental defaults. Every traveller can move them in their profile. */
export const DEFAULT_WINDOWS: MealWindows = {
	breakfast: { from: '07:00', to: '10:00' },
	lunch: { from: '12:00', to: '15:00' },
	dinner: { from: '19:00', to: '22:00' }
};

export const MEAL_NAMES: MealName[] = ['breakfast', 'lunch', 'dinner'];

/** 'HH:MM' to decimal hours. '12:30' -> 12.5 */
export function toHours(hhmm: string): number {
	const [h, m] = hhmm.split(':').map(Number);
	return (h % 24) + (m || 0) / 60;
}

export const toHHMM = (hours: number) => {
	const clamped = Math.max(0, Math.min(23.983, hours));
	const h = Math.floor(clamped);
	const m = Math.round((clamped - h) * 60);
	return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};

export function slotsFrom(windows: MealWindows): MealSlot[] {
	return MEAL_NAMES.map((name) => ({
		name,
		from: toHours(windows[name].from),
		to: toHours(windows[name].to)
	}));
}

/** The shortest window that suits everyone. */
export type Tightest = { windows: MealWindows; conflicts: MealName[] };

/**
 * Intersect everyone's meal windows.
 *
 * With collaborators the plan has to suit all of them, so the window is the
 * overlap: the latest start and the earliest end. Someone who eats dinner from
 * 19:00 and someone who eats until 20:00 give 19:00-20:00, not an average --
 * an average would produce a time that suits neither.
 *
 * When there is no overlap at all, there is no honest answer. Rather than
 * silently inventing one, the latest start wins with a 30-minute window
 * hung off it, and the meal is reported as a conflict so the UI can say so.
 */
export function tightest(all: MealWindows[]): Tightest {
	if (all.length === 0) return { windows: DEFAULT_WINDOWS, conflicts: [] };

	const conflicts: MealName[] = [];
	const windows = {} as MealWindows;

	for (const name of MEAL_NAMES) {
		// A profile written before this meal existed simply has no opinion on
		// it; falling back keeps one old row from dragging the window to NaN.
		const stated = all.map((w) => w[name] ?? DEFAULT_WINDOWS[name]);
		const from = Math.max(...stated.map((w) => toHours(w.from)));
		const to = Math.min(...stated.map((w) => toHours(w.to)));

		if (to - from < 0.5) {
			conflicts.push(name);
			windows[name] = { from: toHHMM(from), to: toHHMM(from + 0.5) };
		} else {
			windows[name] = { from: toHHMM(from), to: toHHMM(to) };
		}
	}
	return { windows, conflicts };
}

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

export const isMeal = (category: string | null | undefined) => MEAL_CATEGORIES.has(category ?? '');

/** One sitting per named meal. Two dinners in a day is not a plan. */
export const MEALS_PER_DAY = MEAL_NAMES.length;

/**
 * The earliest a traveller can be out of the door: awake, plus however long
 * they take to get going.
 */
export function readyAt(wakeAt: string, prepMin: number): string {
	return toHHMM(toHours(wakeAt) + Math.max(0, prepMin) / 60);
}

/**
 * When the whole party is ready. The latest of them, because a plan that
 * starts before someone is dressed is a plan they miss the start of.
 */
export function latestReady(people: { wakeAt: string; prepMin: number }[]): string | null {
	if (!people.length) return null;
	return people
		.map((p) => readyAt(p.wakeAt, p.prepMin))
		.reduce((latest, at) => (toHours(at) > toHours(latest) ? at : latest));
}

/**
 * The waking and preparing of whoever is ready last -- the same person
 * `latestReady` picks, but their own hours rather than the resulting time, so
 * the plan can show the morning as a card that says when it runs.
 */
export function latestPrep<T extends { wakeAt: string; prepMin: number }>(
	people: T[]
): { wakeAt: string; prepMin: number } | null {
	if (!people.length) return null;
	const last = people.reduce((a, b) =>
		toHours(readyAt(b.wakeAt, b.prepMin)) > toHours(readyAt(a.wakeAt, a.prepMin)) ? b : a
	);
	return { wakeAt: last.wakeAt, prepMin: last.prepMin };
}

/** The later of the trip's own day start and when everyone is ready. */
export function effectiveDayStart(dayStart: string, ready: string | null): string {
	if (!ready) return dayStart;
	return toHours(ready) > toHours(dayStart) ? ready : dayStart;
}

/** Local wall-clock hour, with minutes as a fraction. */
function hourIn(at: Date, tz: string): number {
	const [h, m] = new Intl.DateTimeFormat('en-GB', {
		timeZone: tz,
		hour: '2-digit',
		minute: '2-digit',
		hour12: false
	})
		.format(at)
		.split(':')
		.map(Number);
	return (h % 24) + m / 60;
}

/**
 * How badly a meal misses its slot, in hours. Zero inside one. Measured
 * against whichever slot is nearest, so an early lunch is judged against lunch
 * rather than against last night's dinner.
 */
export function mealMiss(at: Date, tz: string, slots: MealSlot[]): number {
	const h = hourIn(at, tz);
	if (!slots.length) return 0;
	return Math.min(...slots.map((s) => (h < s.from ? s.from - h : h > s.to ? h - s.to : 0)));
}

/**
 * If `at` falls before a slot that opens later the same local day, the instant
 * it opens. Null when already inside one, or past the last.
 *
 * This is what lets the planner wait rather than eat lunch at nine because the
 * route happened to arrive then.
 *
 * ponytail: adds whole hours to the instant, so a slot on the day the clocks
 * change shifts by an hour. Nobody has complained about lunch twice a year.
 */
export function waitUntilSlot(at: Date, tz: string, slots: MealSlot[]): Date | null {
	const h = hourIn(at, tz);
	const next = slots.filter((s) => s.from > h).sort((a, b) => a.from - b.from)[0];
	return next ? new Date(at.getTime() + (next.from - h) * 3_600_000) : null;
}

/** The slot a given time falls in, or null between meals. */
export function slotAt(at: Date, tz: string, slots: MealSlot[]): MealName | null {
	const h = hourIn(at, tz);
	return slots.find((s) => h >= s.from && h <= s.to)?.name ?? null;
}
