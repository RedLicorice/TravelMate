import type { Day, LatLng } from '$lib/trip/days';
import { haversineKm } from './geo';
import { leg, type Leg, type Mode } from './modes';
import { noTravel, type TravelTable } from './travel';
import { categoryCurves, type CrowdCurves } from './crowd';
import {
	DEFAULT_WINDOWS,
	isMeal,
	MEALS_PER_DAY,
	mealMiss,
	slotsFrom,
	waitUntilSlot,
	type MealSlot,
	type MealWindows
} from './meals';

export type PlanPoi = {
	id: string;
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
};

export type Warning = { kind: 'crowded' | 'overflow' | 'off-hours'; message: string };

/** Why a stop is not on the plan. Surfaced when the traveller taps it. */
export type UnplacedReason =
	| 'not-planned-yet'
	| 'day-full'
	| 'no-usable-days'
	| 'hotel-unknown';

export type Unplaced = { poi: PlanPoi; reason: UnplacedReason };

export const REASON_TEXT: Record<UnplacedReason, string> = {
	'not-planned-yet': 'Added since the last plan. Tap Replan to fit it in.',
	'day-full': 'Every day was already full by the time this came up.',
	'no-usable-days': 'This trip has no day with usable time — check the dates and buffers.',
	'hotel-unknown': 'The hotel has no location, so nothing can be measured from it.'
};

export type PlannedStop = {
	poiId: string | null; // null for an anchor
	name: string;
	at: LatLng;
	arrive: Date;
	depart: Date;
	durationMin: number;
	legIn: Leg | null;
	anchor: boolean;
	busyness: number | null;
	warnings: Warning[];
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
};

const at = (p: { lat: number; lng: number }): LatLng => ({ lat: p.lat, lng: p.lng });

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
 * Minutes of detour worth accepting to move a wanted stop one place earlier in
 * the day. Small: priority decides what gets in and which day it lands on, and
 * only nudges the order once it is there. Making it large would march the
 * traveller back and forth across town in rating order.
 */
