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
/**
 * What a placement is of.
 *
 * 'stop' points at a place on the wishlist. The other two are the furniture of
 * a day -- the hotel it starts and ends at, the half hour spent getting out of
 * the door, the bags -- which used to be drawn by the app and could not be
 * moved, removed or added to. They are placed like everything else now.
 */
export type PlacementKind = 'stop' | 'hotel' | 'chore';

export type PlacementRow = {
	id: string;
	trip_id: string;
	poi_id: string | null;
	kind: PlacementKind;
	/** What a chore is called. A stop and a hotel are named by what they are. */
	name: string | null;
	/** How long it takes; null leaves it to the trip's own allowance. */
	minutes: number | null;
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
		.insert({
			trip_id: tripId,
			poi_id: poiId,
			kind: 'stop',
			day_index: dayIndex,
			order_index: orderIndex,
			pinned
		})
		.select('*')
		.single();
	if (error) throw new Error(error.message);
	return data as PlacementRow;
}

/**
 * Put a piece of the day's own furniture on a day: back to the hotel in the
 * afternoon, a nap, an errand, the bags.
 *
 * Not pinned. Where it goes is already fixed -- the planner holds an anchor
 * in the position it was placed in and arranges the sights around it -- and a
 * pin would fix WHEN as well, at whatever the clock said the last time the
 * day was walked. That is how a check-in card ended up frozen at ten past
 * midnight with two hours of nothing in front of it: the time was wrong once,
 * and the pin kept it wrong.
 */
export async function placeAnchor(
	tripId: string,
	kind: 'hotel' | 'chore',
	dayIndex: number,
	orderIndex: number,
	opts: { name?: string | null; minutes?: number | null } = {}
): Promise<PlacementRow> {
	const { data, error } = await supabase
		.from('placements')
		.insert({
			trip_id: tripId,
			poi_id: null,
			kind,
			name: opts.name ?? null,
			minutes: opts.minutes ?? null,
			day_index: dayIndex,
			order_index: orderIndex,
			pinned: false
		})
		.select('*')
		.single();
	if (error) throw new Error(error.message);
	return data as PlacementRow;
}

/** How long this one takes, when the traveller says rather than the trip. */
export async function setPlacementMinutes(id: string, minutes: number | null): Promise<void> {
	const { error } = await supabase.from('placements').update({ minutes }).eq('id', id);
	if (error) throw new Error(error.message);
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
	rows: {
		id: string;
		poiId: string | null;
		kind?: PlacementKind;
		name?: string | null;
		minutes?: number | null;
		dayIndex: number;
		orderIndex: number;
	}[]
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
			kind: r.kind ?? 'stop',
			name: r.name ?? null,
			minutes: r.minutes ?? null,
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

/**
 * How many of a trip's days have been furnished already.
 *
 * A day the app has never drawn gets the usual furniture the first time it is
 * seen -- the hotel at either end, getting out of the door, the bags. After
 * that the day belongs to the traveller: a piece they removed stays removed,
 * and one they added stays added, because nothing comes along afterwards to
 * put the furniture back.
 */
export async function setFurnished(tripId: string, days: number): Promise<void> {
	const { error } = await supabase
		.from('trips')
		.update({ furnished_days: days })
		.eq('id', tripId);
	if (error) throw new Error(error.message);
}

/**
 * Several at once.
 *
 * Furnishing a trip is one insert, not one per card: a new trip used to make
 * four round trips per day before it would draw anything.
 */
export async function placeMany(
	rows: {
		poiId?: string | null;
		kind: PlacementKind;
		name?: string | null;
		minutes?: number | null;
		dayIndex: number;
		orderIndex: number;
		pinned?: boolean;
	}[],
	tripId: string
): Promise<PlacementRow[]> {
	if (!rows.length) return [];
	const { data, error } = await supabase
		.from('placements')
		.insert(
			rows.map((r) => ({
				trip_id: tripId,
				poi_id: r.poiId ?? null,
				kind: r.kind,
				name: r.name ?? null,
				minutes: r.minutes ?? null,
				day_index: r.dayIndex,
				order_index: r.orderIndex,
				pinned: r.pinned ?? false
			}))
		)
		.select('*');
	if (error) throw new Error(error.message);
	return (data ?? []) as PlacementRow[];
}
