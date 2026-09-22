import { supabase } from '$lib/supabase';
import type { Poi } from '$lib/poi';
import type { PlanPoi } from '$lib/plan/planner';
import type { PlacementRow } from '$lib/trip/placements';

export type PoiRow = {
	id: string;
	trip_id: string;
	name: string;
	lat: number;
	lng: number;
	category: string | null;
	duration_min: number;
	priority: number;
	opening_hours: string | null;
	osm_id: string | null;
	website: string | null;
	phone: string | null;
	notes: string | null;
	/**
	 * Dead. Where a place is on the plan, and whether it is held there, lives
	 * on its placements now (0040); these three are still selected only until
	 * the follow-up migration drops them. Nothing may read them.
	 */
	/** The exact start a pin holds. Null on a pin made before times were held. */
	/** Any branch will do; the planner picks the nearest. */
	any_branch: boolean;
	branches: { lat: number; lng: number }[];
	/** Where this stop lets you out, when that differs from where you got on. */
	exit_lat: number | null;
	exit_lng: number | null;
	/** Who put it on the wishlist. Null once that person has gone. */
	added_by: string | null;
	created_at: string;
	updated_at: string | null;
};

/**
 * One visit to a wishlist row, as the planner wants it told.
 *
 * The place says what it is; the placement says where on the plan it is and
 * whether it is held there. The planner works in visits, so the id it gets is
 * the placement's, and the same place on two days is two of these.
 *
 * `heldAt` is the moment the stop already happens at, taken from the card on
 * the plan -- because that is where a stop's time lives. A pin carries no time
 * of its own: it says Replan may not move this one, and the card says when it
 * is. Passing nothing means the planner decides, which is what it does for
 * anything unpinned and for a stop that has just been dragged somewhere new.
 */
export const toPlanPoi = (
	row: PoiRow,
	placement: PlacementRow,
	heldAt: string | null = null
): PlanPoi => ({
	id: placement.id,
	poiId: row.id,
	name: row.name,
	lat: row.lat,
	lng: row.lng,
	category: row.category,
	durationMin: row.duration_min,
	priority: row.priority ?? 3,
	dayIndex: placement.day_index,
	orderIndex: placement.order_index,
	pinned: placement.pinned,
	pinnedAt: placement.pinned ? heldAt : null,
	branches: row.any_branch ? (row.branches ?? []) : null,
	exitAt: row.exit_lat !== null && row.exit_lng !== null ? { lat: row.exit_lat, lng: row.exit_lng } : null
});

export async function listPois(tripId: string): Promise<PoiRow[]> {
	const { data, error } = await supabase
		.from('pois')
		.select('*')
		.eq('trip_id', tripId)
		.order('created_at', { ascending: true });
	if (error) throw new Error(error.message);
	return data ?? [];
}

/** Captured stops land in the wishlist; putting one on a day is a placement. */
export async function addPoi(tripId: string, poi: Poi): Promise<PoiRow> {
	const { data, error } = await supabase
		.from('pois')
		.insert({
			trip_id: tripId,
			name: poi.name,
			lat: poi.lat,
			lng: poi.lng,
			category: poi.category,
			duration_min: poi.durationMin,
			opening_hours: poi.openingHours,
			osm_id: poi.osmId,
			website: poi.website,
			phone: poi.phone,
			any_branch: !!poi.branches?.length,
			branches: poi.branches ?? []
		})
		.select('*')
		.single();
	// 23505 is the per-trip uniqueness index doing its job -- two taps in quick
	// succession, or the same place reached from both the list and the map.
	if (error) {
		if (error.code === '23505') throw new DuplicatePoiError(poi.name);
		throw new Error(error.message);
	}
	return data;
}

export class DuplicatePoiError extends Error {
	constructor(name: string) {
		super(`${name} is already on this trip.`);
		this.name = 'DuplicatePoiError';
	}
}

export async function getPoi(id: string): Promise<PoiRow | null> {
	const { data, error } = await supabase.from('pois').select('*').eq('id', id).maybeSingle();
	if (error) throw new Error(error.message);
	return data;
}

export async function updatePoi(
	id: string,
	patch: {
		duration_min?: number;
		notes?: string | null;
		name?: string;
		priority?: number;
		exit_lat?: number | null;
		exit_lng?: number | null;
	}
): Promise<PoiRow> {
	const { data, error } = await supabase
		.from('pois')
		.update(patch)
		.eq('id', id)
		.select('*')
		.single();
	if (error) throw new Error(error.message);
	return data;
}

export async function removePoi(id: string): Promise<void> {
	const { error } = await supabase.from('pois').delete().eq('id', id);
	if (error) throw new Error(error.message);
}

