import { zonedInstant, type Day, type LatLng } from '$lib/trip/days';
import { haversineKm } from './geo';
import { nearestBranch } from '$lib/poi/branches';
import { mealKey, type MealPlan, type MealSlotRow } from '$lib/trip/meals';
import { leg, type Leg, type Mode } from './modes';
import { noTravel, type TravelTable } from './travel';
import { categoryCurves, type CrowdCurves } from './crowd';
import {
	DEFAULT_WINDOWS,
	isMeal,
	mealFit,
	MEAL_LABEL,
	MEAL_NAMES,
	MEAL_MINUTES,
	MEALS_PER_DAY,
	mealMiss,
	slotAt,
	slotsFrom,
	toHHMM,
	waitUntilSlot,
	type MealSlot,
	type MealWindows
} from './meals';

export type PlanPoi = {
	/**
	 * The placement: this visit, on this day, in this position. Two visits to
	 * the same cafe are two of these, and everything that orders, pins, drags
	 * or drops a stop works in these -- because "the cafe" cannot say which of
	 * Tuesday and Thursday is being moved.
	 */
	id: string;
	/**
	 * The place itself, on the wishlist. Shared by every visit to it. Null for
	 * an anchor, which is of no place: the hotel is the trip's, not a wish.
	 */
	poiId: string | null;
	/**
	 * What this placement is of. Absent means a stop. A 'hotel' or a 'chore'
	 * is an anchor -- the hotel the day starts from, getting ready, the bags,
	 * a return in the afternoon -- placed by the traveller and walked where
	 * they put it. It has the hotel's coordinates, a name and a length, and no
	 * wishlist row.
	 */
	kind?: 'stop' | 'hotel' | 'chore';
	name: string;
	lat: number;
	lng: number;
	category: string | null;
	durationMin: number;
	/** 1-5, how much the traveller wants this. 3 when unsaid. */
	priority: number;
	dayIndex: number | null;
	orderIndex: number | null;
	/**
	 * Held where the traveller put it. Regenerate reshuffles everything around
	 * it rather than moving it.
	 */
	pinned?: boolean;
	/**
	 * The exact moment a pin holds, as an ISO instant. A pin without one holds
	 * only its day and its place in the order, which is what every pin made
	 * before times were held does.
	 */
	pinnedAt?: string | null;
	/**
	 * Where this stop lets you out, when that is not where you got on. A cable
	 * car, a ferry, a funicular. Null is the ordinary case, and is also what a
	 * return trip amounts to -- you end up back where you started.
	 */
	exitAt?: LatLng | null;
	/**
	 * Other shops of the same name. A chain is not a point: whichever branch is
	 * nearest to where the day already has the traveller is the one they go to.
	 */
	branches?: LatLng[] | null;
};

export type Warning = { kind: 'crowded' | 'overflow' | 'off-hours'; message: string };

/** Why a stop is not on the plan. Surfaced when the traveller taps it. */
export type UnplacedReason =
	| 'not-planned-yet'
	| 'day-full'
	| 'no-usable-days'
	| 'hotel-unknown'
	| 'no-mealtime';

export type Unplaced = { poi: PlanPoi; reason: UnplacedReason };

export const REASON_TEXT: Record<UnplacedReason, string> = {
	'not-planned-yet': 'Added since the last plan. Tap Replan to fit it in.',
	'day-full': 'Every day was already full by the time this came up.',
	'no-usable-days': 'This trip has no day with usable time — check the dates and buffers.',
	'hotel-unknown': 'The hotel has no location, so nothing can be measured from it.',
	'no-mealtime':
		'No mealtime on its day passes near enough. Pin it to a time to eat there anyway.'
};

export type PlannedStop = {
	/**
	 * The stored row this stop is. Carried so a save updates the row rather
	 * than replacing it, and so a travel time looked up after the fact lands
	 * on the stop it was looked up for. Absent on a stop the scheduler has
	 * just invented, which is what saving gives an id to.
	 */
	id?: string | null;
	/** The place on the wishlist. Null for an anchor. */
	poiId: string | null;
	/**
	 * The visit: which placement this card is. What a drag moves and a delete
	 * removes, since two cards for the same cafe share a poiId and only this
	 * tells them apart. Null for an anchor, and for a meal the traveller put in
	 * a slot by hand -- that one lives in the slot, not in a placement.
	 */
	placementId: string | null;
	name: string;
	at: LatLng;
	arrive: Date;
	depart: Date;
	durationMin: number;
	legIn: Leg | null;
	anchor: boolean;
	/** For an anchor, which kind. Null for a real stop. */
	anchorKind?: 'hotel' | 'terminal' | 'service' | 'chore' | 'meal' | null;
	/** Shown instead of the planner's clock. See Waypoint.timeLabel. */
	timeLabel?: string | null;
	busyness: number | null;
	warnings: Warning[];
	/** Where the next leg departs from, when that is not `at`. */
	exitAt?: LatLng | null;
	/** Held by the traveller. Written so the stored plan can say so itself. */
	pinned?: boolean;
};

export type PlannedDay = {
	index: number;
	date: string;
	stops: PlannedStop[];
	overflowed: PlanPoi[];
};

export type PlanResult = { days: PlannedDay[]; unplaced: Unplaced[] };

export type PlanInput = {
	pois: PlanPoi[];
	days: Day[];
	allowedModes: Mode[];
	timezone: string;
	/**
	 * Busyness resolved ahead of planning. Omitted, the table answers locally.
	 * Never resolved inside the planner: this runs hundreds of times per
	 * replan and must stay synchronous.
	 */
	curves?: CrowdCurves;
	/** The window everyone on the trip agrees on. Defaults when nobody said. */
	mealWindows?: MealWindows;
	/**
	 * Routed travel times, resolved ahead of planning for the same reason as
	 * busyness: this is read inside 2-opt and cannot await.
	 */
	travel?: TravelTable;
	/**
	 * What the traveller has said about particular meals, keyed by day and
	 * meal. Absent entries are the plan's to decide, which is most of them.
	 */
	meals?: MealPlan;
};

const at = (p: { lat: number; lng: number }): LatLng => ({ lat: p.lat, lng: p.lng });

/**
 * The furniture of a day: the hotel, or a chore done at it. Placed by the
 * traveller, and the plan's only to walk -- never to reorder, never to drop,
 * never to seat as a meal or to look up in the crowd table.
 */
export const isAnchor = (p: PlanPoi): p is PlanPoi & { kind: 'hotel' | 'chore' } =>
	p.kind === 'hotel' || p.kind === 'chore';

/**
 * Whether a placement stays exactly where the traveller put it: a pin, or an
 * anchor. Everything that reorders a day or moves a stop between days asks
 * this rather than `pinned`, so an anchor is held whether or not the caller
 * remembered to pin it.
 */
const stays = (p: PlanPoi) => !!p.pinned || isAnchor(p);

