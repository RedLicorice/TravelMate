import { ofTrip, perList, type Writer } from '$lib/store/store.svelte';

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
export type PlacementKind = 'stop' | 'hotel' | 'chore' | 'meal';

export type PlacementRow = {
	id: string;
	trip_id: string;
	poi_id: string | null;
	kind: PlacementKind;
	/** What a chore is called. A stop and a hotel are named by what they are. */
	name: string | null;
	/** How long it takes; null leaves it to the trip's own allowance. */
	minutes: number | null;
	/** Which sitting a 'meal' card is. Null for everything else. */
	meal: 'breakfast' | 'lunch' | 'dinner' | null;
	day_index: number;
	/**
	 * When this card happens.
	 *
	 * The card's own clock, and the only thing the day is ordered by. Set by
	 * the traveller when they put the card somewhere, and written by Replan
	 * when it decides a day.
	 */
	at: string;
	/** Replan may not move this one. When it happens is the card's to say. */
	pinned: boolean;
	/** A meal the traveller is not having that day. Only a meal card is skipped; see meals.ts. */
	skipped: boolean;
	created_at: string;
	/** Which edit of this row the server last confirmed. */
	version: number;
};

/** A trip's visits, by day and then by clock. */
const byDayAndClock = perList((list: PlacementRow[]) =>
	[...list].sort((a, b) => a.day_index - b.day_index || a.at.localeCompare(b.at))
);
export const listPlacements = (tripId: string): PlacementRow[] =>
	byDayAndClock(ofTrip<PlacementRow>('placements', tripId));

type Furniture = 'hotel' | 'chore' | 'meal';

/** A whole new visit. Its id is chosen here, so it can be moved before the server has seen it. */
function visit(
	w: Writer,
	tripId: string,
	v: {
		poiId?: string | null;
		kind: PlacementKind;
		name?: string | null;
		minutes?: number | null;
		meal?: PlacementRow['meal'];
		dayIndex: number;
		at: string;
		pinned?: boolean;
		skipped?: boolean;
		id?: string;
	}
): PlacementRow {
	const made: PlacementRow = {
		id: v.id ?? crypto.randomUUID(),
		trip_id: tripId,
		poi_id: v.poiId ?? null,
		kind: v.kind,
		name: v.name ?? null,
		minutes: v.minutes ?? null,
		meal: v.meal ?? null,
		day_index: v.dayIndex,
		at: v.at,
		pinned: v.pinned ?? false,
		skipped: v.skipped ?? false,
		created_at: new Date().toISOString(),
		version: 1
	};
	w.insert('placements', made);
	return made;
}

/** Put a place on a day. Returns the placement, which is what is dragged. */
export const place = (
	w: Writer,
	tripId: string,
	poiId: string,
	dayIndex: number,
	at: string,
	pinned = false,
	id?: string
): PlacementRow => visit(w, tripId, { poiId, kind: 'stop', dayIndex, at, pinned, id });

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
export const placeAnchor = (
	w: Writer,
	tripId: string,
	kind: Furniture,
	dayIndex: number,
	at: string,
	opts: {
		name?: string | null;
		minutes?: number | null;
		meal?: PlacementRow['meal'];
		/** A meal's place, when it is decided. */
		poiId?: string | null;
		skipped?: boolean;
	} = {}
): PlacementRow => visit(w, tripId, { kind, dayIndex, at, ...opts });

/**
 * Several at once: a new trip's furniture, or what Replan decided a day
 * needed.
 */
export const placeMany = (
	w: Writer,
	rows: {
		poiId?: string | null;
		kind: PlacementKind;
		name?: string | null;
		minutes?: number | null;
		meal?: PlacementRow['meal'];
		dayIndex: number;
		at: string;
		pinned?: boolean;
	}[],
	tripId: string
): PlacementRow[] => rows.map((r) => visit(w, tripId, r));

/** How long this one takes, when the traveller says rather than the trip. */
export const setPlacementMinutes = (w: Writer, id: string, minutes: number | null) =>
	w.update('placements', { id }, { minutes });

/** Take one visit off the plan. The place stays on the wishlist. */
export const unplace = (w: Writer, id: string) => w.remove('placements', { id });

export const holdPlacement = (w: Writer, id: string, pinned: boolean) =>
	w.update('placements', { id }, { pinned });

/**
 * How many of a trip's days have been furnished already.
 *
 * A day the app has never drawn gets the usual furniture the first time it is
 * seen -- the hotel at either end, getting out of the door, the bags. After
 * that the day belongs to the traveller: a piece they removed stays removed,
 * and one they added stays added, because nothing comes along afterwards to
 * put the furniture back.
 */
export const setFurnished = (w: Writer, tripId: string, days: number) =>
	w.update('trips', { id: tripId }, { furnished_days: days });

/** Move a card to a moment. The day reorders itself around it. */
export const moveTo = (w: Writer, id: string, at: string, dayIndex?: number) =>
	w.update('placements', { id }, dayIndex === undefined ? { at } : { at, day_index: dayIndex });

/** Halfway between two moments: when a card put between two others happens. */
export const between = (a: string | Date, b: string | Date): string =>
	new Date((new Date(a).getTime() + new Date(b).getTime()) / 2).toISOString();

/**
 * The hotel cards that begin and end a day: its first card when that is a
 * hotel -- the morning, woken up in -- and its last when that is one -- the
 * evening, slept in. Skipped cards count: they keep their clock.
 */
export function nightCards(tripId: string, day: number): { morning?: PlacementRow; evening?: PlacementRow } {
	const cards = listPlacements(tripId).filter((pl) => pl.day_index === day);
	const first = cards[0];
	const last = cards.at(-1);
	return {
		morning: first?.kind === 'hotel' ? first : undefined,
		evening: last?.kind === 'hotel' && last !== first ? last : undefined
	};
}

/**
 * One night at the hotel is the evening card of `day` and the morning card of
 * the day after: sleeping there is one fact. Skipping it -- sleeping elsewhere,
 * or not at all -- marks both; bringing it back unmarks both.
 */
export function skipNight(w: Writer, tripId: string, day: number, skipped: boolean) {
	const evening = nightCards(tripId, day).evening;
	const morning = nightCards(tripId, day + 1).morning;
	for (const pl of [evening, morning]) {
		if (pl && pl.skipped !== skipped) w.update('placements', { id: pl.id }, { skipped });
	}
}

/**
 * The night a hotel card belongs to, as the day whose evening it is: its own
 * day for an evening card, the day before for a morning one. Null for a
 * hotel card in the middle of a day, and for the first day's check-in, which
 * no night comes before.
 */
export function nightOf(tripId: string, pl: PlacementRow): number | null {
	if (pl.kind !== 'hotel') return null;
	const { morning, evening } = nightCards(tripId, pl.day_index);
	if (evening?.id === pl.id) return pl.day_index;
	if (morning?.id === pl.id && pl.day_index > 0) return pl.day_index - 1;
	return null;
}
