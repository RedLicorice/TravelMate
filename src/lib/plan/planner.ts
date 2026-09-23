import { zonedInstant, type Day, type LatLng } from '$lib/trip/days';
import { haversineKm } from './geo';
import { nearestBranch } from '$lib/poi/branches';
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
	type MealName,
	type MealSlot,
	type MealWindows
} from './meals';

export type PlanPoi = {
	/**
	 * The placement: this visit, on this day, at this time. Two visits to the
	 * same cafe are two of these, and everything that orders, pins, drags or
	 * drops a stop works in these -- because "the cafe" cannot say which of
	 * Tuesday and Thursday is being moved.
	 *
	 * Empty on a card the planner invented itself and nothing has stored yet;
	 * such a card comes back with no placementId, which is what saving gives
	 * one to.
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
	 * a return in the afternoon -- placed by the traveller and walked at the
	 * clock they gave it. It has the hotel's coordinates, a name and a length,
	 * and no wishlist row. A 'meal' is a sitting: it says which meal it is in
	 * `meal`, and either holds the place the traveller chose for it (its
	 * poiId, and that place's coordinates) or is still to decide -- then it
	 * happens wherever the day already is, and takes the time it was given.
	 */
	kind?: 'stop' | 'hotel' | 'chore' | 'meal';
	/** Which sitting a 'meal' card is. */
	meal?: MealName | null;
	/** A meal not had, or a night not at the hotel: no time, not drawn, not invented again. */
	skipped?: boolean;
	name: string;
	lat: number;
	lng: number;
	category: string | null;
	durationMin: number;
	/** 1-5, how much the traveller wants this. 3 when unsaid. */
	priority: number;
	dayIndex: number | null;
	/**
	 * This card's own clock, as an ISO instant. Everything holds one. A day is
	 * its cards in the order their clocks say; a re-time walks each card from
	 * its clock -- never earlier, later when the legs say so -- except a pin
	 * and the traveller's own furniture, which happen exactly then; Replan
	 * writes new ones onto everything it is allowed to move.
	 */
	at: string;
	/** Not read. Position is no longer a concept; the clock orders the day. */
	orderIndex?: number | null;
	/**
	 * Held where the traveller put it -- its day and its clock. Regenerate
	 * reshuffles everything around it rather than moving it.
	 */
	pinned?: boolean;
	/** Not read. A pin holds `at`; there is no second moment to hold. */
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

/**
 * 'blocked' is the one the traveller has to answer.
 *
 * A card they pinned and a piece of the day's own furniture cannot be moved,
 * so when the journeys turn out longer than the plan was built on, something
 * else has to move -- and what moves is not the re-time's to decide. It says
 * which card can no longer be reached and leaves it to them, or to Replan.
 */
export type Warning = { kind: 'crowded' | 'overflow' | 'off-hours' | 'blocked'; message: string };

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
	 * tells them apart. Null for a card the planner invented -- a hotel to
	 * close a day, an empty meal -- and for a meal the traveller put in a slot
	 * by hand, which lives in the slot, not in a placement. After a Replan,
	 * `arrive` is the clock the caller stores on this placement.
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
	 * Where the traveller sleeps. Replan closes every day on a hotel card; a
	 * day without one gets this drawn at its end, and the caller stores it.
	 * Without it a day without a hotel simply ends at its last card.
	 */
	hotel?: { name: string; lat: number; lng: number } | null;
};

const at = (p: { lat: number; lng: number }): LatLng => ({ lat: p.lat, lng: p.lng });

/** Ascending by each card's own clock: the only order a day has. */
const byClock = (a: PlanPoi, b: PlanPoi) => Date.parse(a.at) - Date.parse(b.at);

const OFF_HOURS: Warning = { kind: 'off-hours', message: 'Not really a mealtime' };

/**
 * The furniture of a day: the hotel, or a chore done at it. Placed by the
 * traveller, and the plan's only to walk -- never to reorder, never to drop,
 * never to seat as a meal or to look up in the crowd table.
 */
export const isAnchor = (p: PlanPoi): p is PlanPoi & { kind: 'hotel' | 'chore' } =>
	p.kind === 'hotel' || p.kind === 'chore';

/**
 * Whether a placement stays where the traveller put it: a pin, an anchor, or
 * a meal container. Everything that reorders a day or moves a stop between
 * days asks this rather than `pinned`, so an anchor is held whether or not the
 * caller remembered to pin it. Only a pin also holds its clock.
 */
const stays = (p: PlanPoi) => !!p.pinned || isAnchor(p) || p.kind === 'meal';