/**
 * The visits as places, for the crowd table. Busyness belongs to the venue:
 * two visits to the same museum share one curve, and the table the page
 * resolves ahead of time is keyed by the wishlist row, not by the placement.
 * An anchor is of no venue and has no curve.
 */
const places = (pois: PlanPoi[]) =>
	pois.flatMap((p) => (p.poiId === null ? [] : [{ id: p.poiId, category: p.category }]));

/**
 * Minutes a traveller would trade to avoid a packed venue rather than an empty
 * one. Deliberately modest: crowd is a soft cost that must lose to travel time
 * when dodging a queue would cost more movement than it saves queueing.
 */
const CROWD_WEIGHT_MIN = 20;

/**
 * Minutes of walking a traveller would trade to eat at a sane hour. Far above
 * the crowd weight on purpose: a restaurant an extra ten minutes away is a
 * minor cost, whereas dinner at 16:20 is simply wrong.
 */
const MEAL_WEIGHT_MIN_PER_HOUR = 90;

/**
 * How much detour is worth accepting to move a wanted stop earlier in the day.
 *
 * Priority decides what gets in and which day it lands on; here it only breaks
 * ties between routes that cost about the same. It must stay small, and at 3
 * minutes a position it was not: the term is weight x rating x position summed
 * over the day, so across six stops it spanned some hundred minutes of
 * pretend cost -- more than any real difference in walking inside a cluster --
 * and 2-opt bought rating order with genuine detours. Exactly the marching
 * back and forth across town this constant exists to prevent.
 *
 * Divided by the number of stops, so a long day does not weigh rating more
 * heavily than a short one.
 */
const PRIORITY_ORDER_WEIGHT_MIN = 2;

/**
 * The longest the plan will stand still waiting for a meal window to open.
 *
 * Waiting is right for a restaurant reached at 11:40. It is not right for one
 * reached at 17:20: holding a whole afternoon so a sandwich shop can be dinner
 * loses more of the day than eating at an odd hour ever would. Past this the
 * stop is taken when the traveller gets there and picks up an off-hours
 * warning, which is the honest answer.
 */
const MAX_MEAL_WAIT_MIN = 45;

/**
 * How far off the day's path a restaurant may sit and still be lunch.
 *
 * Past this the traveller eats near where they already are: a place across
 * town is a destination, not a meal, and one is chosen by pinning it rather
 * than by putting it on the wishlist.
 */
const MEAL_DETOUR_KM = 2;

/** What a well-suited place is worth in walking, per step of suitability. */
const MEAL_PREFERENCE_KM = 0.5;

/**
 * A stretch of time the traveller put on the day themselves, with a name and a
 * length but no place: a rest, a nap, an errand. Held where they put it.
 */
export const BLOCK_CATEGORY = 'block';

/**
 * Bumped whenever a change here would produce a different plan from the same
 * trip. A stored plan older than this re-times itself when the trip is opened,
 * so the traveller never has to tap Replan because the app changed.
 */
export const PLANNER_VERSION = 3;

/** The default when nobody has rated a stop: wanting it averagely. */
const NEUTRAL_PRIORITY = 3;

// ---------------------------------------------------------------- clustering

/**
 * Farthest-point seeding, not random. With random seeds, tapping Replan twice
 * produces two different trips, which users read as a bug rather than as
 * variety.
 */
function seed(pois: PlanPoi[], k: number): LatLng[] {
	const seeds: LatLng[] = [at(pois[0])];
	while (seeds.length < k) {
		let best = pois[0];
		let bestDist = -1;
		for (const p of pois) {
			const d = Math.min(...seeds.map((s) => haversineKm(s, at(p))));
			if (d > bestDist) {
				bestDist = d;
				best = p;
			}
		}
		seeds.push(at(best));
	}
	return seeds;
}

function kmeans(pois: PlanPoi[], k: number, rounds = 8): number[] {
	if (k <= 1) return pois.map(() => 0);
	let centroids = seed(pois, k);
	let labels = pois.map(() => 0);

	for (let r = 0; r < rounds; r++) {
		labels = pois.map((p) => {
			let bestI = 0;
			let bestD = Infinity;
			centroids.forEach((c, i) => {
				const d = haversineKm(c, at(p));
				if (d < bestD) {
					bestD = d;
					bestI = i;
				}
			});
			return bestI;
		});
		centroids = centroids.map((c, i) => {
			const members = pois.filter((_, j) => labels[j] === i);
			if (!members.length) return c;
			return {
				lat: members.reduce((s, m) => s + m.lat, 0) / members.length,
				lng: members.reduce((s, m) => s + m.lng, 0) / members.length
			};
		});
	}
	return labels;
}

/**
 * Split POIs across days by geography, then rebalance by *available minutes*
 * rather than by equal counts: a last day with ninety usable minutes must not
 * be handed five stops because the arithmetic said so.
 *
 * `anchorMin[i]` is the time day `i` spends on its journey cards -- the
 * airport transfer, checking in. Omitted, it is assumed free, which is true
 * of every day but the first and the last.
 *
 * Pinned stops are not distributed. They are placed on the day they are already
 * on, and the free stops are clustered around them -- so a pin both keeps its
 * day and spends that day's minutes, which is what stops the rest of the day
 * being planned as though the pin were not there. The day's anchors are held
 * the same way: the hotel and the chores are placements now, and the time
 * they take is counted against the day through `load` like any stop's.
 */
