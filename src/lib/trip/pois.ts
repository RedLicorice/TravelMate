import { supabase } from '$lib/supabase';
import { pool } from '$lib/pool';
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
	priority: number;
	opening_hours: string | null;
	osm_id: string | null;
	website: string | null;
	phone: string | null;
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
	priority: row.priority ?? 3,
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
			osm_id: poi.osmId,
			website: poi.website,
			phone: poi.phone
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
	patch: { duration_min?: number; notes?: string | null; name?: string; priority?: number }
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

/**
 * Persist a plan's day/order assignment. One upsert per changed row rather
 * than a wholesale delete-and-insert, so a failure halfway leaves a coherent
 * trip instead of an empty one.
 */
export async function saveAssignments(
	rows: { id: string; dayIndex: number | null; orderIndex: number | null }[]
): Promise<void> {
	// In parallel, bounded: a trip with twenty stops was twenty round trips in
	// a row, which is most of what made Replan feel like it had hung.
	await pool(rows, 6, async (r) => {
		const { error } = await supabase
			.from('pois')
			.update({ day_index: r.dayIndex, order_index: r.orderIndex })
			.eq('id', r.id);
		if (error) throw new Error(error.message);
	});
}
