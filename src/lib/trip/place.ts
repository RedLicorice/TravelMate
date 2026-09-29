import type { Writer } from '$lib/store/store.svelte';
import type { PlannedStop } from '$lib/plan/planner';
import { MEAL_MINUTES } from '$lib/plan/meals';
import { between, listPlacements, moveTo, type PlacementRow } from './placements';
import type { PoiRow } from './pois';

/**
 * Where a card is put, and what gives way to it.
 *
 * One answer for every screen that adds a card -- the slot sheet on the day,
 * the search screen reached from it, a place's own page -- and for a drop:
 * the card goes where it was put, and what is below it is pushed down. Each
 * screen used to work the moment out its own way and leave the day to be
 * sorted out later, and a card added from one screen could land before the
 * hotel the day woke up in.
 */

/** Where something is being added: which day, above which card, and -- from an opened gap -- at what time. */
export type Slot = { day: number; before: string | null; at?: string | null };

/**
 * The furniture a day closes on: the hotel it is slept in, checking out,
 * the journey home. Where a card with no named place lands is before these
 * and after everything else the day does.
 */
const closes = (st: PlannedStop) =>
	st.anchorKind === 'hotel' ||
	st.anchorKind === 'terminal' ||
	st.anchorKind === 'service' ||
	(st.anchorKind === 'chore' && st.name.endsWith('Check-Out'));

/**
 * Where a day's closing furniture starts: the index of its first card.
 *
 * Never inside the furniture the day opens on -- waking at the hotel,
 * getting ready, the journey in -- so a day with nothing on it yet still
 * puts a new card after its morning and before its night.
 */
export function closingAt(cards: PlannedStop[]): number {
	let head = 0;
	while (head < cards.length && cards[head].anchor && cards[head].anchorKind !== 'meal') head++;
	let index = cards.length;
	while (index > head && closes(cards[index - 1])) index--;
	return index;
}

/**
 * The minute between two cards, or beyond the one card there is.
 *
 * Halfway into the space beside it: the gap where there is one, and
 * otherwise between the two clocks themselves, which always leaves the
 * card between the pair it was put between.
 */
export function spaceAt(cards: PlannedStop[], index: number, dayStart: Date | null | undefined): string {
	const prev = cards[index - 1];
	const next = cards[index];
	if (prev && next) {
		const from = prev.depart < next.arrive ? prev.depart : prev.arrive;
		return between(from, next.arrive);
	}
	// Beyond the one card there is, wherever that falls: the day's window is
	// the automatic plan's to respect, and a card put by hand goes where
	// the traveller put it.
	if (prev) return new Date(prev.depart.getTime() + 15 * 60_000).toISOString();
	if (next) return new Date(next.arrive.getTime() - 60 * 60_000).toISOString();
	return (dayStart ?? new Date()).toISOString();
}

/**
 * When a card added into a slot happens.
 *
 * Tapped in an opened gap, the gap is drawn to scale and the tap said a
 * time: that is the answer. Tapped on the slot above a card, it happens in
 * the space before that card. With nothing named, it happens after the
 * last thing the day does and before the hotel it is slept in. `cards` are
 * the day's, as the plan draws them; `before` names one by its visit or by
 * its place.
 */
export function slotMoment(target: Slot, cards: PlannedStop[], dayStart: Date | null | undefined): string {
	if (target.at) return target.at;
	const named = target.before
		? cards.findIndex((st) => st.poiId === target.before || st.placementId === target.before)
		: -1;
	return spaceAt(cards, named < 0 ? closingAt(cards) : named, dayStart);
}

/** What a card's length is read from: the trip's allowances, the place it is of, the traveller's own morning. */
export type Lengths = {
	bagDropMin: number;
	poi: (id: string) => PoiRow | null | undefined;
	prepMin: number;
};

/**
 * How long a card takes, in minutes: as long as its place, or as long as
 * it was told, or the trip's own allowance for that kind of furniture. A
 * skipped card takes no time at all.
 */
export function minutesOf(pl: PlacementRow, of: Lengths): number {
	if (pl.skipped) return 0;
	const poi = pl.poi_id ? of.poi(pl.poi_id) : null;
	if (pl.kind === 'stop') return poi?.duration_min ?? 0;
	if (pl.minutes !== null) return pl.minutes;
	if (poi) return poi.duration_min;
	if (pl.kind === 'meal') return pl.meal ? MEAL_MINUTES[pl.meal] : 0;
	if (pl.kind === 'chore') return pl.name === 'Getting ready' ? of.prepMin : of.bagDropMin;
	return 0;
}

/**
 * Make room below a card that has just been put somewhere -- dropped,
 * added from a sheet or a screen, a meal said or moved: every card, however
 * it got there, the same way.
 *
 * The card starts when it was put and ends its own length later. What is
 * below it on the day and now starts before it ends is pushed down to
 * start when it ends, and so on down the day, each by only as much as it
 * has to: the traveller put this card here, and the day gives way. A pin
 * does not: it and everything after it stay, and the card that runs into
 * it is the one the walk warns.
 */
export function pushDown(w: Writer, tripId: string, id: string, of: Lengths) {
	// Read as this edit has left it -- the card is new, or has just moved --
	// and all of it before the first push: each push changes what the trip
	// reads as.
	const placements = listPlacements(tripId);
	const length = (pl: PlacementRow) => minutesOf(pl, of) * 60_000;
	const card = placements.find((pl) => pl.id === id);
	if (!card) return;
	const start = Date.parse(card.at);
	let end = start + length(card);
	// Below it is what starts later, or starts at the same minute and ends
	// later: a card that starts then and is already over -- the hotel the
	// day wakes up in -- comes before it, and is not in its way. And a card
	// that started earlier and is still going at this minute: the card was
	// put before it, inside its time, so it goes after.
	const below = placements
		.filter(
			(pl) =>
				pl.day_index === card.day_index &&
				pl.id !== id &&
				(Date.parse(pl.at) > start ||
					(Date.parse(pl.at) === start && Date.parse(pl.at) + length(pl) > end) ||
					(!pl.pinned && Date.parse(pl.at) < start && Date.parse(pl.at) + length(pl) > start))
		)
		.sort((a, b) => a.at.localeCompare(b.at) || length(a) - length(b))
		.map((pl) => ({ id: pl.id, at: Date.parse(pl.at), length: length(pl), pinned: pl.pinned }));
	for (const pl of below) {
		if (pl.pinned) break;
		const start = Math.max(pl.at, end);
		if (start !== pl.at) moveTo(w, pl.id, new Date(start).toISOString());
		end = start + pl.length;
	}
}