export function assignDays(
	pois: PlanPoi[],
	days: Day[],
	anchorMin: number[] = []
): Map<number, PlanPoi[]> {
	const usable = days.map((d, i) => ({ i, min: d.usableMin })).filter((d) => d.min > 0);
	const buckets = new Map<number, PlanPoi[]>();
	days.forEach((_, i) => buckets.set(i, []));
	if (!pois.length || !usable.length) return buckets;

	const held = pois.filter((p) => stays(p) && p.dayIndex !== null && buckets.has(p.dayIndex));
	for (const p of held) buckets.get(p.dayIndex!)!.push(p);

	// An anchor on a day that no longer exists is not free to be clustered
	// somewhere: it belongs to a day the dates have since removed, and the
	// caller is the one to tidy that up.
	const free = pois.filter((p) => !held.includes(p) && !isAnchor(p));
	if (!free.length) return buckets;

	const labels = kmeans(free, Math.min(usable.length, free.length));

	// Clusters carrying the most wanted stops go to the earliest days. A rained
	// out final day should cost the trip its least wanted stops, not its best.
	const clusters = new Map<number, PlanPoi[]>();
	labels.forEach((label, j) => {
		const key = Math.min(label, usable.length - 1);
		if (!clusters.has(key)) clusters.set(key, []);
		clusters.get(key)!.push(free[j]);
	});
	const wanted = (list: PlanPoi[]) =>
		list.reduce((sum, p) => sum + (p.priority ?? NEUTRAL_PRIORITY), 0) / (list.length || 1);
	[...clusters.values()]
		.sort((a, b) => wanted(b) - wanted(a))
		.forEach((list, rank) => {
			const dayIndex = usable[Math.min(rank, usable.length - 1)].i;
			buckets.get(dayIndex)!.push(...list);
		});

	// Rebalance: while a day is over its minute budget and another has slack,
	// move the stop that is geographically closest to the slack day.
	const load = (list: PlanPoi[]) => list.reduce((s, p) => s + p.durationMin, 0);
	// What is left of the day once its anchors have taken their cut, less a
	// quarter for travel between the stops themselves. Arrival day is the case
	// this exists for: a 4h window with a 3h airport transfer in it has room
	// for nothing, and handing it stops only drops them at schedule time.
	const budget = (i: number) => Math.max(0, days[i].usableMin - (anchorMin[i] ?? 0)) * 0.75;

	/**
	 * Move stops off a day that is over its budget, onto a day that has room
	 * for them, choosing the stop that is most out of place: nearest where it
	 * is going, relative to where it currently sits.
	 *
	 * Two things this gets right that the earlier version did not.
	 *
	 * It chooses by geography rather than by rating. Shedding the least wanted
	 * stop wherever it happened to be is what sent a traveller back across the
	 * city: a day's overflow landed on whichever day had room, not on the day
	 * already going that way. Rating now only separates stops equally misplaced.
	 *
	 * It only makes a move that holds. Moving onto a day with no room for it
	 * pushed that day over in turn, which pushed something back, and the two
	 * traded stops until the guard ran out -- leaving whatever arrangement the
	 * last iteration happened to produce. Every move now strictly empties the
	 * full day without filling another past its budget, so the loop settles.
	 */
	for (let guard = 0; guard < pois.length * 2; guard++) {
		const over = usable.find(({ i }) => load(buckets.get(i)!) > budget(i));
		if (!over) break;

		const list = buckets.get(over.i)!;
		const home = centroid(list);
		let best: { poi: PlanPoi; from: number; to: number; pull: number } | null = null;

		for (const poi of list) {
			// A pin is the one thing rebalancing may not touch. An anchor is
			// held the same way: the hotel does not move to Thursday.
			if (stays(poi)) continue;
			for (const { i } of usable) {
				if (i === over.i) continue;
				const target = buckets.get(i)!;
				if (load(target) + poi.durationMin > budget(i)) continue;

				const centre = centroid(target) ?? at(poi);
				const pull = haversineKm(centre, at(poi)) - haversineKm(home ?? centre, at(poi));
				const better =
					!best ||
					pull < best.pull ||
					(pull === best.pull &&
						(poi.priority ?? NEUTRAL_PRIORITY) < (best.poi.priority ?? NEUTRAL_PRIORITY));
				if (better) best = { poi, from: over.i, to: i, pull };
			}
		}

		// Nowhere for anything to go. The day stays full, and walkClock will
		// report what did not fit rather than the buckets churning.
		if (!best) break;

		const from = buckets.get(best.from)!;
		from.splice(from.indexOf(best.poi), 1);
		buckets.get(best.to)!.push(best.poi);
	}
	return buckets;
}

function centroid(list: PlanPoi[]): LatLng | null {
	if (!list.length) return null;
	return {
		lat: list.reduce((s, p) => s + p.lat, 0) / list.length,
		lng: list.reduce((s, p) => s + p.lng, 0) / list.length
	};
}

// ------------------------------------------------------------------ ordering

/**
 * Nearest-neighbour from wherever the day begins, then 2-opt against the full
 * schedule cost. An open path, not a loop: the journey cards are never part of
 * it, and the anchors within it hold the slots the traveller gave them.
 */
