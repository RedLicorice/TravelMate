import { supabase } from '$lib/supabase';
import type { MealName } from '$lib/plan/meals';

/**
 * What the traveller has said about one meal on one day.
 *
 * A row exists only once they have had a say. Absent means the plan decides,
 * which is the ordinary case and the reason this table stays small.
 */
export type MealSlotRow = {
	day_index: number;
	meal: MealName;
	/** Null with `skipped` false is a container emptied on purpose. */
	poi_id: string | null;
	skipped: boolean;
};

/** Keyed `${dayIndex}:${meal}`, which is how the planner asks about one. */
export type MealPlan = Map<string, MealSlotRow>;

export const mealKey = (dayIndex: number, meal: MealName) => `${dayIndex}:${meal}`;

export const toMealPlan = (rows: MealSlotRow[]): MealPlan =>
	new Map(rows.map((r) => [mealKey(r.day_index, r.meal), r]));

export async function loadMeals(tripId: string): Promise<MealSlotRow[]> {
	const { data, error } = await supabase
		.from('trip_meals')
		.select('day_index,meal,poi_id,skipped')
		.eq('trip_id', tripId)
		.order('day_index', { ascending: true });
	if (error) throw new Error(error.message);
	return (data ?? []) as MealSlotRow[];
}

/**
 * Record a say about one meal. Upserted on the day and meal, because there is
 * one breakfast on 3 October however many times the traveller changes it.
 *
 * Only what was passed is written. An upsert names the columns it was given,
 * so a row that is only being emptied keeps whatever else it said -- sending
 * the whole row instead is how skipping a meal used to clear the place the
 * traveller had chosen for it.
 */
export async function saveMeal(
	tripId: string,
	slot: { dayIndex: number; meal: MealName; poiId?: string | null; skipped?: boolean }
): Promise<void> {
	const { error } = await supabase.from('trip_meals').upsert(
		{
			trip_id: tripId,
			day_index: slot.dayIndex,
			meal: slot.meal,
			...(slot.poiId !== undefined ? { poi_id: slot.poiId } : {}),
			...(slot.skipped !== undefined ? { skipped: slot.skipped } : {})
		},
		{ onConflict: 'trip_id,day_index,meal' }
	);
	if (error) throw new Error(error.message);
}

/** Hand the meal back to the plan. */
export async function resetMeal(
	tripId: string,
	dayIndex: number,
	meal: MealName
): Promise<void> {
	const { error } = await supabase
		.from('trip_meals')
		.delete()
		.eq('trip_id', tripId)
		.eq('day_index', dayIndex)
		.eq('meal', meal);
	if (error) throw new Error(error.message);
}