/**
 * Whether a card's clock is already decided: a pin, or furniture the traveller
 * placed -- the hotel, a chore, a meal container. Replan arranges the free
 * stops around such a card and never rewrites its time. The one card whose
 * clock is the walk's to give is the closing hotel Replan draws itself, which
 * has no stored row and so no stated time.
 */
const holdsClock = (p: PlanPoi) => !!p.pinned || ((isAnchor(p) || p.kind === 'meal') && p.id !== '');

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
export const PLANNER_VERSION = 5;

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
 * being planned as though the pin were not there. The day's anchors and meal
 * containers are held the same way: they are placements, and the time they
 * take is counted against the day through `load` like any stop's.
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
	// caller is the one to tidy that up. A meal container the same.
	const free = pois.filter((p) => !held.includes(p) && !isAnchor(p) && p.kind !== 'meal');
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
 * The rest of a day as it will actually be walked: the restaurants the meal
 * pass may seat, and the meal cards the day already has -- empty, or holding
 * the place the traveller chose -- so a seated meal keeps the id of its card.
 *
 * Without these, 2-opt scored a day with no meals in it at all and then the
 * real walk seated them -- so the order was chosen against one day and the
 * overflow fell out of another.
 */
type Rest = {
	diners?: PlanPoi[];
	containers?: Map<string, PlanPoi>;
};

const NO_POIS: Map<string, PlanPoi> = new Map();

/**
 * A card the traveller has said is not happening: a meal they are not having
 * (counted as had, so none is offered) or a night away from the hotel. Never
 * walked or drawn, and never put back.
 */
const isSkipped = (p: PlanPoi) => !!p.skipped;

/**
 * Nearest-neighbour from wherever the day begins, then 2-opt against the full
 * schedule cost. An open path, not a loop: the journey cards are never part of
 * it, and the held placements within it keep the order their clocks give them.
 */