export function orderDay(
	pois: PlanPoi[],
	day: Day,
	allowedModes: Mode[],
	timezone: string,
	curves: CrowdCurves,
	slots: MealSlot[],
	travel: TravelTable,
	/**
	 * The rest of the day as it will actually be walked: the restaurants the
	 * meal pass may seat, what the traveller has said about the slots, and
	 * which day this is.
	 *
	 * Without these, 2-opt scored a day with no meals in it at all and then
	 * the real walk seated them -- so the order was chosen against one day and
	 * the overflow fell out of another.
	 */
	rest: {
		diners?: PlanPoi[];
		says?: Map<string, MealSlotRow>;
		dayIndex?: number;
		picked?: Map<string, PlanPoi>;
	} = {}
): PlanPoi[] {
	if (pois.length < 2) return pois;

	// Where the day is when the route begins: the last journey card, on a day
	// that has one. On any other day there is nowhere to measure from until
	// the first placement -- usually the hotel -- and the nearest neighbour to
	// nowhere is simply the first stop offered, which is the most wanted.
	const start = day.fixedStart.at(-1)?.at ?? null;
	// Pinned stops and anchors hold their place; only the rest are ordered.
	// Nearest neighbour from wherever the day currently stands, which for a
	// slot that follows a pin is the pin itself.
	const remaining = pois.filter((p) => !stays(p));
	// By the moment they are held at, where they have one: two pins at 13:00
	// and 19:00 have an order whatever their stored indices say.
	const pins = pois
		.filter((p) => p.pinned && !isAnchor(p))
		.sort(
			(a, b) =>
				(a.pinnedAt ? Date.parse(a.pinnedAt) : Infinity) -
					(b.pinnedAt ? Date.parse(b.pinnedAt) : Infinity) ||
				(a.orderIndex ?? 0) - (b.orderIndex ?? 0)
		);
	// An anchor has a position and nothing else to say about it: the hotel is
	// first because the traveller put it first, not because of any clock.
	const anchors = pois
		.filter(isAnchor)
		.sort((a, b) => (a.orderIndex ?? 0) - (b.orderIndex ?? 0));

	const route: PlanPoi[] = [];
	const held = new Map<number, PlanPoi>();
	// The anchors take their slots before the pins do. Pins are ranked by the
	// moments they hold and a pin with no moment ranks last, so the hotel at
	// index 0 -- which has no moment -- would otherwise be seated after every
	// dragged stop, and since every drag records a time that was every day
	// with a drag on it: the morning opening halfway through the afternoon.
	let nextFree = 0;
	for (const anchor of anchors) {
		let slot = Math.min(Math.max(anchor.orderIndex ?? 0, nextFree), pois.length - 1);
		while (held.has(slot) && slot < pois.length - 1) slot++;
		// Two anchors past the end of a short day: the second is appended
		// below, in its stored order, which is still after the first.
		if (held.has(slot)) break;
		held.set(slot, anchor);
		nextFree = slot + 1;
	}
	// Slots for the pins, in the order the moments they hold put them. Keyed
	// off the stored index where that is free and does not contradict the
	// times -- two pins that both claim index 9 must still come out in the
	// order their clocks say.
	nextFree = 0;
	pins.forEach((pin, rank) => {
		// Its own place in the day, not its rank among the pins. Taking the rank
		// put a single pinned stop at the front of the day and, since 2-opt
		// cannot cross a pin, left everything else behind it to be dropped --
		// and since every drag records a time, every dragged card did this.
		// The times still order the pins against each other, through nextFree.
		const wanted = pin.orderIndex ?? rank;
		let slot = Math.min(Math.max(wanted, nextFree), pois.length - 1);
		while (held.has(slot) && slot < pois.length - 1) slot++;
		// Only ever forwards. Falling back to an earlier slot put a pin before
		// one it comes after -- two pins stored at the same index came out in
		// the wrong order however clearly their clocks disagreed. A pin with
		// nowhere left is appended below, in time order, which is right.
		if (held.has(slot)) return;
		held.set(slot, pin);
		nextFree = slot + 1;
	});
	let cursor = start;
	for (let slot = 0; slot < pois.length; slot++) {
		const pin = held.get(slot);
		if (pin) {
			route.push(pin);
			cursor = at(pin);
			continue;
		}
		if (!remaining.length) continue;
		let bestI = 0;
		let bestD = Infinity;
		remaining.forEach((p, i) => {
			const d = cursor ? haversineKm(cursor, at(p)) : 0;
			if (d < bestD) {
				bestD = d;
				bestI = i;
			}
		});
		const [next] = remaining.splice(bestI, 1);
		route.push(next);
		cursor = at(next);
	}
	// An anchor or a pin whose index landed past the end of a shorter day, or
	// two claiming one slot: whatever the map could not place still belongs
	// here, anchors in their stored order and then the pins in theirs.
	for (const anchor of anchors) if (!route.includes(anchor)) route.push(anchor);
	for (const pin of pins) if (!route.includes(pin)) route.push(pin);
	for (const free of remaining) route.push(free);

	// 2-opt on the real objective: travel minutes plus a soft crowd cost. This
	// is what lets a museum move out of its 11-15 peak, and what stops it moving
	// when the detour costs more than the queue.
	const score = (order: PlanPoi[]) => {
		const sim = walkClock(
			order,
			day,
			allowedModes,
			timezone,
			curves,
			slots,
			travel,
			rest.diners ?? [],
			rest.says ?? new Map(),
			rest.dayIndex ?? 0,
			rest.picked ?? new Map()
		);
		return (
			sim.travelMin +
			CROWD_WEIGHT_MIN * sim.crowdSum +
			MEAL_WEIGHT_MIN_PER_HOUR * sim.mealMissHours +
			// Waiting is a real cost, just a much smaller one than eating at the
			// wrong time: prefer the order that arrives closer to the slot.
			0.5 * sim.waitedMin +
			// A wanted stop earlier in the day, when it is nearly free to do so.
			// An anchor is not wanted or unwanted, and cannot move in any case.
			(PRIORITY_ORDER_WEIGHT_MIN *
				order.reduce(
					(sum, p, i) => sum + (isAnchor(p) ? 0 : (p.priority ?? NEUTRAL_PRIORITY) * i),
					0
				)) /
				Math.max(1, order.length) +
			// Anything that did not fit is worse than any amount of walking, and
			// of two orders that drop the same number of stops, the one that
			// drops the least wanted wins. Rating belongs here rather than in
			// the ordering term: it decides what gets left behind, not how far
			// the traveller walks to reach what does not.
			10_000 * sim.overflowed.length +
			1_000 *
				sim.overflowed.reduce((sum, p) => sum + (p.priority ?? NEUTRAL_PRIORITY), 0)
		);
	};

	let best = route;
	let bestScore = score(best);
	let improved = true;
	while (improved) {
		improved = false;
		for (let i = 0; i < best.length - 1; i++) {
			for (let j = i + 1; j < best.length; j++) {
				// Reversing a segment that contains a pin or an anchor moves it.
				// Only free stops are permuted, so every held placement keeps
				// the index the seeding gave it.
				if (best.slice(i, j + 1).some(stays)) continue;
				const candidate = [...best.slice(0, i), ...best.slice(i, j + 1).reverse(), ...best.slice(j + 1)];
				const s = score(candidate);
				if (s < bestScore - 0.01) {
					best = candidate;
					bestScore = s;
					improved = true;
				}
			}
		}
	}
	return best;
}

// --------------------------------------------------------------------- clock

type ClockResult = {
	stops: PlannedStop[];
	overflowed: PlanPoi[];
	travelMin: number;
	crowdSum: number;
	/** Total hours by which meals missed their slots. */
	mealMissHours: number;
	/** Idle minutes spent waiting for a meal slot to open. */
	waitedMin: number;
};

/**
 * Walk the day's clock: the journey in, then leg, dwell, leg, dwell through
 * every placement in order -- the hotel and the chores among them, where the
 * traveller put them -- then the journey out.
 */
