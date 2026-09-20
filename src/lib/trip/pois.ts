import { supabase } from '$lib/supabase';
import type { Poi } from '$lib/poi';
import type { PlanPoi } from '$lib/plan/planner';

export type PoiRow = {
	id: string;
	trip_id: string;
	name: string;
	lat: number;
	lng: number;
	category: string | null;
	duration_min: number;
	opening_hours: string | null;
	osm_id: string | null;
	notes: string | null;
	day_index: number | null;
	order_index: number | null;
	created_at: string;
};

export const toPlanPoi = (row: PoiRow): PlanPoi => ({
	id: row.id,
	name: row.name,
	lat: row.lat,
	lng: row.lng,
	category: row.category,
	durationMin: row.duration_min,
	dayIndex: row.day_index,
	orderIndex: row.order_index
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

/** Captured stops land in the wishlist: day_index stays null until planning. */
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
			osm_id: poi.osmId
		})
		.select('*')
		.single();
	if (error) throw new Error(error.message);
	return data;
}

export async function removePoi(id: string): Promise<void> {
	const { error } = await supabase.from('pois').delete().eq('id', id);
	if (error) throw new Error(error.message);
}

/**
 * Persist a plan's day/order assignment. One upsert per changed row rather
 * than a wholesale delete-and-insert, so a failure halfway leaves a coherent
 * trip instead of an empty one.
 */
export async function saveAssignments(
	rows: { id: string; dayIndex: number | null; orderIndex: number | null }[]
): Promise<void> {
	for (const r of rows) {
		const { error } = await supabase
			.from('pois')
			.update({ day_index: r.dayIndex, order_index: r.orderIndex })
			.eq('id', r.id);
		if (error) throw new Error(error.message);
	}
}
