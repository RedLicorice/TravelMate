import type { Writer } from '$lib/store/store.svelte';
import type { MealName } from '$lib/plan/meals';
import { listPlacements, placeAnchor, type PlacementRow } from './placements';

/**
 * A meal is one card: a placement of kind 'meal', one per sitting per day.
 *
 * The card says everything about the sitting. It holds the place it is at, or
 * nothing -- still to decide, drawn as the container the traveller taps to
 * choose -- or it is skipped: no breakfast that day, on purpose. A skipped
 * card takes no time and is not drawn, and because the card is there Replan
 * does not invent that meal again.
 */

/** The card for one sitting on one day, when the day has one. */
export const mealCard = (tripId: string, day: number, meal: MealName): PlacementRow | null =>
	listPlacements(tripId).find((pl) => pl.kind === 'meal' && pl.day_index === day && pl.meal === meal) ??
	null;

/** Have this sitting at this place. A day without the card gets one, at `at`. */
export function chooseMeal(w: Writer, tripId: string, day: number, meal: MealName, poiId: string, at: string) {
	const card = mealCard(tripId, day, meal);
	if (card) w.update('placements', { id: card.id }, { poi_id: poiId, skipped: false });
	else placeAnchor(w, tripId, 'meal', day, at, { meal, poiId });
}

/** No such meal that day. A day without the card gets a skipped one, so Replan leaves it alone. */
export function skipMeal(w: Writer, tripId: string, day: number, meal: MealName, at: string) {
	const card = mealCard(tripId, day, meal);
	if (card) w.update('placements', { id: card.id }, { skipped: true, poi_id: null });
	else placeAnchor(w, tripId, 'meal', day, at, { meal, skipped: true });
}

/** The sitting on the day at `at`: brought back if it was skipped, made if it was never there. */
export function addMeal(w: Writer, tripId: string, day: number, meal: MealName, at: string) {
	const card = mealCard(tripId, day, meal);
	if (card) w.update('placements', { id: card.id }, { skipped: false, at });
	else placeAnchor(w, tripId, 'meal', day, at, { meal });
}

/** Still to decide: the card keeps its time and lets go of its place. */
export function emptyMeal(w: Writer, tripId: string, day: number, meal: MealName) {
	const card = mealCard(tripId, day, meal);
	if (card) w.update('placements', { id: card.id }, { poi_id: null, skipped: false });
}