function walkClock(
	pois: PlanPoi[],
	day: Day,
	allowedModes: Mode[],
	timezone: string,
	curves: CrowdCurves,
	slots: MealSlot[],
	travel: TravelTable,
	/**
	 * Restaurants for this day that the traveller did not pin. Deliberately not
	 * part of the route: the route settles first, and then each meal window
	 * takes whichever of these is nearest to wherever the day has them.
	 */
	diners: PlanPoi[] = [],
	/** What the traveller has said about this day's meals. */
	says: Map<string, MealSlotRow> = new Map(),
	dayIndex = 0,
	/**
	 * Places the traveller put in a slot themselves, already resolved. Seated
	 * as given: an assignment is not a candidate to be weighed against the
	 * ones nearby, it is the answer.
	 */
	picked: Map<string, PlanPoi> = new Map()
): ClockResult {
	const stops: PlannedStop[] = [];
	const overflowed: PlanPoi[] = [];
	let travelMin = 0;
	let crowdSum = 0;
	let mealMissHours = 0;
	let waitedMin = 0;
	const dayEndMs = day.end.getTime();
	let clock = day.start.getTime();
	let cursor: LatLng | null = null;
	let cursorTerminal = false;
	/** Meals the day has already had, whether from the wishlist or from us. */
	const served = new Set<string>();
	const unseated = [...diners];

	// Meals the traveller placed themselves. Their slots are claimed before the
	// day is walked, not when the clock reaches them: the meal pass offers a
	// window as soon as it opens, which is earlier than the route gets to the
	// stop, so a chosen breakfast would otherwise arrive to find an invented
	// one already sitting in it and the morning counted twice.
	//
	// Every meal left in the route is pinned -- the meal pass owns the rest --
	// so the time each will be had is known in advance.
	for (const p of pois) {
		if (!isMeal(p.category) || !p.pinnedAt) continue;
		const slot = slotAt(new Date(p.pinnedAt), timezone, slots);
		if (slot) served.add(slot);
	}

	// A slot the traveller filled with a place that is on this day: that place
	// is the meal, wherever the day reaches it. Without this the day would walk
	// their choice and then offer an empty container for the same meal.
	//
	// By place, because that is what the slot names: however many visits to
	// the cafe the day has, one of them is breakfast.
	const onTheDay = new Set(pois.map((p) => p.poiId));
	for (const name of MEAL_NAMES) {
		const id = says.get(mealKey(dayIndex, name))?.poi_id;
		if (id && onTheDay.has(id)) served.add(name);
	}

	const push = (
		name: string,
		point: LatLng,
		durationMin: number,
		anchor: boolean,
		poiId: string | null,
		placementId: string | null,
		category: string | null,
		terminal: boolean,
		exitAt: LatLng | null = null,
		anchorKind: 'hotel' | 'terminal' | 'service' | 'chore' | 'meal' | null = null,
		timeLabel: string | null = null,
		runsLate = false,
		/** A pinned moment. The clock is set to it rather than arriving at it. */
		heldAt: number | null = null,
		/** Anything else worth saying about this stop. */
		note: Warning | null = null
	) => {
		let legIn: Leg | null = null;
		if (cursor) {
			// The clock says when this journey starts, which is what decides
			// whether a timetabled one is the same journey at all.
			legIn = leg(
				cursor,
				point,
				allowedModes,
				terminal || cursorTerminal,
				travel,
				new Date(clock).toISOString()
			);
			clock += legIn.minutes * 60_000;
			travelMin += legIn.minutes;
		}
		// A pinned stop happens when the traveller said it happens. Being early
		// is waiting; being late means the day is over-full, and the warning
		// below says so rather than the plan quietly sliding the pin.
		//
		// Never backwards. Setting the clock to a moment already past rewound
		// the day: the stop was timed before the one it follows, everything
		// after it overlapped, and the plan of record showed times that ran
		// the wrong way.
		const late = heldAt !== null && clock > heldAt;
		if (heldAt !== null) clock = Math.max(clock, heldAt);
		let arrive = new Date(clock);

		// A meal reached before its slot waits for it rather than being eaten at
		// the wrong hour -- but only if the day can absorb the wait. Otherwise
		// the stop keeps its early time and picks up an off-hours warning below.
		if (!anchor && heldAt === null && isMeal(category)) {
			const opens = waitUntilSlot(arrive, timezone, slots);
			if (
				opens &&
				opens.getTime() - arrive.getTime() <= MAX_MEAL_WAIT_MIN * 60_000 &&
				opens.getTime() + durationMin * 60_000 <= dayEndMs
			) {
				waitedMin += (opens.getTime() - arrive.getTime()) / 60_000;
				arrive = opens;
				clock = opens.getTime();
			}
		}

		clock += durationMin * 60_000;
		const depart = new Date(clock);

		const busyness = anchor || !poiId ? null : curves.at(poiId, arrive, timezone);
		if (busyness !== null) crowdSum += busyness;

		const warnings: Warning[] = [];
		if (runsLate) {
			warnings.push({ kind: 'overflow', message: 'Runs past the end of the day' });
		}
		if (late) {
			warnings.push({ kind: 'overflow', message: 'The day does not reach this in time' });
		}
		if (note) warnings.push(note);
		if (busyness !== null && busyness >= 0.8) {
			warnings.push({ kind: 'crowded', message: 'Usually packed at this hour' });
		}
		if (!anchor && isMeal(category)) {
			// A restaurant from the wishlist fills the slot it lands in, so the
			// plan does not then offer a placeholder for the same meal.
			const slot = slotAt(arrive, timezone, slots);
			if (slot) served.add(slot);
			const miss = mealMiss(arrive, timezone, slots);
			mealMissHours += miss;
			if (miss > 0.5) {
				warnings.push({ kind: 'off-hours', message: 'Not really a mealtime' });
			}
		}

		stops.push({
			poiId,
			placementId,
			name,
			pinned: heldAt !== null,
			at: point,
			arrive,
			depart,
			durationMin,
			legIn,
			anchor,
			anchorKind,
			timeLabel,
			busyness,
			warnings,
			exitAt
		});
		// The day carries on from wherever this stop let the traveller out.
		cursor = exitAt ?? point;
		cursorTerminal = terminal;
	};

	for (const w of day.fixedStart) {
		push(w.name, w.at, w.dwellMin, true, null, null, null, w.kind === 'terminal', null, w.kind, w.timeLabel ?? null);
	}

	/**
	 * Offer the meals the day has not had yet, at whichever slot is open.
	 *
	 * A placeholder eats where the traveller already is -- the cursor -- so it
	 * costs nothing to reach, which is also true of how people actually choose
	 * lunch. It takes real time, because a day that pretends lunch is free is
	 * lying about how much of it is left.
	 *
	 * `until` is the moment the caller is about to spend: a meal is only
	 * offered if its window is open before then, so the day fills in order
	 * rather than collecting three meals at the end. `next` is the index of
	 * the placement about to be walked, so the way home can be priced through
	 * whatever anchors still stand between here and the end of the day.
	 */
	/**
	 * The meal pass: fill whatever window is open, from the day's own
	 * restaurants where one is near enough and from nothing where none is.
	 *
	 * Run against a route that is already settled. Restaurants are not part of
	 * that route -- which is the whole point. Leaving them in it let a sandwich
	 * shop decide the shape of a day: the route bent towards it, the clock
	 * stalled waiting for its window, and whichever window it happened to reach
	 * became the meal. A meal is a thing you do near where you already are.
	 */
	const offerMeals = (until: number, next: number, patient = false) => {
		for (const slot of slots) {
			if (served.has(slot.name)) continue;

			// What the traveller has said about this meal on this day.
			const say = says.get(mealKey(dayIndex, slot.name));
			// Skipped: there is no breakfast that day, and no container either.
			if (say?.skipped) continue;

			// A time the traveller dragged this meal to is when it opens, and
			// that sticks. It is not a new window: the window is still the one
			// in their profile, and the checks below ask their questions of a
			// dragged meal the same as of any other. A dinner dragged to four
			// o'clock happens at four, and the container says that four is not
			// dinner time, rather than being excused the question because
			// someone has already decided.
			const moved = say?.at ? new Date(say.at).getTime() : null;
			const opens = moved ?? zonedInstant(day.date, toHHMM(slot.from), timezone).getTime();
			const closes = zonedInstant(day.date, toHHMM(slot.to), timezone).getTime();
			if (opens > until) continue;

			// The window has closed. On the last sweep a meal the day opened
			// before is still had, late, rather than quietly dropped: the
			// British Museum runs from six to eight and takes the whole of
			// dinner with it, and the honest answer is a late dinner, not no
			// dinner at all. A window that had already closed when the day
			// started is a different thing and stays gone.
			//
			// A meal dragged past its window is not late until its own time has
			// gone by as well. The window closing at half past nine is no reason
			// to have a dinner asked for at eleven any earlier than eleven.
			const late = Math.max(opens, closes) < clock;
			if (late && !(patient && opens >= day.start.getTime())) continue;

			// Not worth standing about for while there are still stops to make:
			// skipped now, offered again after the next one, by which time the
			// window is open and there is no gap. At the end of the day there is
			// nothing else to do, so the wait is worth it -- otherwise a day
			// that finishes at four has no dinner at all.
			if (!patient && opens - clock > MAX_MEAL_WAIT_MIN * 60_000) continue;

			// Before anything has been walked there is nowhere the traveller
			// already is, so the meal is had where they are about to be. A day
			// the traveller has taken the hotel off still starts somewhere, and
			// breakfast before the first museum is better than no breakfast.
			const here: LatLng | undefined = cursor ?? day.fixedStart[0]?.at ?? pois[next];
			if (!here) continue;

			// A place the traveller put in this slot themselves. It goes in
			// whatever the distance and whatever else is nearer: they chose it.
			let chosen: PlanPoi | null = picked.get(slot.name) ?? null;
			let chosenAt: LatLng = chosen ? nearestBranch(chosen, here, haversineKm) : here;

			// Otherwise whichever of the day's restaurants is nearest, if any
			// is near enough to be worth the detour.
			let best = MEAL_DETOUR_KM;
			if (!chosen) {
				for (const diner of unseated) {
					// A coffee shop is breakfast and is not dinner. Nothing unsuited
					// to this window is a candidate for it at any distance.
					const fit = mealFit(diner.category, slot.name);
					if (fit === 0) continue;

					// A chain answers with whichever of its shops is nearest here,
					// which is often the difference between lunch and a trek.
					const branch = nearestBranch(diner, here, haversineKm);
					// Suitability is worth walking for, but not far: half a
					// kilometre a step, so the right sort of place wins a close
					// call and never a long one.
					const cost = haversineKm(here, branch) - fit * MEAL_PREFERENCE_KM;
					if (cost <= best) {
						best = cost;
						chosen = diner;
						chosenAt = branch;
					}
				}
			}

			const to = chosen ? chosenAt : here;
			const minutes = chosen?.durationMin ?? MEAL_MINUTES[slot.name];
			const hop = chosen ? leg(here, to, allowedModes, cursorTerminal, travel).minutes : 0;
			const start = Math.max(clock + hop * 60_000, opens);
			// Only when it actually fits, the way home included.
			// A slot the traveller placed goes in even if the day runs long for
			// it: that is their call, the same as a pinned stop.
			const theirs = !!say && (!!say.at || !!say.poi_id);
			if (!theirs && start + (minutes + tailCost(to, next)) * 60_000 > dayEndMs) continue;

			// The clock really does move, but a placeholder's wait is not
			// counted against the route: it eats wherever the traveller happens
			// to be, so letting it price orderings would have 2-opt chase meal
			// windows across the city.
			clock = Math.max(clock, start - hop * 60_000);
			served.add(slot.name);

			if (chosen) {
				const i = unseated.indexOf(chosen);
				// A diner is a visit on this day, and the card is that visit. A
				// place the traveller put in the slot is not: the slot holds it,
				// and whatever visit the wishlist lent to describe it belongs to
				// some other day or to none. Carrying that id would let a drag
				// of Tuesday's breakfast move Thursday's.
				const placementId = i >= 0 ? chosen.id : null;
				if (i >= 0) unseated.splice(i, 1);
				push(chosen.name, chosenAt, minutes, false, chosen.poiId, placementId, chosen.category, false, null, 'meal');
			} else {
				// An empty container. It keeps its place and its time, because
				// a meal nobody has chosen yet is still a meal that will happen.
				//
				// Had outside its own window it says so, the way a restaurant
				// reached at the wrong hour does. That is the whole of the
				// plan's say over a dragged meal: the time is the traveller's,
				// the remark that it is not a mealtime is ours. Measured against
				// this slot alone, because a dinner at one o'clock is inside
				// lunch and is still not dinner.
				const miss = mealMiss(new Date(start), timezone, [slot]);
				const note: Warning | null =
					miss > 0.5 ? { kind: 'off-hours', message: 'Not really a mealtime' } : null;
				push(MEAL_LABEL[slot.name], here, minutes, true, null, null, slot.name, false, null, 'meal', null, false, null, note);
			}
		}
	};

	/**
	 * Minutes between leaving `from` and being done with the day: every anchor
	 * still to come from placement `next` onwards, then the journey out -- the
	 * legs as well as the dwell.
	 *
	 * Summing only the dwell was wrong in the case that matters most: on a
	 * departure day the way out is the hotel, the bags and then the airport,
	 * and the leg between the hotel and the airport is the whole transfer.
	 * Leaving it out let the planner fill the day right up to check-in and
	 * then spend ninety minutes getting to Stansted, arriving after the desk
	 * had closed. The hotel and the bags are placements now, which is why the
	 * anchors are walked here before the journey is: they are the way home.
	 */
	const tailCost = (from: LatLng, next: number) => {
		let point = from;
		let fromTerminal = false;
		let total = 0;
		for (let k = next; k < pois.length; k++) {
			const anchor = pois[k];
			if (!isAnchor(anchor)) continue;
			total += leg(point, anchor, allowedModes, false, travel).minutes + anchor.durationMin;
			point = anchor;
		}
		for (const w of day.fixedEnd) {
			const terminal = w.kind === 'terminal' || fromTerminal;
			total += leg(point, w.at, allowedModes, terminal, travel).minutes + w.dwellMin;
			point = w.at;
			fromTerminal = w.kind === 'terminal';
		}
		return total;
	};
	// Where the day closes: the run of anchors at its end -- the hotel, or the
	// hotel and then the bags. The last chance to eat is before them, the way
	// it was before the journey out when the hotel was part of that. Seating
	// dinner after the traveller is home put it after the day's last card,
	// which is to say nowhere.
	//
	// A day of nothing but anchors has no out to eat in. It eats at the hotel,
	// once it is up and dressed: after the opening anchor and whatever chores
	// follow it, and before the hotel that closes the day.
	let closing = pois.length;
	while (closing > 0 && isAnchor(pois[closing - 1])) closing--;
	if (closing === 0 && pois.length > 0) {
		closing = 1;
		while (closing < pois.length && pois[closing].kind === 'chore') closing++;
	}

	for (let i = 0; i < pois.length; i++) {
		const p = pois[i];
		const anchorKind = isAnchor(p) ? p.kind : null;
		const anchor = anchorKind !== null;
		// Would this stop, plus getting to the day's final anchor, run past the
		// end of the day? If so it does not fit -- and neither will anything
		// after it, since the route is ordered.
		// A block of time the traveller added themselves -- a rest, an errand,
		// a nap -- happens wherever they already are, the same as a meal the
		// plan supplies. Its stored coordinates are a formality. An anchor's
		// are not: the hotel is a place, and getting back to it is a leg.
		const where = anchor
			? at(p)
			: p.category === BLOCK_CATEGORY
				? (cursor ?? at(p))
				: nearestBranch(p, cursor ?? at(p), haversineKm);
		const held = p.pinned && p.pinnedAt ? new Date(p.pinnedAt).getTime() : null;
		// Anything whose window opens before this stop would end. Offered here
		// so the day fills in order rather than saving every meal until the end.
		//
		// Measured, then offered, then measured again. The meal pass moves the
		// clock, and testing the stop against a reading taken before it let a
		// stop run a whole meal past the end of the day with nothing said --
		// on a departure day, past the airport's check-in desk.
		//
		// Not before a chore. Getting ready is done on the way out of the door
		// and collecting the bags on the way to the airport, and a meal offered
		// ahead of either would put breakfast before getting dressed. A return
		// to the hotel is different: lunch is had before a long afternoon rest,
		// not after it -- but only once the day is somewhere. Before the
		// opening hotel there is nowhere to eat but the hotel itself, and
		// breakfast is had from it, not on the way to it.
		const reach = () => {
			const leg_ = leg(cursor ?? where, where, allowedModes, cursorTerminal, travel);
			return clock + (cursor ? leg_.minutes : 0) * 60_000 + p.durationMin * 60_000;
		};
		if (i === closing) offerMeals(dayEndMs, i, true);
		else if (i < closing && p.kind !== 'chore' && (!anchor || cursor)) offerMeals(reach(), i);
		const finish = reach();

		// The way home starts from wherever the stop lets the traveller out --
		// measuring it from the entrance would price a cable car's whole span
		// at zero.
		const leaves = p.exitAt ?? where;
		// A stop the traveller pinned is not the planner's to drop. They put it
		// there; it goes in, and if the day runs long the plan says so rather
		// than quietly deciding for them. An anchor the same: there is no plan
		// in which the traveller does not go back to the hotel.
		// A pin waits for its moment, so its real end is that moment plus its
		// length -- not where the route happened to arrive.
		const ends = held !== null ? Math.max(finish, held + p.durationMin * 60_000) : finish;
		const runsLate = ends + tailCost(leaves, i + 1) * 60_000 > day.end.getTime();
		if (runsLate && !stays(p)) {
			overflowed.push(p);
			continue;
		}
		push(
			p.name,
			where,
			p.durationMin,
			anchor,
			p.poiId,
			p.id,
			p.category,
			false,
			p.exitAt ?? null,
			anchorKind,
			null,
			runsLate,
			held
		);
	}

	// Whatever the day never got round to, while there is still room for it --
	// on a day that does not close on an anchor, since one that does has had
	// this sweep already, before going home.
	if (closing >= pois.length) offerMeals(dayEndMs, pois.length, true);

	for (const w of day.fixedEnd) {
		push(w.name, w.at, w.dwellMin, true, null, null, null, w.kind === 'terminal', null, w.kind, w.timeLabel ?? null);
	}

	return { stops, overflowed, travelMin, crowdSum, mealMissHours, waitedMin };
}