export function orderDay(
	pois: PlanPoi[],
	day: Day,
	allowedModes: Mode[],
	timezone: string,
	curves: CrowdCurves,
	slots: MealSlot[],
	travel: TravelTable,
	rest: Rest = {},
	/** Where the traveller is when the day begins, when that is not the hotel. */
	from: LatLng | null = null
): PlanPoi[] {
	const skipped = pois.filter(isSkipped);
	pois = pois.filter((p) => !isSkipped(p));
	if (pois.length < 2) return [...pois, ...skipped];

	// Where the day is when the route begins: the last journey card, on a day
	// that has one. On any other day there is nowhere to measure from until
	// the first placement -- usually the hotel -- and the nearest neighbour to
	// nowhere is simply the first stop offered, which is the most wanted.
	const start = day.fixedStart.at(-1)?.at ?? from;
	// Held placements come out in the order their clocks say, whatever else is
	// true of them; only the free stops are ordered, and they are threaded
	// between the held ones by time. A held card's clock is when it happens.
	const held = pois.filter(stays).sort(byClock);
	const remaining = pois.filter((p) => !stays(p));

	const route: PlanPoi[] = [];
	let cursor = start;
	let clock = day.start.getTime();
	/**
	 * Nearest neighbour from wherever the day stands, for as long as the next
	 * stop and the way on to `next` would be done before `until`.
	 */
	const thread = (until: number, next: PlanPoi | null) => {
		while (remaining.length) {
			let bestI = 0;
			let bestD = Infinity;
			remaining.forEach((p, i) => {
				const d = cursor ? haversineKm(cursor, at(p)) : 0;
				if (d < bestD) {
					bestD = d;
					bestI = i;
				}
			});
			const p = remaining[bestI];
			const done =
				clock +
				((cursor ? leg(cursor, p, allowedModes, false, travel).minutes : 0) + p.durationMin) *
					60_000;
			const onward = next ? leg(p.exitAt ?? p, next, allowedModes, false, travel).minutes : 0;
			if (done + onward * 60_000 > until) break;
			remaining.splice(bestI, 1);
			route.push(p);
			cursor = p.exitAt ?? at(p);
			clock = done;
		}
	};
	// Before a card whose clock is decided go the stops that are done by then.
	// Before the closing hotel Replan drew itself -- the one card with no
	// clock of its own -- goes everything else: the traveller gets home after
	// the last stop, not before.
	for (const h of held) {
		thread(holdsClock(h) ? Date.parse(h.at) : Infinity, h);
		route.push(h);
		const reach =
			clock + (cursor ? leg(cursor, h, allowedModes, false, travel).minutes : 0) * 60_000;
		clock = (holdsClock(h) ? Math.max(reach, Date.parse(h.at)) : reach) + h.durationMin * 60_000;
		cursor = at(h);
	}
	thread(Infinity, null);

	// 2-opt on the real objective: travel minutes plus a soft crowd cost. This
	// is what lets a museum move out of its 11-15 peak, and what stops it moving
	// when the detour costs more than the queue.
	const score = (order: PlanPoi[]) => {
		const sim = walkClock(order, day, allowedModes, timezone, curves, slots, travel, rest);
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
				// the place the seeding gave it.
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
	return [...best, ...skipped];
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
 * every placement in sequence -- the hotel and the chores among them, where
 * the traveller put them -- then the journey out.
 *
 * `arrange` is whether the plan is deciding the day. When it is, a free stop
 * happens when the walk reaches it, meals are offered as their windows open,
 * and what does not fit is spilled for Replan to find another day.
 *
 * When it is not -- a re-time -- nothing is reordered, dropped, seated or
 * invented, and nothing moves earlier than the clock it states. A leg is real
 * time, though: where the walk reaches a free stop after its clock, that stop
 * happens when the traveller actually arrives and the rest of the day moves
 * with it. The two things that never move are a pin and the traveller's own
 * furniture; where the walk cannot reach one of those in time it keeps its
 * clock regardless, and the stop that runs into it is told so.
 */
function walkClock(
	pois: PlanPoi[],
	day: Day,
	allowedModes: Mode[],
	timezone: string,
	curves: CrowdCurves,
	slots: MealSlot[],
	travel: TravelTable,
	rest: Rest = {},
	arrange = true
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
	const diners = rest.diners ?? [];
	const containers = rest.containers ?? NO_POIS;
	/** Meals the day has already had, whether from the wishlist or from us. */
	const served = new Set<string>();
	const unseated = [...diners];

	// A skipped meal is had, in the sense that matters: the day offers no other.
	// It is not walked and not drawn -- no time, no card.
	for (const p of pois) if (isSkipped(p) && p.meal) served.add(p.meal);
	pois = pois.filter((p) => !isSkipped(p));

	if (arrange) {
		// Meals the traveller placed themselves. Their slots are claimed before
		// the day is walked, not when the clock reaches them: the meal pass
		// offers a window as soon as it opens, which is earlier than the route
		// gets to the stop, so a chosen breakfast would otherwise arrive to
		// find an invented one already sitting in it and the morning counted
		// twice.
		//
		// Every meal left in the route holds its clock -- the meal pass owns
		// the rest -- so the time each will be had is known in advance.
		for (const p of pois) {
			if (p.kind === 'meal') {
				if (p.meal) served.add(p.meal);
				continue;
			}
			if (!isMeal(p.category) || !p.pinned) continue;
			const slot = slotAt(new Date(p.at), timezone, slots);
			if (slot) served.add(slot);
		}
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
		/** Held where the traveller put it, which the card says on screen. */
		pinned = false,
		/** Anything else worth saying about this stop. */
		note: Warning | null = null,
		/**
		 * The card's own clock, when it has one. Null means the walk decides:
		 * the card happens when the traveller gets there.
		 */
		at: number | null = null,
		/**
		 * Whether that clock holds. A pin, the traveller's own furniture and a
		 * ticket do: the card happens exactly then, and being unable to reach it
		 * by then is reported rather than quietly fixed. Otherwise the clock is
		 * only a floor -- the traveller waits if they are early, and the card
		 * happens later if the legs before it ran long, because a leg is real
		 * time and the day moves on it.
		 *
		 * Returns whether the traveller cannot get here by the clock they gave.
		 */
		atHolds = true
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
		// A card whose clock holds happens when its clock says. Being early is
		// waiting; being late means the traveller cannot get here by then, and
		// the warning below says so rather than the plan quietly sliding the
		// card. Nothing is moved: the card keeps its stated time and the day
		// carries on from the end of it.
		//
		// A card whose clock is only a floor happens no earlier than it says --
		// arriving early is waiting, not a reason to drag the day backwards --
		// and later when the walk got here later. That is not lateness, it is
		// when the day now happens, and it says nothing.
		const late = at !== null && atHolds && clock > at;
		if (at !== null) clock = atHolds ? at : Math.max(clock, at);
		let arrive = new Date(clock);

		// A meal reached before its slot waits for it rather than being eaten at
		// the wrong hour -- but only if the day can absorb the wait. Otherwise
		// the stop keeps its early time and picks up an off-hours warning below.
		// Only a stop whose time is the walk's to choose.
		if (at === null && !anchor && isMeal(category)) {
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

		// A day whose window is empty -- landing at 19:35 when the traveller's
		// evening ends at 19:00 -- is past its end before it begins. Saying so
		// on every card is noise about something they already know, and hides
		// the cards that are genuinely running long on an ordinary day.
		const dayIsOver = dayEndMs <= day.start.getTime();

		const warnings: Warning[] = [];
		// One overflow warning, not two. A card can both be one the traveller
		// cannot reach in time and run past the end of the day, and saying so
		// twice told the traveller nothing they did not know -- while the
		// screen, which draws warnings keyed by kind, refused to render the
		// trip at all. Not being able to get there is the more particular
		// fact, so it wins.
		// Running past the end is not said on the furniture. The hotel at the
		// end of a day cannot run past the end of the day -- it is where the
		// day ends, and the traveller is asleep in it. Getting back late is
		// something the stops did; the cards that say so are the stops.
		// The journey is not something the traveller can be late for by
		// planning badly: it is the ticket they hold, and its cards read what
		// the ticket reads whatever the day around them does.
		// Nor is furniture ever told that it cannot be reached: the traveller
		// said when it happens, and a plan that cannot make it says so on the
		// stop that runs into it. The caller puts the warning there.
		const ticketed = anchorKind === 'terminal' || anchorKind === 'service';
		// Never on the day's own furniture. Where the hotel is and when the
		// traveller checks in is something they stated, not something the plan
		// worked out, and telling them they cannot reach their own hotel is
		// noise on every card of every day.
		if (late && !dayIsOver && !ticketed && !anchor) {
			warnings.push({
				kind: pinned ? 'blocked' : 'overflow',
				message: pinned
					? 'You cannot get here by then. Replan, or move something.'
					: 'You cannot get here by then'
			});
		} else if (runsLate && !dayIsOver && !anchor) {
			warnings.push({ kind: 'overflow', message: 'Runs past the end of the day' });
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
			if (miss > 0.5) warnings.push(OFF_HOURS);
		}

		stops.push({
			poiId,
			placementId,
			name,
			pinned,
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
		return late;
	};

	// The way in, at the times the tickets say. Every card of a journey sits
	// at the same coordinates, so walking them would give all of them one
	// minute and leave a day ordered by the clock with nothing to tell a
	// flight from the airport it leaves.
	for (const w of day.fixedStart) {
		push(w.name, w.at, w.dwellMin, true, null, null, null, w.kind === 'terminal', null, w.kind, w.timeLabel ?? null, false, false, null, w.startsAt?.getTime() ?? null);
	}

	/**
	 * The meal pass: fill whatever window is open, from the day's own
	 * restaurants where one is near enough and from nothing where none is.
	 *
	 * A placeholder eats where the traveller already is -- the cursor -- so it
	 * costs nothing to reach, which is also true of how people actually choose
	 * lunch. It takes real time, because a day that pretends lunch is free is
	 * lying about how much of it is left.
	 *
	 * Run against a route that is already settled. Restaurants are not part of
	 * that route -- which is the whole point. Leaving them in it let a sandwich
	 * shop decide the shape of a day: the route bent towards it, the clock
	 * stalled waiting for its window, and whichever window it happened to reach
	 * became the meal. A meal is a thing you do near where you already are.
	 *
	 * `until` is the moment the caller is about to spend: a meal is only
	 * offered if its window is open before then, so the day fills in order
	 * rather than collecting three meals at the end. `next` is the index of
	 * the placement about to be walked, so the way home can be priced through
	 * whatever anchors still stand between here and the end of the day. `by`
	 * is that placement's clock when it holds one: the meal has to be over
	 * before it.
	 */
	const offerMeals = (until: number, next: number, patient = false, by = Infinity) => {
		for (const slot of slots) {
			if (served.has(slot.name)) continue;

			// The day's own card for this sitting: empty, or holding the place the
			// traveller chose for it. (A skipped one counted as served above.)
			const card = containers.get(slot.name) ?? null;

			const opens = zonedInstant(day.date, toHHMM(slot.from), timezone).getTime();
			const closes = zonedInstant(day.date, toHHMM(slot.to), timezone).getTime();
			if (opens > until) continue;

			// The window has closed. On the last sweep a meal the day opened
			// before is still had, late, rather than quietly dropped: the
			// British Museum runs from six to eight and takes the whole of
			// dinner with it, and the honest answer is a late dinner, not no
			// dinner at all. A window that had already closed when the day
			// started is a different thing and stays gone.
			const late = closes < clock;
			if (late && !(patient && opens >= day.start.getTime())) continue;

			// Before anything has been walked there is nowhere the traveller
			// already is, so the meal is had where they are about to be. A day
			// the traveller has taken the hotel off still starts somewhere, and
			// breakfast before the first museum is better than no breakfast.
			const here: LatLng | undefined = cursor ?? day.fixedStart[0]?.at ?? pois[next];
			if (!here) continue;

			// A place the traveller put in this slot themselves. It goes in
			// whatever the distance and whatever else is nearer: they chose it.
			let chosen: PlanPoi | null = card?.poiId ? card : null;
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
			// The next card holds its clock: the traveller is idle until then,
			// so waiting for the window costs nothing -- but the meal has to be
			// over before that card, or it makes the card unreachable.
			if (start + minutes * 60_000 > by) continue;
			// Otherwise not worth standing about for while there are still
			// stops to make: skipped now, offered again after the next one, by
			// which time the window is open and there is no gap. At the end of
			// the day there is nothing else to do, so the wait is worth it --
			// otherwise a day that finishes at four has no dinner at all.
			if (by === Infinity && !patient && opens - clock > MAX_MEAL_WAIT_MIN * 60_000) continue;
			// Would this meal, the way home included, run past the end of the
			// day? Then that is the end of it: only a slot the traveller filled
			// goes in regardless, the same as a pinned stop. The one thing a
			// meal may never do is push the journey out past the time on its
			// ticket. On a departure day the day ends exactly where checking in
			// begins, so the same measure answers that.
			const theirs = !!card?.poiId;
			const over = start + (minutes + tailCost(to, next)) * 60_000 > dayEndMs;
			if (over && !theirs) continue;

			// The clock really does move, but a placeholder's wait is not
			// counted against the route: it eats wherever the traveller happens
			// to be, so letting it price orderings would have 2-opt chase meal
			// windows across the city.
			clock = Math.max(clock, start - hop * 60_000);
			served.add(slot.name);

			if (chosen) {
				const i = unseated.indexOf(chosen);
				// A diner is a visit on this day, and the card is that visit. A
				// place the traveller put in the slot is the meal card itself.
				const placementId = i >= 0 ? chosen.id : chosen === card ? card.id || null : null;
				if (i >= 0) unseated.splice(i, 1);
				push(chosen.name, chosenAt, minutes, false, chosen.poiId, placementId, chosen.category, false, null, 'meal', null, over);
			} else {
				// An empty container. It keeps its place and its time, because
				// a meal nobody has chosen yet is still a meal that will happen.
				// Where the day already had one for this sitting, this is that
				// card, re-timed: it keeps the id, so what is stored is updated
				// rather than replaced.
				const note = mealMiss(new Date(start), timezone, [slot]) > 0.5 ? OFF_HOURS : null;
				const id = containers.get(slot.name)?.id ?? null;
				push(MEAL_LABEL[slot.name], here, minutes, true, null, id, null, false, null, 'meal', null, over, false, note);
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
		const anchorKind = isAnchor(p) ? p.kind : p.kind === 'meal' ? 'meal' : null;
		const anchor = anchorKind !== null;
		// Its clock: every card has one on a re-time, and a pin or the
		// traveller's own furniture has one while the plan is arranging the day.
		// Anything else happens when the walk gets there.
		const held = !arrange || holdsClock(p) ? Date.parse(p.at) : null;
		// Whether that clock is the card's to keep. A pin and the traveller's
		// own furniture keep theirs whatever the walk says. On a re-time every
		// other card takes its clock as a floor: it never happens earlier, and
		// a leg that ran longer than the plan was built on pushes it later --
		// and everything after it with it.
		const holds = arrange || holdsClock(p);
		// A block of time the traveller added themselves -- a rest, an errand,
		// a nap -- happens wherever they already are, the same as a meal. Its
		// stored coordinates are a formality. An anchor's are not: the hotel
		// is a place, and getting back to it is a leg.
		// A meal still to decide is had where the day already is; one at a
		// place the traveller chose is had there.
		const where = isAnchor(p)
			? at(p)
			: (p.kind === 'meal' && !p.poiId) || p.category === BLOCK_CATEGORY
				? (cursor ?? at(p))
				: nearestBranch(p, cursor ?? at(p), haversineKm);
		/** When this card would be over: when it happens, plus its length. */
		const ends = () => {
			const leg_ = leg(cursor ?? where, where, allowedModes, cursorTerminal, travel);
			const reach = clock + (cursor ? leg_.minutes : 0) * 60_000;
			const starts = held === null ? reach : holds ? held : Math.max(held, reach);
			return starts + p.durationMin * 60_000;
		};
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
		if (arrange) {
			if (i === closing) offerMeals(dayEndMs, i, true);
			else if (i < closing && p.kind !== 'chore' && (!anchor || cursor)) {
				offerMeals(ends(), i, false, held ?? Infinity);
			}
		}
		const finish = ends();

		// The way home starts from wherever the stop lets the traveller out --
		// measuring it from the entrance would price a cable car's whole span
		// at zero.
		const leaves = p.exitAt ?? where;
		// A stop the traveller pinned is not the planner's to drop. They put it
		// there; it goes in, and if the day runs long the plan says so rather
		// than quietly deciding for them. An anchor the same: there is no plan
		// in which the traveller does not go back to the hotel. And on a
		// re-time nothing at all is dropped: the traveller arranged the day,
		// and a day that is too full should look too full.
		const runsLate = finish + tailCost(leaves, i + 1) * 60_000 > dayEndMs;
		if (arrange && !stays(p)) {
			// A free stop must also be done, and the traveller on their way,
			// before the next card whose clock is decided: the hotel at six is
			// the hotel at six, and a museum that runs into it does not fit this
			// day -- it is spilled, and Replan finds it another.
			let next = i + 1;
			while (next < pois.length && !holdsClock(pois[next])) next++;
			const missesNext =
				next < pois.length &&
				finish + leg(leaves, pois[next], allowedModes, false, travel).minutes * 60_000 >
					Date.parse(pois[next].at);
			if (runsLate || missesNext) {
				overflowed.push(p);
				continue;
			}
		}
		// An empty container had outside its own window says so. Measured
		// against its slot alone, because a dinner at one o'clock is inside
		// lunch and is still not dinner.
		let note: Warning | null = null;
		if (p.kind === 'meal' && held !== null) {
			const slot = slots.find((s) => s.name === p.meal);
			if (slot && mealMiss(new Date(held), timezone, [slot]) > 0.5) note = OFF_HOURS;
		}
		const missed = push(
			p.name,
			where,
			p.durationMin,
			anchor,
			p.poiId,
			p.id || null,
			p.kind === 'meal' ? null : p.category,
			false,
			p.exitAt ?? null,
			anchorKind,
			null,
			runsLate,
			p.pinned ?? false,
			note,
			held,
			holds
		);

		// The traveller cannot be at their own hotel at six if what they put
		// before it runs past six. The furniture keeps its clock and says
		// nothing -- where the hotel is and when they check in is what they
		// told the plan, not something it worked out. The stop that runs into
		// it is the one that does not fit, so that is the card that says so.
		// One overflow warning per card, since the screen draws them by kind.
		if (!arrange && missed && anchor && dayEndMs > day.start.getTime()) {
			const before = stops.at(-2);
			if (before && !before.anchor && !before.warnings.some((w) => w.kind === 'overflow')) {
				before.warnings.push({
					kind: 'blocked',
					message: `You cannot get to ${p.name} after this. Replan, or move something.`
				});
			}
		}
	}

	// Whatever the day never got round to, while there is still room for it --
	// on a day that does not close on an anchor, since one that does has had
	// this sweep already, before going home.
	if (arrange && closing >= pois.length) offerMeals(dayEndMs, pois.length, true);

	// The way out, likewise: the tickets, in the order the tickets say.
	for (const w of day.fixedEnd) {
		push(w.name, w.at, w.dwellMin, true, null, null, null, w.kind === 'terminal', null, w.kind, w.timeLabel ?? null, false, false, null, w.startsAt?.getTime() ?? null);
	}

	return { stops, overflowed, travelMin, crowdSum, mealMissHours, waitedMin };
}

/**
 * A day's cards split three ways: what the route is made of, the restaurants
 * the meal pass may seat, and the empty containers it may re-time.
 *
 * A pinned restaurant or container stays in the route -- the traveller said
 * where and when, and that is not the meal pass's to reconsider.
 */
function split(list: PlanPoi[]): { route: PlanPoi[]; diners: PlanPoi[]; containers: Map<string, PlanPoi> } {
	// A meal card holding a restaurant is already a sitting, not a restaurant
	// waiting for one: it is a container, with its place chosen.
	const diners = list.filter((p) => p.kind !== 'meal' && p.poiId !== null && isMeal(p.category) && !p.pinned);
	const containers = new Map<string, PlanPoi>();
	for (const p of list) if (p.kind === 'meal' && p.meal && !p.pinned && !isSkipped(p)) containers.set(p.meal, p);
	return {
		// A skipped meal stays in the route only so the walk knows the day has
		// had it; the walk drops it before anything is timed.
		route: list.filter((p) => !diners.includes(p) && !(p.kind === 'meal' && !p.pinned && !isSkipped(p))),
		diners,
		containers
	};
}

// ------------------------------------------------------------------ entrypoints

/**
 * A re-time. The cards are walked in the order their clocks say, and the walk
 * fills in the legs, the lengths and what the day costs. Nothing is
 * reordered, dropped, seated or invented -- the traveller arranged this day.
 *
 * Only the times move, and only forwards. A leg is real time: where the walk
 * reaches a card later than its clock -- a routed travel time longer than the
 * estimate the plan was built on, say -- that card happens when the traveller
 * actually arrives, and everything after it shifts by the same difference. An
 * early arrival waits: no card is moved earlier than it says.
 *
 * Two cards never move: one the traveller pinned, and the day's own furniture
 * -- the hotel, a chore, a meal they placed. Those keep their stated clock
 * even when the walk cannot reach them in time, and the cards before them are
 * left alone too; the stop that runs into such a card is told it cannot be
 * made, rather than the plan inventing a fix. The day's limits belong to
 * Replan, which arranges the day itself and may spill what does not fit.
 */
/**
 * `only`, when given, is the days to walk: an edit on one day re-times that
 * day, and the result holds just those days. The rest of the trip did not
 * change and is not walked again.
 */
export function schedule(input: PlanInput, only?: Set<number>): PlanResult {
	const curves = input.curves ?? categoryCurves(places(input.pois), input.days, input.timezone);
	const slots = slotsFrom(input.mealWindows ?? DEFAULT_WINDOWS);
	const travel = input.travel ?? noTravel;
	const byDay = new Map<number, PlanPoi[]>();
	input.days.forEach((_, i) => byDay.set(i, []));
	const unplaced: Unplaced[] = [];

	for (const p of input.pois) {
		if (p.dayIndex !== null && byDay.has(p.dayIndex)) {
			byDay.get(p.dayIndex)!.push(p);
			continue;
		}
		// Furniture off any day belongs to a day the dates have removed, and
		// there is nothing to say about it that would help. A stop off any day
		// has never been through the planner, or points at a day that no
		// longer exists because the dates moved.
		if (isAnchor(p) || p.kind === 'meal') continue;
		unplaced.push({ poi: p, reason: 'not-planned-yet' });
	}

	const days = input.days.flatMap((day, i) => {
		if (only && !only.has(i)) return [];
		const result = walkClock(
			byDay.get(i)!.sort(byClock),
			day,
			input.allowedModes,
			input.timezone,
			curves,
			slots,
			travel,
			{},
			false
		);
		return [{ index: i, date: day.date, stops: result.stops, overflowed: result.overflowed }];
	});

	return { days, unplaced };
}

/**
 * The hotel that closes a day the traveller has not closed themselves. Its
 * clock is the day's end, which puts it after everything else; the walk gives
 * it the moment the traveller actually gets back. No id: the caller stores it.
 */
const closingHotel = (
	hotel: { name: string; lat: number; lng: number },
	day: Day,
	dayIndex: number
): PlanPoi => ({
	id: '',
	poiId: null,
	kind: 'hotel',
	name: hotel.name,
	lat: hotel.lat,
	lng: hotel.lng,
	category: null,
	durationMin: 0,
	priority: NEUTRAL_PRIORITY,
	dayIndex,
	at: day.end.toISOString()
});

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
					input.pois.filter((p) => isAnchor(p) && p.dayIndex === index).sort(byClock),
					day,
					input.allowedModes,
					input.timezone,
					curves,
					slots,
					travel,
					{},
					false
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
		const stops = walkClock([], day, input.allowedModes, input.timezone, curves, [], travel).stops;
		const last = stops[stops.length - 1];
		return last ? Math.max(0, (last.depart.getTime() - day.start.getTime()) / 60_000) : 0;
	});

	const buckets = assignDays(input.pois, input.days, anchorMin);

	// Each day as a sequence, and the rest of what its walk needs. The
	// sequence is Replan's own -- what orderDay chose -- and the walk writes
	// the clocks onto it; nothing here is sorted by a stored time, because
	// the stored times are what Replan is about to replace.
	const routes = new Map<number, PlanPoi[]>();
	const rests = new Map<number, Rest>();
	const spilled: PlanPoi[] = [];
	/** A skipped hotel card in a day's later half: the night after it is spent away. */
	const nightAway = (list: PlanPoi[], day: Day) =>
		list.some(
			(p) => p.kind === 'hotel' && isSkipped(p) && Date.parse(p.at) > (day.start.getTime() + day.end.getTime()) / 2
		);
	buckets.forEach((list, dayIndex) => {
		const day = input.days[dayIndex];
		const byWant = (a: PlanPoi, b: PlanPoi) =>
			(b.priority ?? NEUTRAL_PRIORITY) - (a.priority ?? NEUTRAL_PRIORITY);
		const { route, diners, containers } = split(list);
		// Cap meals per day before ordering: geographic clustering happily puts
		// three restaurants in one day, and nobody eats three sit-down meals.
		// More restaurants than the day has sittings: the least wanted wait
		// for another day rather than crowding out the sights.
		const seatable = diners.sort(byWant).slice(0, MEALS_PER_DAY);
		spilled.push(...diners.slice(MEALS_PER_DAY));

		// The day ends at the hotel the traveller sleeps at. A day whose last
		// anchor is not a hotel -- or whose only hotel is the one it opens on
		// -- gets one drawn at its end. Not a day that ends in a journey out:
		// the traveller has checked out and is at the terminal, and does not
		// sleep at the hotel on the night they fly home.
		// ponytail: a day with only a closing hotel on it gets a second one.
		// Tell them apart by clock against the day's midpoint if it matters.
		const anchors = route.filter(isAnchor).sort(byClock);
		const last = anchors.at(-1);
		// Not on a night the traveller has said they spend away from it.
		if (input.hotel && !day.fixedEnd.length && !nightAway(route, day) && (last?.kind !== 'hotel' || anchors.length < 2)) {
			route.push(closingHotel(input.hotel, day, dayIndex));
		}

		const rest: Rest = { diners: seatable, containers };
		rests.set(dayIndex, rest);
		// After a night away the day starts where the last one ended, not at
		// the hotel: the traveller wakes up wherever they were.
		const before = dayIndex > 0 ? routes.get(dayIndex - 1) : undefined;
		const awake =
			before && nightAway(before, input.days[dayIndex - 1])
				? (before.filter((p) => !isSkipped(p)).at(-1) ?? null)
				: null;
		routes.set(
			dayIndex,
			orderDay(
				route.map((p) => ({ ...p, dayIndex })).sort(byWant),
				day,
				input.allowedModes,
				input.timezone,
				curves,
				slots,
				travel,
				rest,
				awake ? at(awake.exitAt ?? awake) : null
			)
		);
	});

	const walk = (): PlanResult => {
		const unplaced: Unplaced[] = [];
		const days = input.days.map((day, i) => {
			const rest = rests.get(i)!;
			const result = walkClock(
				routes.get(i)!,
				day,
				input.allowedModes,
				input.timezone,
				curves,
				slots,
				travel,
				rest
			);
			unplaced.push(...result.overflowed.map((poi) => ({ poi, reason: 'day-full' as const })));
			// A restaurant no mealtime came near enough to reach. By visit: two
			// visits to the same cafe are two candidates, and seating one for
			// breakfast says nothing about whether the other found a lunch.
			const seated = new Set(result.stops.map((st) => st.placementId));
			unplaced.push(
				...(rest.diners ?? [])
					.filter((d) => !seated.has(d.id))
					.map((poi) => ({ poi, reason: 'no-mealtime' as const }))
			);
			return { index: i, date: day.date, stops: result.stops, overflowed: result.overflowed };
		});
		return { days, unplaced };
	};

	let result = walk();

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

			// This visit alone, off its day and onto the target -- threaded into
			// that day by clock like any other free stop, so it lands between
			// the furniture rather than on top of it.
			const from = routes.get(poi.dayIndex!)!;
			from.splice(from.indexOf(poi), 1);
			routes.set(
				target,
				orderDay(
					[...routes.get(target)!, { ...poi, dayIndex: target }],
					input.days[target],
					input.allowedModes,
					input.timezone,
					curves,
					slots,
					travel,
					rests.get(target)!
				)
			);
			used.set(target, (used.get(target) ?? 0) + poi.durationMin * 60_000);
			moved = true;
		}
		if (!moved) break;
		result = walk();
	}

	return {
		days: result.days,
		unplaced: [
			...result.unplaced,
			...spilled.map((poi) => ({ poi, reason: 'day-full' as const }))
		]
	};
}
