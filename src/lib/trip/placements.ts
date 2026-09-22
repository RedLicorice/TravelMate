import { supabase } from '$lib/supabase';

/**
 * A place on a day, in a position: what the traveller has actually decided.
 *
 * Separate from the wishlist row it points at, because those are two
 * different facts. A poi is a place they are interested in, once. A placement
 * is a visit to it, and there can be as many as they like -- the same cafe on
 * Tuesday and Thursday, every branch of the same chain, the park they walk
 * through each morning. Taking one off the plan says nothing about whether
 * the place is still wanted.
 */
export type PlacementRow = {
	id: string;
	trip_id: string;
	poi_id: string;
	day_index: number;
	order_index: number;
	/** Replan may not move this one. When it happens is the card's to say. */
	pinned: boolean;
	created_at: string;
};

export async function listPlacements(tripId: string): Promise<PlacementRow[]> {
	const { data, error } = await supabase
		.from('placements')
		.select('*')
		.eq('trip_id', tripId)
		.order('day_index', { ascending: true })
		.order('order_index', { ascending: true });
	if (error) throw new Error(error.message);
	return (data ?? []) as PlacementRow[];
}

/** Put a place on a day. Returns the placement, which is what is dragged. */
export async function place(
	tripId: string,
	poiId: string,
	dayIndex: number,
	orderIndex: number,
	pinned = false
): Promise<PlacementRow> {
	const { data, error } = await supabase
		.from('placements')
		.insert({ trip_id: tripId, poi_id: poiId, day_index: dayIndex, order_index: orderIndex, pinned })
		.select('*')
		.single();
	if (error) throw new Error(error.message);
	return data as PlacementRow;
}

/** Take one visit off the plan. The place stays on the wishlist. */
export async function unplace(id: string): Promise<void> {
	const { error } = await supabase.from('placements').delete().eq('id', id);
	if (error) throw new Error(error.message);
}

/**
 * Write a whole day's worth of positions at once.
 *
 * One upsert rather than a write per row: a drag renumbers everything below
 * it, and sending those one at a time leaves the plan half-moved if the
 * connection drops in the middle.
 */
export async function savePlacements(
	tripId: string,
	rows: { id: string; poiId: string; dayIndex: number; orderIndex: number }[]
): Promise<void> {
	if (!rows.length) return;
	// The whole row, not just what changed: an upsert is an insert that gives
	// way, and the insert it starts as has to satisfy the columns that cannot
	// be null.
	const { error } = await supabase.from('placements').upsert(
		rows.map((r) => ({
			id: r.id,
			trip_id: tripId,
			poi_id: r.poiId,
			day_index: r.dayIndex,
			order_index: r.orderIndex
		})),
		{ onConflict: 'id' }
	);
	if (error) throw new Error(error.message);
}

export async function holdPlacement(id: string, pinned: boolean): Promise<void> {
	const { error } = await supabase.from('placements').update({ pinned }).eq('id', id);
	if (error) throw new Error(error.message);
}