/**
 * A day's stops split in two: what the route is made of, and the restaurants
 * the meal pass may seat.
 *
 * A pinned restaurant stays in the route -- the traveller said where and when,
 * and that is not the meal pass's to reconsider.
 */
function split(list: PlanPoi[], chosen: Set<string> = new Set()): { route: PlanPoi[]; diners: PlanPoi[] } {
	// A place the traveller put in a slot stays in the route, like a pinned
	// one: they said what it is and where it goes, and the meal pass has
	// nothing left to decide about it.
	const diners = list.filter(
		(p) => p.poiId !== null && isMeal(p.category) && !p.pinned && !chosen.has(p.poiId)
	);
	return { route: list.filter((p) => !diners.includes(p)), diners };
}

// ------------------------------------------------------------------ entrypoints

/** Steps 3-5. Respects the day/order the traveller already chose. */
export function schedule(input: PlanInput): PlanResult {
	const curves = input.curves ?? categoryCurves(places(input.pois), input.days, input.timezone);
	const slots = slotsFrom(input.mealWindows ?? DEFAULT_WINDOWS);
	const travel = input.travel ?? noTravel;
	const byDay = new Map<number, PlanPoi[]>();
	input.days.forEach((_, i) => byDay.set(i, []));
	const unplaced: Unplaced[] = [];

	// Places the traveller put in a meal slot. The slot says which meal they
	// are; it does not take them out of the day. A place chosen for lunch is a
	// stop on that day, in the order it was put in, and is dragged about like
	// any other -- which is what was wrong before: it was lifted out of the
	// route entirely and re-seated by the meal pass, so dropping anything
	// before it did nothing at all.
	const says = input.meals ?? new Map();
	/** Every place named by a slot, on whatever day. */
	const chosen = new Set(
		[...says.values()].map((r) => r.poi_id).filter((id): id is string => !!id)
	);

	for (const p of input.pois) {
		if (p.dayIndex === null || !byDay.has(p.dayIndex)) {
			// Chosen for a meal before it had a day of its own: the slot is where
			// it goes, so it is not waiting for a plan.
			if (p.poiId !== null && chosen.has(p.poiId)) continue;
			// An anchor is never waiting for a plan either. Off any day it is
			// furniture from a day the dates have removed, and there is nothing
			// to say about it that would help.
			if (isAnchor(p)) continue;
			// Never been through the planner, or points at a day that no longer
			// exists because the dates moved.
			unplaced.push({ poi: p, reason: 'not-planned-yet' });
		} else {
			byDay.get(p.dayIndex)!.push(p);
		}
	}
	for (const list of byDay.values()) {
		list.sort((a, b) => (a.orderIndex ?? 0) - (b.orderIndex ?? 0));
	}

	const days = input.days.map((day, i) => {
		const { route, diners } = split(byDay.get(i)!, chosen);

		// Slots the traveller filled with a place that is not on this day --
		// chosen before it had one, or left over from a day that moved. A place
		// already on the day is walked where it sits; seating it again would put
		// it on the day twice.
		//
		// All by place. The slot names one, and any visit to it will do to say
		// where it is and how long it takes, which is all the meal pass asks.
		const here = new Set(byDay.get(i)!.map((p) => p.poiId));
		const picked = new Map<string, PlanPoi>();
		for (const meal of MEAL_NAMES) {
			const id = says.get(mealKey(i, meal))?.poi_id;
			if (!id || here.has(id)) continue;
			const poi = input.pois.find((p) => p.poiId === id);
			if (poi) picked.set(meal, poi);
		}
		const result = walkClock(
			route,
			day,
			input.allowedModes,
			input.timezone,
			curves,
			slots,
			travel,
			diners,
			says,
			i,
			picked
		);
		unplaced.push(...result.overflowed.map((poi) => ({ poi, reason: 'day-full' as const })));
		// A restaurant no mealtime came near enough to reach. By visit: two
		// visits to the same cafe are two candidates, and seating one for
		// breakfast says nothing about whether the other found a lunch.
		const seated = new Set(result.stops.map((st) => st.placementId));
		unplaced.push(
			...diners
				.filter((d) => !seated.has(d.id))
				.map((poi) => ({ poi, reason: 'no-mealtime' as const }))
		);
		return { index: i, date: day.date, stops: result.stops, overflowed: result.overflowed };
	});

	return { days, unplaced };
}

