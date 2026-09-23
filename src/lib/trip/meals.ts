import { ofTrip, perList, row, type Writer } from '$lib/store/store.svelte';
import type { MealName } from '$lib/plan/meals';

/**
 * What the traveller has said about one meal on one day.
 *
 * A row exists only once they have had a say. Absent means the plan decides,
 * which is the ordinary case and the reason this table stays small.
 */
export type MealSlotRow = {
	id: string;
	trip_id: string;
	day_index: number;
	meal: MealName;
	/** Null with `skipped` false is a container emptied on purpose. */
	poi_id: string | null;
	skipped: boolean;
	created_at: string;
	version: number;
};

/** Keyed `${dayIndex}:${meal}`, which is how the planner asks about one. */
export type MealPlan = Map<string, MealSlotRow>;

export const mealKey = (dayIndex: number, meal: MealName) => `${dayIndex}:${meal}`;

export const toMealPlan = (rows: MealSlotRow[]): MealPlan =>
	new Map(rows.map((r) => [mealKey(r.day_index, r.meal), r]));

const byDay = perList((list: MealSlotRow[]) => [...list].sort((a, b) => a.day_index - b.day_index));
export const loadMeals = (tripId: string): MealSlotRow[] => byDay(ofTrip<MealSlotRow>('trip_meals', tripId));

/**
 * Record a say about one meal. One row per day and meal, because there is
 * one breakfast on 3 October however many times the traveller changes it.
 *
 * Only what was passed is written, so a row that is only being emptied keeps
 * whatever else it said -- sending the whole row instead is how skipping a
 * meal used to clear the place the traveller had chosen for it.
 */
export function saveMeal(
	w: Writer,
	tripId: string,
	slot: { dayIndex: number; meal: MealName; poiId?: string | null; skipped?: boolean }
): void {
	const key = { trip_id: tripId, day_index: slot.dayIndex, meal: slot.meal };
	const said = {
		...(slot.poiId !== undefined ? { poi_id: slot.poiId } : {}),
		...(slot.skipped !== undefined ? { skipped: slot.skipped } : {})
	};
	if (row('trip_meals', key)) {
		w.update('trip_meals', key, said);
		return;
	}
	w.insert('trip_meals', {
		id: crypto.randomUUID(),
		...key,
		poi_id: null,
		skipped: false,
		created_at: new Date().toISOString(),
		version: 1,
		...said
	});
}

/** Hand the meal back to the plan. */
export const resetMeal = (w: Writer, tripId: string, dayIndex: number, meal: MealName) =>
	w.remove('trip_meals', { trip_id: tripId, day_index: dayIndex, meal });