const PRIORITY_ORDER_WEIGHT_MIN = 3;

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
 * `anchorMin[i]` is the time day `i` spends on its own anchors -- the airport
 * transfer, the bag drop, the walk home. Omitted, it is assumed free, which is
 * only true of a day whose anchors are the hotel at both ends.
 *
 * Pinned stops are not distributed. They are placed on the day they are already
 * on, and the free stops are clustered around them -- so a pin both keeps its
 * day and spends that day's minutes, which is what stops the rest of the day
 * being planned as though the pin were not there.
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

	const held = pois.filter((p) => p.pinned && p.dayIndex !== null && buckets.has(p.dayIndex));
	for (const p of held) buckets.get(p.dayIndex!)!.push(p);

	const free = pois.filter((p) => !held.includes(p));
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

	for (let guard = 0; guard < pois.length * 2; guard++) {
		const over = usable.find(({ i }) => load(buckets.get(i)!) > budget(i));
		if (!over) break;
		const under = usable
			.filter(({ i }) => i !== over.i && load(buckets.get(i)!) < budget(i))
			.sort((a, b) => load(buckets.get(a.i)!) - load(buckets.get(b.i)!))[0];
		if (!under) break;

		const centre = centroid(buckets.get(under.i)!) ?? at(buckets.get(over.i)![0]);
		const list = buckets.get(over.i)!;
		// Move the least wanted first, and among equals the one closest to where
		// it is going. A full day should shed what the traveller cares least
		// about, not whatever happens to sit nearest the other cluster.
		const moved = list
			.map((p, idx) => ({ p, idx, d: haversineKm(centre, at(p)) }))
			// A pin is the one thing rebalancing may not touch.
			.filter((x) => !x.p.pinned)
			.sort(
				(a, b) =>
					(a.p.priority ?? NEUTRAL_PRIORITY) - (b.p.priority ?? NEUTRAL_PRIORITY) || a.d - b.d
			)[0];
		if (!moved) break;
		list.splice(moved.idx, 1);
		buckets.get(under.i)!.push(moved.p);
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
 * Nearest-neighbour from the day's fixed start, then 2-opt against the full
 * schedule cost. An open path with fixed endpoints, not a loop: the anchors are
 * never swapped.
 */
export function orderDay(
	pois: PlanPoi[],
	day: Day,
	allowedModes: Mode[],
	timezone: string,
	curves: CrowdCurves,
	slots: MealSlot[],
	travel: TravelTable
): PlanPoi[] {
	if (pois.length < 2) return pois;

	const start = day.fixedStart.at(-1)!.at;
	// Pinned stops hold their place; only the rest are ordered. Nearest
	// neighbour from wherever the day currently stands, which for a slot that
	// follows a pin is the pin itself.
	const remaining = pois.filter((p) => !p.pinned);
	const pins = pois
		.filter((p) => p.pinned)
		.sort((a, b) => (a.orderIndex ?? 0) - (b.orderIndex ?? 0));

	const route: PlanPoi[] = [];
	const held = new Map(pins.map((p, i) => [Math.min(p.orderIndex ?? i, pois.length - 1), p]));
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
			const d = haversineKm(cursor, at(p));
			if (d < bestD) {
				bestD = d;
				bestI = i;
			}
		});
		const [next] = remaining.splice(bestI, 1);
		route.push(next);
		cursor = at(next);
	}
	// A pin whose index landed past the end of a shorter day, or two pins
	// claiming one slot: whatever the map could not place still belongs here.
	for (const pin of pins) if (!route.includes(pin)) route.push(pin);
	for (const free of remaining) route.push(free);

	// 2-opt on the real objective: travel minutes plus a soft crowd cost. This
	// is what lets a museum move out of its 11-15 peak, and what stops it moving
	// when the detour costs more than the queue.
	const score = (order: PlanPoi[]) => {
		const sim = walkClock(order, day, allowedModes, timezone, curves, slots, travel);
		return (
			sim.travelMin +
			CROWD_WEIGHT_MIN * sim.crowdSum +
			MEAL_WEIGHT_MIN_PER_HOUR * sim.mealMissHours +
			// Waiting is a real cost, just a much smaller one than eating at the
			// wrong time: prefer the order that arrives closer to the slot.
			0.5 * sim.waitedMin +
			// A wanted stop earlier in the day, when it is nearly free to do so.
			PRIORITY_ORDER_WEIGHT_MIN *
				order.reduce((sum, p, i) => sum + (p.priority ?? NEUTRAL_PRIORITY) * i, 0) +
			// Anything that did not fit is worse than any amount of walking.
			10_000 * sim.overflowed.length
		);
	};

	let best = route;
	let bestScore = score(best);
	let improved = true;
	while (improved) {
		improved = false;
		for (let i = 0; i < best.length - 1; i++) {
			for (let j = i + 1; j < best.length; j++) {
				// Reversing a segment that contains a pin moves the pin. Only
				// free stops are permuted, so every pin keeps the index the
				// seeding gave it.
				if (best.slice(i, j + 1).some((p) => p.pinned)) continue;
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

/** Walk the day's clock: anchor, leg, dwell, leg, ..., anchor. */
function walkClock(
	pois: PlanPoi[],
	day: Day,
	allowedModes: Mode[],
	timezone: string,
	curves: CrowdCurves,
	slots: MealSlot[],
	travel: TravelTable
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

	const push = (
		name: string,
		point: LatLng,
		durationMin: number,
		anchor: boolean,
		poiId: string | null,
		category: string | null,
		terminal: boolean
	) => {
		let legIn: Leg | null = null;
		if (cursor) {
			legIn = leg(cursor, point, allowedModes, terminal || cursorTerminal, travel);
			clock += legIn.minutes * 60_000;
			travelMin += legIn.minutes;
		}
		let arrive = new Date(clock);

		// A meal reached before its slot waits for it rather than being eaten at
		// the wrong hour -- but only if the day can absorb the wait. Otherwise
		// the stop keeps its early time and picks up an off-hours warning below.
		if (!anchor && isMeal(category)) {
			const opens = waitUntilSlot(arrive, timezone, slots);
			if (opens && opens.getTime() + durationMin * 60_000 <= dayEndMs) {
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
		if (busyness !== null && busyness >= 0.8) {
			warnings.push({ kind: 'crowded', message: 'Usually packed at this hour' });
		}
		if (!anchor && isMeal(category)) {
			const miss = mealMiss(arrive, timezone, slots);
			mealMissHours += miss;
			if (miss > 0.5) {
				warnings.push({ kind: 'off-hours', message: 'Not really a mealtime' });
			}
		}

		stops.push({
			poiId,
			name,
			at: point,
			arrive,
			depart,
			durationMin,
			legIn,
			anchor,
			busyness,
			warnings
		});
		cursor = point;
		cursorTerminal = terminal;
	};

	for (const w of day.fixedStart) {
		push(w.name, w.at, w.dwellMin, true, null, null, w.kind === 'terminal');
	}

	const tailMin = day.fixedEnd.reduce((s, w) => s + w.dwellMin, 0);
	for (const p of pois) {
		// Would this stop, plus getting to the day's final anchor, run past the
		// end of the day? If so it does not fit -- and neither will anything
		// after it, since the route is ordered.
		const probe = leg(cursor ?? at(p), at(p), allowedModes, cursorTerminal, travel);
		const finish = clock + (cursor ? probe.minutes : 0) * 60_000 + p.durationMin * 60_000;
		const home = day.fixedEnd[0]
			? leg(at(p), day.fixedEnd[0].at, allowedModes, day.fixedEnd[0].kind === 'terminal', travel)
					.minutes
			: 0;
		if (finish + (home + tailMin) * 60_000 > day.end.getTime()) {
			overflowed.push(p);
			continue;
		}
		push(p.name, at(p), p.durationMin, false, p.id, p.category, false);
	}

	for (const w of day.fixedEnd) {
		push(w.name, w.at, w.dwellMin, true, null, null, w.kind === 'terminal');
	}

	return { stops, overflowed, travelMin, crowdSum, mealMissHours, waitedMin };
}

// ------------------------------------------------------------------ entrypoints

/** Steps 3-5. Respects the day/order the traveller already chose. */
export function schedule(input: PlanInput): PlanResult {
	const curves = input.curves ?? categoryCurves(input.pois, input.days, input.timezone);
	const slots = slotsFrom(input.mealWindows ?? DEFAULT_WINDOWS);
	const travel = input.travel ?? noTravel;
	const byDay = new Map<number, PlanPoi[]>();
	input.days.forEach((_, i) => byDay.set(i, []));
	const unplaced: Unplaced[] = [];

	for (const p of input.pois) {
		if (p.dayIndex === null || !byDay.has(p.dayIndex)) {
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
		const result = walkClock(byDay.get(i)!, day, input.allowedModes, input.timezone, curves, slots, travel);
		unplaced.push(...result.overflowed.map((poi) => ({ poi, reason: 'day-full' as const })));
		return { index: i, date: day.date, stops: result.stops, overflowed: result.overflowed };
	});

	return { days, unplaced };
}

/** Steps 1-5. A full reshuffle -- what the Replan control runs. */
export function replan(input: PlanInput): PlanResult {
	const curves = input.curves ?? categoryCurves(input.pois, input.days, input.timezone);
	const slots = slotsFrom(input.mealWindows ?? DEFAULT_WINDOWS);
	const travel = input.travel ?? noTravel;

	// Nothing can be measured from a hotel at 0,0, so say so rather than
	// producing a plan built on a point in the Gulf of Guinea.
	if (input.days.every((d) => d.usableMin === 0)) {
		return {
			days: input.days.map((day, index) => ({
				index,
				date: day.date,
				stops: walkClock([], day, input.allowedModes, input.timezone, curves, slots, travel).stops,
				overflowed: []
			})),
			unplaced: input.pois.map((poi) => ({ poi, reason: 'no-usable-days' as const }))
		};
	}

	// Price each day's anchors by scheduling it empty: that run already applies
	// the real travel table and mode chooser to the transfers.
	const anchorMin = input.days.map((day) => {
		const stops = walkClock([], day, input.allowedModes, input.timezone, curves, slots, travel).stops;
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
		const meals = list.filter((p) => isMeal(p.category)).sort(byWant);
		const rest = list.filter((p) => !isMeal(p.category));
		spilled.push(...meals.slice(MEALS_PER_DAY));

		// Sorted most-wanted-first so that when the day runs out of hours, it is
		// the least wanted stops that fall off the end rather than whichever
		// happened to be furthest along the route.
		const keep = [...rest.sort(byWant), ...meals.slice(0, MEALS_PER_DAY)];
		const ordered = orderDay(keep, input.days[dayIndex], input.allowedModes, input.timezone, curves, slots, travel);
		ordered.forEach((p, orderIndex) => assigned.push({ ...p, dayIndex, orderIndex }));
	});

	const result = schedule({ ...input, pois: assigned, curves, travel });
	return {
		days: result.days,
		unplaced: [
			...result.unplaced,
			...spilled.map((poi) => ({ poi, reason: 'day-full' as const }))
		]
	};
}