/**
 * An order index that puts a stop after the last of a day's stops and still
 * ahead of the anchors that close it. Whatever the plan moves onto a day is a
 * stop, and the traveller goes back to the hotel after it, not before. Half a
 * step, so it sorts between the day's own dense indices without renumbering
 * them; nothing stores this, the walk hands out fresh indices afterwards.
 */
function endOfDay(placed: PlanPoi[], dayIndex: number): number {
	const day = placed
		.filter((p) => p.dayIndex === dayIndex)
		.sort((a, b) => (a.orderIndex ?? 0) - (b.orderIndex ?? 0));
	let k = day.length;
	while (k > 0 && isAnchor(day[k - 1])) k--;
	return k === day.length ? 999 : (day[k].orderIndex ?? 0) - 0.5;
}

/** Steps 1-5. A full reshuffle -- what the Replan control runs. */
export function replan(input: PlanInput): PlanResult {
	const curves = input.curves ?? categoryCurves(places(input.pois), input.days, input.timezone);
	const slots = slotsFrom(input.mealWindows ?? DEFAULT_WINDOWS);
	const travel = input.travel ?? noTravel;

	// Nothing can be measured from a hotel at 0,0, so say so rather than
	// producing a plan built on a point in the Gulf of Guinea. The furniture
	// is still walked: a day with no time in it still starts at the hotel.
	if (input.days.every((d) => d.usableMin === 0)) {
		return {
			days: input.days.map((day, index) => ({
				index,
				date: day.date,
				stops: walkClock(
					input.pois
						.filter((p) => isAnchor(p) && p.dayIndex === index)
						.sort((a, b) => (a.orderIndex ?? 0) - (b.orderIndex ?? 0)),
					day,
					input.allowedModes,
					input.timezone,
					curves,
					slots,
					travel
				).stops,
				overflowed: []
			})),
			unplaced: input.pois
				.filter((p) => !isAnchor(p))
				.map((poi) => ({ poi, reason: 'no-usable-days' as const }))
		};
	}

	// Price each day's journey cards by scheduling it empty: that run already
	// applies the real travel table and mode chooser to the transfers. The
	// hotel and the chores are not priced here -- they are placements, and
	// assignDays counts their minutes the way it counts a stop's.
	//
	// With no meals. An empty day still seats breakfast, lunch and dinner, so
	// measuring to the end of one priced a 09:00-22:00 day at 690 minutes of
	// anchors and left every day a budget of about an hour -- which meant
	// rebalancing never ran at all, and a full day never shed anything to an
	// empty one. Every test fixture ends at 19:00, where dinner does not fit,
	// which is why nothing caught it.
	const anchorMin = input.days.map((day) => {
		const stops = walkClock(
			[],
			day,
			input.allowedModes,
			input.timezone,
			curves,
			[],
			travel
		).stops;
		const last = stops[stops.length - 1];
		return last ? Math.max(0, (last.depart.getTime() - day.start.getTime()) / 60_000) : 0;
	});

	const buckets = assignDays(input.pois, input.days, anchorMin);

	const assigned: PlanPoi[] = [];
	const spilled: PlanPoi[] = [];
	buckets.forEach((list, dayIndex) => {
		// Cap meals per day before ordering: geographic clustering happily puts
		// three restaurants in one day, and nobody eats three sit-down meals.
		const byWant = (a: PlanPoi, b: PlanPoi) =>
			(b.priority ?? NEUTRAL_PRIORITY) - (a.priority ?? NEUTRAL_PRIORITY);
		const { route, diners } = split(list);
		// More restaurants than the day has sittings. The least wanted wait for
		// another day rather than crowding out the sights.
		const seatable = diners.sort(byWant).slice(0, MEALS_PER_DAY);
		spilled.push(...diners.slice(MEALS_PER_DAY));

		// Sorted most-wanted-first so that when the day runs out of hours, it is
		// the least wanted stops that fall off the end rather than whichever
		// happened to be furthest along the route.
		// The slots as the real walk will see them, so 2-opt is scoring the day
		// that is actually going to happen.
		const says = input.meals ?? new Map();
		const picked = new Map<string, PlanPoi>();
		for (const meal of MEAL_NAMES) {
			const id = says.get(mealKey(dayIndex, meal))?.poi_id;
			const chosen = id ? input.pois.find((p) => p.poiId === id) : undefined;
			if (chosen) picked.set(meal, chosen);
		}

		const ordered = orderDay(
			route.sort(byWant),
			input.days[dayIndex],
			input.allowedModes,
			input.timezone,
			curves,
			slots,
			travel,
			{ diners: seatable, says, dayIndex, picked }
		);
		ordered.forEach((p, orderIndex) => assigned.push({ ...p, dayIndex, orderIndex }));
		// The meal pass places these; they only need to belong to the day.
		seatable.forEach((p, i) => assigned.push({ ...p, dayIndex, orderIndex: ordered.length + i }));
	});

	let placed = assigned;
	let result = schedule({ ...input, pois: placed, curves, travel });

	// Budgets are an estimate -- minutes of visiting, with a quarter held back
	// for travel -- and a cluster spread across a city spends more on travel
	// than that. When the estimate is wrong the day sheds its last stop, and
	// nothing was checking whether another day could have taken it.
	//
	// So: ask the day that actually got scheduled. Anything it dropped is
	// offered to whichever day has the most room left, and the day is walked
	// again. Bounded, and it stops as soon as a pass places nothing, because a
	// stop that fits nowhere has to be allowed to stay unplaced.
	for (let pass = 0; pass < 3; pass++) {
		const dropped = result.unplaced.filter((u) => u.reason === 'day-full' && !u.poi.pinned);
		if (!dropped.length) break;

		const used = new Map<number, number>();
		for (const day of result.days) {
			const end = day.stops[day.stops.length - 1]?.depart.getTime();
			used.set(day.index, end ? end - input.days[day.index].start.getTime() : 0);
		}
		const roomOn = (i: number) =>
			input.days[i].end.getTime() - input.days[i].start.getTime() - (used.get(i) ?? 0);

		let moved = false;
		for (const { poi } of dropped) {
			const target = input.days
				.map((_, i) => i)
				.filter((i) => i !== poi.dayIndex && input.days[i].usableMin > 0)
				.sort((a, b) => roomOn(b) - roomOn(a))[0];
			if (target === undefined || roomOn(target) < poi.durationMin * 60_000) continue;

			// This visit alone. Matching on the place would carry every other
			// visit to it along, days it was never dropped from included.
			const orderIndex = endOfDay(placed, target);
			placed = placed.map((p) => (p.id === poi.id ? { ...p, dayIndex: target, orderIndex } : p));
			used.set(target, (used.get(target) ?? 0) + poi.durationMin * 60_000);
			moved = true;
		}
		if (!moved) break;
		result = schedule({ ...input, pois: placed, curves, travel });
	}

	return {
		days: result.days,
		unplaced: [
			...result.unplaced,
			...spilled.map((poi) => ({ poi, reason: 'day-full' as const }))
		]
	};
}
