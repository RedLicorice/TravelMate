import { ofTrip, perList, row, type Writer } from '$lib/store/store.svelte';
import type { Poi } from '$lib/poi';
import type { PlanPoi } from '$lib/plan/planner';
import type { PlacementRow } from '$lib/trip/placements';
import { session } from '$lib/session.svelte';

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
	/** Which edit of this row the server last confirmed. */
	version: number;
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
	at: placement.at,
	pinned: placement.pinned,
	pinnedAt: placement.pinned ? heldAt : null,
	branches: row.any_branch ? (row.branches ?? []) : null,
	exitAt: row.exit_lat !== null && row.exit_lng !== null ? { lat: row.exit_lat, lng: row.exit_lng } : null
});

/** The wishlist, in the order places were added. */
const byAdded = perList((list: PoiRow[]) =>
	[...list].sort((a, b) => a.created_at.localeCompare(b.created_at))
);
export const listPois = (tripId: string): PoiRow[] => byAdded(ofTrip<PoiRow>('pois', tripId));

/**
 * Captured stops land in the wishlist; putting one on a day is a placement.
 *
 * The same OpenStreetMap place twice is refused here, where the traveller
 * is, rather than by the uniqueness index once the edit reaches the server:
 * two taps in quick succession, or the same place reached from both the list
 * and the map.
 */
export function addPoi(w: Writer, tripId: string, poi: Poi): PoiRow {
	if (poi.osmId && listPois(tripId).some((p) => p.osm_id === poi.osmId)) {
		throw new DuplicatePoiError(poi.name);
	}
	const now = new Date().toISOString();
	const made: PoiRow = {
		id: crypto.randomUUID(),
		trip_id: tripId,
		name: poi.name,
		lat: poi.lat,
		lng: poi.lng,
		category: poi.category,
		duration_min: poi.durationMin,
		priority: 3,
		opening_hours: poi.openingHours,
		osm_id: poi.osmId,
		website: poi.website,
		phone: poi.phone,
		notes: null,
		any_branch: !!poi.branches?.length,
		branches: poi.branches ?? [],
		exit_lat: null,
		exit_lng: null,
		added_by: session.user?.id ?? null,
		created_at: now,
		updated_at: now,
		version: 1
	};
	w.insert('pois', made);
	return made;
}

export class DuplicatePoiError extends Error {
	constructor(name: string) {
		super(`${name} is already on this trip.`);
		this.name = 'DuplicatePoiError';
	}
}

export const getPoi = (id: string): PoiRow | null => row<PoiRow>('pois', { id });

export function updatePoi(
	w: Writer,
	id: string,
	patch: {
		duration_min?: number;
		notes?: string | null;
		name?: string;
		priority?: number;
		exit_lat?: number | null;
		exit_lng?: number | null;
	}
): PoiRow {
	// updated_at is what says the plan is behind the wishlist. The server
	// stamps it too; this is the device saying so before it has been told.
	w.update('pois', { id }, { ...patch, updated_at: new Date().toISOString() });
	return getPoi(id)!;
}

/**
 * Take a place off the trip altogether.
 *
 * Its visits go with it, here as on the server, where the foreign key
 * cascades. A meal it was chosen for keeps its card, emptied first so the
 * cascade does not take it: the traveller is still having lunch.
 */
export function removePoi(w: Writer, id: string): void {
	const poi = getPoi(id);
	if (!poi) return;
	for (const pl of ofTrip<PlacementRow>('placements', poi.trip_id)) {
		if (pl.poi_id !== id) continue;
		// A meal it was chosen for is still a meal: the card stays, still to decide.
		if (pl.kind === 'meal') w.update('placements', { id: pl.id }, { poi_id: null });
		else w.remove('placements', { id: pl.id });
	}
	w.remove('pois', { id });
}
