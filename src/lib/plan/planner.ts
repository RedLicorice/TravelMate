import type { Day, LatLng } from '$lib/trip/days';
import { haversineKm } from './geo';
import { leg, type Leg, type Mode } from './modes';
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
	dayIndex: number | null;
	orderIndex: number | null;
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
 */
export function assignDays(pois: PlanPoi[], days: Day[]): Map<number, PlanPoi[]> {
	const usable = days.map((d, i) => ({ i, min: d.usableMin })).filter((d) => d.min > 0);
	const buckets = new Map<number, PlanPoi[]>();
	days.forEach((_, i) => buckets.set(i, []));
	if (!pois.length || !usable.length) return buckets;

	const labels = kmeans(pois, Math.min(usable.length, pois.length));
	labels.forEach((label, j) => {
		const dayIndex = usable[Math.min(label, usable.length - 1)].i;
		buckets.get(dayIndex)!.push(pois[j]);
	});

	// Rebalance: while a day is over its minute budget and another has slack,
	// move the stop that is geographically closest to the slack day.
	const load = (list: PlanPoi[]) => list.reduce((s, p) => s + p.durationMin, 0);
	const budget = (i: number) => days[i].usableMin * 0.75; // leave room for travel

	for (let guard = 0; guard < pois.length * 2; guard++) {
		const over = usable.find(({ i }) => load(buckets.get(i)!) > budget(i));
		if (!over) break;
		const under = usable
			.filter(({ i }) => i !== over.i && load(buckets.get(i)!) < budget(i))
			.sort((a, b) => load(buckets.get(a.i)!) - load(buckets.get(b.i)!))[0];
		if (!under) break;

		const centre = centroid(buckets.get(under.i)!) ?? at(buckets.get(over.i)![0]);
		const list = buckets.get(over.i)!;
		const moved = list
			.map((p, idx) => ({ p, idx, d: haversineKm(centre, at(p)) }))
			.sort((a, b) => a.d - b.d)[0];
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
	slots: MealSlot[]
): PlanPoi[] {
	if (pois.length < 2) return pois;

	const start = day.fixedStart.at(-1)!.at;
	const remaining = [...pois];
	const route: PlanPoi[] = [];
	let cursor = start;
	while (remaining.length) {
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

	// 2-opt on the real objective: travel minutes plus a soft crowd cost. This
	// is what lets a museum move out of its 11-15 peak, and what stops it moving
	// when the detour costs more than the queue.
	const score = (order: PlanPoi[]) => {
		const sim = walkClock(order, day, allowedModes, timezone, curves, slots);
		return (
			sim.travelMin +
			CROWD_WEIGHT_MIN * sim.crowdSum +
			MEAL_WEIGHT_MIN_PER_HOUR * sim.mealMissHours +
			// Waiting is a real cost, just a much smaller one than eating at the
			// wrong time: prefer the order that arrives closer to the slot.
			0.5 * sim.waitedMin +
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
	slots: MealSlot[]
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
			legIn = leg(cursor, point, allowedModes, terminal || cursorTerminal);
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
		const probe = leg(cursor ?? at(p), at(p), allowedModes, cursorTerminal);
		const finish = clock + (cursor ? probe.minutes : 0) * 60_000 + p.durationMin * 60_000;
		const home = day.fixedEnd[0]
			? leg(at(p), day.fixedEnd[0].at, allowedModes, day.fixedEnd[0].kind === 'terminal').minutes
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
		const result = walkClock(byDay.get(i)!, day, input.allowedModes, input.timezone, curves, slots);
		unplaced.push(...result.overflowed.map((poi) => ({ poi, reason: 'day-full' as const })));
		return { index: i, date: day.date, stops: result.stops, overflowed: result.overflowed };
	});

	return { days, unplaced };
}

/** Steps 1-5. A full reshuffle -- what the Replan control runs. */
export function replan(input: PlanInput): PlanResult {
	const curves = input.curves ?? categoryCurves(input.pois, input.days, input.timezone);
	const slots = slotsFrom(input.mealWindows ?? DEFAULT_WINDOWS);

	// Nothing can be measured from a hotel at 0,0, so say so rather than
	// producing a plan built on a point in the Gulf of Guinea.
	if (input.days.every((d) => d.usableMin === 0)) {
		return {
			days: input.days.map((day, index) => ({
				index,
				date: day.date,
				stops: walkClock([], day, input.allowedModes, input.timezone, curves, slots).stops,
				overflowed: []
			})),
			unplaced: input.pois.map((poi) => ({ poi, reason: 'no-usable-days' as const }))
		};
	}

	const buckets = assignDays(input.pois, input.days);

	const assigned: PlanPoi[] = [];
	const spilled: PlanPoi[] = [];
	buckets.forEach((list, dayIndex) => {
		// Cap meals per day before ordering: geographic clustering happily puts
		// three restaurants in one day, and nobody eats three sit-down meals.
		const meals = list.filter((p) => isMeal(p.category));
		const rest = list.filter((p) => !isMeal(p.category));
		spilled.push(...meals.slice(MEALS_PER_DAY));

		const keep = [...rest, ...meals.slice(0, MEALS_PER_DAY)];
		const ordered = orderDay(keep, input.days[dayIndex], input.allowedModes, input.timezone, curves, slots);
		ordered.forEach((p, orderIndex) => assigned.push({ ...p, dayIndex, orderIndex }));
	});

	const result = schedule({ ...input, pois: assigned, curves });
	return {
		days: result.days,
		unplaced: [
			...result.unplaced,
			...spilled.map((poi) => ({ poi, reason: 'day-full' as const }))
		]
	};
}
