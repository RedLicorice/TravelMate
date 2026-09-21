import { describe, it, expect } from 'vitest';
import { tripDays, type Trip } from '$lib/trip/days';
import { replan, schedule, REASON_TEXT, type PlanPoi } from './planner';
import { chooseMode, leg, type Mode } from './modes';
import {
	categoryBusyness,
	categoryCrowd,
	categoryCurves,
	crowdKey,
	resolveCurves,
	type CrowdProvider
} from './crowd';
import { DEFAULT_WINDOWS, MEALS_PER_DAY, slotAt, slotsFrom } from './meals';

const hotel = { lat: 41.8986, lng: 12.4768 };

const trip: Trip = {
	hotelName: 'Hotel Artemide',
	hotel,
	timezone: 'Europe/Rome',
	arrivalAt: '2026-04-10T06:00:00Z',
	departureAt: '2026-04-12T18:00:00Z',
	arrivalPoint: null,
	departurePoint: null,
	arrivalLegs: [],
	departureLegs: [],
	prep: null,
	arrivalBufferMin: 45,
	departureBufferMin: 120,
	bagDropMin: 30,
	dayStart: '09:00',
	dayEnd: '19:00'
};

const poi = (id: string, lat: number, lng: number, extra: Partial<PlanPoi> = {}): PlanPoi => ({
	id,
	name: id,
	lat,
	lng,
	category: 'attraction',
	durationMin: 60,
	priority: 3,
	dayIndex: null,
	orderIndex: null,
	...extra
});

const days = tripDays(trip);
const base = { days, allowedModes: ['walk', 'transit'] as const, timezone: 'Europe/Rome' };
const input = (pois: PlanPoi[]) => ({ ...base, allowedModes: [...base.allowedModes], pois });

describe('replan', () => {
	it('is deterministic: the same input always produces the same split', () => {
		const pois = [
			poi('a', 41.89, 12.49),
			poi('b', 41.9, 12.5),
			poi('c', 41.95, 12.4),
			poi('d', 41.96, 12.41)
		];
		const first = replan(input(pois));
		const second = replan(input(pois));
		const ids = (r: typeof first) => r.days.map((d) => d.stops.map((s) => s.poiId).join(','));
		expect(ids(first)).toEqual(ids(second));
	});

	it('places every stop when the days have room', () => {
		const pois = [poi('a', 41.9, 12.48), poi('b', 41.902, 12.482)];
		const result = replan(input(pois));
		const placed = result.days.flatMap((d) => d.stops.filter((s) => s.poiId).map((s) => s.poiId));
		expect(placed.sort()).toEqual(['a', 'b']);
		expect(result.unplaced).toHaveLength(0);
	});

	it('opens and closes each day on its anchors', () => {
		const result = replan(input([poi('a', 41.9, 12.48)]));
		for (const day of result.days) {
			expect(day.stops[0].anchor).toBe(true);
			expect(day.stops.at(-1)!.anchor).toBe(true);
		}
	});

	it('never schedules a stop past the end of its day', () => {
		const pois = Array.from({ length: 8 }, (_, i) => poi(`p${i}`, 41.89 + i * 0.01, 12.47 + i * 0.01));
		const result = replan(input(pois));
		result.days.forEach((day, i) => {
			for (const stop of day.stops) {
				expect(stop.depart.getTime()).toBeLessThanOrEqual(days[i].end.getTime());
			}
		});
	});

	it('leaves stops unplaced rather than overrunning the trip', () => {
		// Twenty three-hour stops cannot fit three short days.
		const pois = Array.from({ length: 20 }, (_, i) =>
			poi(`p${i}`, 41.89 + i * 0.002, 12.47 + i * 0.002, { durationMin: 180 })
		);
		const result = replan(input(pois));
		expect(result.unplaced.length).toBeGreaterThan(0);
	});

	it('gives a day with no usable time no stops', () => {
		const sameDay: Trip = {
			...trip,
			arrivalAt: '2026-04-10T06:00:00Z',
			departureAt: '2026-04-10T09:30:00Z' // 11:30 local minus 2h buffer = 09:30
		};
		const d = tripDays(sameDay);
		const result = replan({ ...base, allowedModes: ['walk'], days: d, pois: [poi('a', 41.9, 12.48)] });
		expect(result.unplaced).toHaveLength(1);
	});

	it('copes with no POIs at all', () => {
		const result = replan(input([]));
		expect(result.unplaced).toHaveLength(0);
		expect(result.days).toHaveLength(days.length);
	});

	it('moves a museum out of its crowded window when the day allows', () => {
		// A single museum, alone in the day: nothing competes, so the crowd cost
		// is the only signal and it should not land in the 11-15 peak.
		const result = replan(input([poi('louvre', 41.9, 12.48, { category: 'museum', durationMin: 90 })]));
		const stop = result.days.flatMap((d) => d.stops).find((s) => s.poiId === 'louvre');
		expect(stop).toBeDefined();
		expect(stop!.busyness).toBeLessThan(0.9);
	});
});

describe('schedule', () => {
	it('respects an assignment the traveller made by hand', () => {
		const pois = [
			poi('a', 41.95, 12.4, { dayIndex: 0, orderIndex: 1 }),
			poi('b', 41.9, 12.48, { dayIndex: 0, orderIndex: 0 })
		];
		const result = schedule(input(pois));
		const ids = result.days[0].stops.filter((s) => s.poiId).map((s) => s.poiId);
		// b before a, because the traveller said so -- even though a is further.
		expect(ids).toEqual(['b', 'a']);
	});

	it('treats an unassigned POI as unplaced rather than inventing a day', () => {
		const result = schedule(input([poi('a', 41.9, 12.48)]));
		expect(result.unplaced.map((u) => u.poi.id)).toEqual(['a']);
	});
});

describe('chooseMode', () => {
	it('walks a short hop', () => {
		expect(chooseMode(0.8, ['walk', 'transit'])).toBe('walk');
	});

	it('prefers a bike over transit in the middle band when allowed', () => {
		expect(chooseMode(3, ['walk', 'bike', 'transit'])).toBe('bike');
	});

	it('never walks or cycles an airport transfer', () => {
		expect(chooseMode(25, ['walk', 'bike', 'transit'], true)).toBe('transit');
		expect(chooseMode(25, ['walk', 'bike', 'car'], true)).toBe('car');
	});

	it('always terminates, even on an empty allow-list', () => {
		expect(chooseMode(3, [])).toBe('walk');
	});

	it('honours the allow-list over the distance band', () => {
		expect(chooseMode(0.5, ['car'])).toBe('car');
	});

	it('makes walking the faster option on a short hop, and transit on a long one', () => {
		// Transit overhead has to be big enough that the planner does not put
		// someone on a bus for a seven-minute stroll. Break-even sits near 1.2km,
		// which is exactly where the walk band ends.
		const a = { lat: 41.9, lng: 12.48 };
		const near = { lat: 41.9025, lng: 12.4825 }; // ~350m
		const far = { lat: 41.93, lng: 12.51 }; // ~3.5km
		expect(leg(a, near, ['transit']).minutes).toBeGreaterThan(leg(a, near, ['walk']).minutes);
		expect(leg(a, far, ['transit']).minutes).toBeLessThan(leg(a, far, ['walk']).minutes);
	});
});

describe('crowd chain', () => {
	const at11 = new Date('2026-04-10T09:00:00Z'); // 11:00 Rome
	const tz = 'Europe/Rome';
	const pois = [{ id: 'm1', category: 'museum' }];
	const days = [{ date: '2026-04-10' }];

	const stub = (level: number): CrowdProvider => ({
		name: 'stub',
		async lookup(requests) {
			return new Map(requests.map((r) => [crowdKey(r.poiId, r.date, r.hour), level]));
		}
	});

	it('reports a museum as busy at midday', () => {
		expect(categoryBusyness('museum', at11, tz)).toBeGreaterThan(0.8);
	});

	it('reports the same museum as quiet at opening', () => {
		const at9 = new Date('2026-04-10T07:00:00Z'); // 09:00 Rome
		expect(categoryBusyness('museum', at9, tz)).toBeLessThan(0.5);
	});

	it('takes the first provider that answers', async () => {
		const curves = await resolveCurves(pois, days, tz, [stub(0.01), categoryCrowd]);
		expect(curves.at('m1', at11, tz)).toBe(0.01);
	});

	it('falls through to the table for what a provider leaves unanswered', async () => {
		const silent: CrowdProvider = { name: 'silent', async lookup() { return new Map(); } };
		const curves = await resolveCurves(pois, days, tz, [silent, categoryCrowd]);
		expect(curves.at('m1', at11, tz)).toBeGreaterThan(0.8);
	});

	it('does not ask a later provider about hours already answered', async () => {
		let asked = 0;
		const counting: CrowdProvider = {
			name: 'counting',
			async lookup(requests) {
				asked += requests.length;
				return new Map();
			}
		};
		// The table answers everything first, so the paid source downstream is
		// asked about nothing -- the reason resolution is batched and ordered.
		await resolveCurves(pois, days, tz, [categoryCrowd, counting]);
		expect(asked).toBe(0);
	});

	it('survives a provider that throws rather than failing the plan', async () => {
		const broken: CrowdProvider = {
			name: 'broken',
			async lookup() {
				throw new Error('scraper blocked');
			}
		};
		const curves = await resolveCurves(pois, days, tz, [broken, categoryCrowd]);
		expect(curves.at('m1', at11, tz)).toBeGreaterThan(0.8);
	});

	it('answers a venue it has never heard of rather than throwing', async () => {
		const curves = await resolveCurves(pois, days, tz);
		expect(curves.at('never-seen', at11, tz)).toBeGreaterThan(0);
	});

	it('feeds the planner: a pre-resolved quiet museum is no longer avoided', () => {
		// Same museum, same hour, but a provider says it is empty. The planner
		// reads the table it was handed, not the category curve.
		const quiet = {
			at: () => 0.05
		};
		const busy = { at: () => 0.95 };
		const museum = poi('m', 41.9, 12.48, { category: 'museum', durationMin: 60 });
		const withQuiet = replan({ ...input([museum]), curves: quiet });
		const withBusy = replan({ ...input([museum]), curves: busy });
		const find = (r: typeof withQuiet) =>
			r.days.flatMap((d) => d.stops).find((s) => s.poiId === 'm');
		expect(find(withQuiet)?.busyness).toBe(0.05);
		expect(find(withBusy)?.busyness).toBe(0.95);
		expect(find(withBusy)?.warnings.some((w) => w.kind === 'crowded')).toBe(true);
		expect(find(withQuiet)?.warnings.some((w) => w.kind === 'crowded')).toBe(false);
	});
});

describe('meals', () => {
	const mealTrip: Trip = { ...trip, arrivalAt: '2026-04-10T04:00:00Z', departureAt: '2026-04-12T22:00:00Z' };
	const mealDays = tripDays(mealTrip);

	const lunchSpot = poi('trattoria', 41.902, 12.482, { category: 'restaurant', durationMin: 75 });
	const sights = [
		poi('forum', 41.8925, 12.4853, { durationMin: 90 }),
		poi('pantheon', 41.8986, 12.4769, { durationMin: 45 }),
		poi('trevi', 41.9009, 12.4833, { durationMin: 30 })
	];

	it('schedules a restaurant inside a meal slot, not wherever the route reaches it', () => {
		const result = replan({
			pois: [...sights, lunchSpot],
			days: mealDays,
			allowedModes: ['walk', 'transit'],
			timezone: 'Europe/Rome'
		});
		const stop = result.days.flatMap((d) => d.stops).find((s) => s.poiId === 'trattoria');
		expect(stop).toBeDefined();
		expect(slotAt(stop!.arrive, 'Europe/Rome', slotsFrom(DEFAULT_WINDOWS))).not.toBeNull();
	});

	it('flags a meal that could not be fitted near a mealtime', () => {
		// Forced: the only day is a sliver of afternoon, well outside any slot.
		const sliver: Trip = {
			...trip,
			arrivalAt: '2026-04-10T13:30:00Z', // 15:30 local
			departureAt: '2026-04-10T18:00:00Z' // 20:00 local, minus 2h buffer = 18:00
		};
		const d = tripDays(sliver);
		const result = replan({
			pois: [poi('dinner', 41.9, 12.48, { category: 'restaurant', durationMin: 60 })],
			days: d,
			allowedModes: ['walk'],
			timezone: 'Europe/Rome'
		});
		const stop = result.days.flatMap((s) => s.stops).find((s) => s.poiId === 'dinner');
		if (stop) {
			expect(stop.warnings.some((w) => w.kind === 'off-hours')).toBe(true);
		} else {
			expect(result.unplaced.map((u) => u.poi.id)).toContain('dinner');
		}
	});

	it('never puts more than one sitting per named meal on a day', () => {
		const manyMeals = Array.from({ length: 6 }, (_, i) =>
			poi(`eat${i}`, 41.9 + i * 0.001, 12.48 + i * 0.001, { category: 'restaurant', durationMin: 60 })
		);
		const result = replan({
			pois: manyMeals,
			days: mealDays,
			allowedModes: ['walk', 'transit'],
			timezone: 'Europe/Rome'
		});
		for (const day of result.days) {
			const meals = day.stops.filter((s) => s.poiId?.startsWith('eat'));
			// Breakfast, lunch, dinner. Two dinners in a day is not a plan.
			expect(meals.length).toBeLessThanOrEqual(MEALS_PER_DAY);
		}
	});
});

describe('unplaced reasons', () => {
	it('says a never-planned stop simply has not been planned', () => {
		const result = schedule(input([poi('a', 41.9, 12.48)]));
		expect(result.unplaced[0].reason).toBe('not-planned-yet');
	});

	it('says a trip with no usable time has no usable days', () => {
		const noTime: Trip = {
			...trip,
			arrivalAt: '2026-04-10T06:00:00Z',
			departureAt: '2026-04-10T08:30:00Z'
		};
		const result = replan({
			pois: [poi('a', 41.9, 12.48)],
			days: tripDays(noTime),
			allowedModes: ['walk'],
			timezone: 'Europe/Rome'
		});
		expect(result.unplaced[0].reason).toBe('no-usable-days');
	});

	it('says a stop that would not fit found every day full', () => {
		const pois = Array.from({ length: 20 }, (_, i) =>
			poi(`p${i}`, 41.89 + i * 0.002, 12.47 + i * 0.002, { durationMin: 180 })
		);
		const result = replan(input(pois));
		expect(result.unplaced.every((u) => u.reason === 'day-full')).toBe(true);
	});

	it('has readable text for every reason', () => {
		for (const r of Object.keys(REASON_TEXT)) {
			expect(REASON_TEXT[r as keyof typeof REASON_TEXT].length).toBeGreaterThan(10);
		}
	});
});

describe('curve resolution keys by local hour', () => {
	it('answers for the local hour, not the UTC one', async () => {
		// The bug this guards: building each request instant as UTC while keying
		// it by local hour puts the whole table two hours out in Europe/Rome, so
		// a museum reads as quiet at its busiest.
		const curves = await resolveCurves(
			[{ id: 'm1', category: 'museum' }],
			[{ date: '2026-04-10' }],
			'Europe/Rome'
		);
		const noonRome = new Date('2026-04-10T10:00:00Z'); // 12:00 Rome, peak
		const nineRome = new Date('2026-04-10T07:00:00Z'); // 09:00 Rome, quiet
		expect(curves.at('m1', noonRome, 'Europe/Rome')).toBeGreaterThan(0.8);
		expect(curves.at('m1', nineRome, 'Europe/Rome')).toBeLessThan(0.5);
	});

	it('agrees with the synchronous table it defaults to', async () => {
		const pois = [{ id: 'm1', category: 'museum' }];
		const days = [{ date: '2026-04-10' }];
		const async_ = await resolveCurves(pois, days, 'Europe/Rome');
		const sync = categoryCurves(pois, days, 'Europe/Rome');
		const at = new Date('2026-04-10T10:00:00Z');
		expect(async_.at('m1', at, 'Europe/Rome')).toBe(sync.at('m1', at, 'Europe/Rome'));
	});
});

describe('priority', () => {
	const roomy: Trip = { ...trip, arrivalAt: '2026-04-10T04:00:00Z', departureAt: '2026-04-12T22:00:00Z' };
	const roomyDays = tripDays(roomy);

	/** Twelve long stops cannot fit three days; something has to give. */
	const tooMany = (priorities: number[]) =>
		priorities.map((priority, i) =>
			poi(`p${i}`, 41.89 + i * 0.004, 12.47 + i * 0.004, { durationMin: 150, priority })
		);

	it('drops the least wanted when not everything fits', () => {
		const pois = tooMany([5, 5, 5, 1, 1, 1, 5, 5, 1, 1, 5, 1]);
		const result = replan({
			pois,
			days: roomyDays,
			allowedModes: ['walk', 'transit'],
			timezone: 'Europe/Rome'
		});
		expect(result.unplaced.length).toBeGreaterThan(0);
		const droppedPriorities = result.unplaced.map((u) => u.poi.priority);
		const placedPriorities = result.days
			.flatMap((d) => d.stops)
			.filter((s) => s.poiId)
			.map((s) => pois.find((p) => p.id === s.poiId)!.priority);
		// The average thing dropped is wanted less than the average thing kept.
		const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
		expect(mean(droppedPriorities)).toBeLessThan(mean(placedPriorities));
	});

	it('keeps a five-star stop over a one-star one', () => {
		const pois = tooMany([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 5]);
		const result = replan({
			pois,
			days: roomyDays,
			allowedModes: ['walk', 'transit'],
			timezone: 'Europe/Rome'
		});
		expect(result.unplaced.map((u) => u.poi.id)).not.toContain('p11');
	});

	it('front-loads the trip: wanted stops land on earlier days', () => {
		// Two geographic clusters, one clearly more wanted than the other.
		const wanted = [0, 1, 2].map((i) =>
			poi(`want${i}`, 41.95 + i * 0.002, 12.55 + i * 0.002, { priority: 5, durationMin: 60 })
		);
		const meh = [0, 1, 2].map((i) =>
			poi(`meh${i}`, 41.85 + i * 0.002, 12.4 + i * 0.002, { priority: 1, durationMin: 60 })
		);
		const result = replan({
			pois: [...meh, ...wanted],
			days: roomyDays,
			allowedModes: ['walk', 'transit'],
			timezone: 'Europe/Rome'
		});
		const dayOf = (id: string) =>
			result.days.findIndex((d) => d.stops.some((s) => s.poiId === id));
		const wantedDays = wanted.map((p) => dayOf(p.id)).filter((d) => d >= 0);
		const mehDays = meh.map((p) => dayOf(p.id)).filter((d) => d >= 0);
		if (wantedDays.length && mehDays.length) {
			const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
			expect(mean(wantedDays)).toBeLessThanOrEqual(mean(mehDays));
		}
	});

	it('leaves an unrated stop in the middle, not at the bottom', () => {
		// Not having said yet is not the same as not caring.
		const pois = [
			poi('low', 41.9, 12.48, { priority: 1, durationMin: 150 }),
			poi('unsaid', 41.902, 12.482, { priority: 3, durationMin: 150 }),
			poi('high', 41.904, 12.484, { priority: 5, durationMin: 150 })
		];
		const result = replan({
			pois,
			days: [roomyDays[0]],
			allowedModes: ['walk'],
			timezone: 'Europe/Rome'
		});
		const dropped = result.unplaced.map((u) => u.poi.id);
		if (dropped.length) expect(dropped).not.toContain('high');
	});

	it('does not reorder a day purely by rating', () => {
		// Priority nudges; it must not march the traveller across town in
		// rating order. The far five-star should not come before the near one.
		const pois = [
			poi('near', 41.899, 12.477, { priority: 4, durationMin: 30 }),
			poi('far', 41.95, 12.55, { priority: 5, durationMin: 30 })
		];
		const result = replan({
			pois,
			days: [roomyDays[0]],
			allowedModes: ['walk', 'transit'],
			timezone: 'Europe/Rome'
		});
		const ids = result.days[0].stops.filter((s) => s.poiId).map((s) => s.poiId);
		expect(ids[0]).toBe('near');
	});
});

describe('arrival day capacity', () => {
	const trip: Trip = {
		hotelName: 'Hotel',
		hotel: { lat: 51.5145, lng: -0.127 },
		timezone: 'Europe/London',
		arrivalAt: '2026-10-02T13:00:00Z',
		departureAt: '2026-10-05T09:00:00Z',
		arrivalPoint: { name: 'Stansted', at: { lat: 51.886, lng: 0.2389 } },
		departurePoint: { name: 'Stansted', at: { lat: 51.886, lng: 0.2389 } },
		arrivalLegs: [],
		departureLegs: [],
		prep: null,
		arrivalBufferMin: 45,
		departureBufferMin: 120,
		bagDropMin: 30,
		dayStart: '09:00',
		dayEnd: '19:00'
	};
	const poi = (id: string, lat: number, lng: number): PlanPoi => ({
		id,
		name: id,
		lat,
		lng,
		category: 'attraction',
		durationMin: 90,
		priority: 3,
		dayIndex: null,
		orderIndex: null
	});

	// The arrival day's window looks usable -- 255 minutes -- but the airport
	// transfer and bag drop eat nearly all of it. Budgeting off the raw window
	// handed that day two stops it could never reach, and they were dropped
	// even though the following days had hours to spare.
	it('does not drop stops on days that still have room', () => {
		const days = tripDays(trip);
		expect(days[0].usableMin).toBeGreaterThan(0);

		const pois = [
			poi('tower', 51.5081, -0.0759),
			poi('museum', 51.5194, -0.127),
			poi('eye', 51.5033, -0.1196),
			poi('stpauls', 51.5138, -0.0984),
			poi('tate', 51.5076, -0.0994),
			poi('borough', 51.5055, -0.091)
		];
		const result = replan({
			pois,
			days,
			allowedModes: ['walk', 'transit'],
			timezone: 'Europe/London'
		});

		expect(result.unplaced).toEqual([]);
	});
});

describe('pinned stops', () => {
	const pinTrip: Trip = {
		hotelName: 'Hotel',
		hotel: { lat: 51.5145, lng: -0.127 },
		timezone: 'Europe/London',
		arrivalAt: '2026-10-02T06:00:00Z',
		departureAt: '2026-10-04T20:00:00Z',
		arrivalPoint: null,
		departurePoint: null,
		arrivalLegs: [],
		departureLegs: [],
		prep: null,
		arrivalBufferMin: 0,
		departureBufferMin: 0,
		bagDropMin: 0,
		dayStart: '09:00',
		dayEnd: '19:00'
	};
	const place = (id: string, lat: number, lng: number, extra: Partial<PlanPoi> = {}): PlanPoi => ({
		id,
		name: id,
		lat,
		lng,
		category: 'attraction',
		durationMin: 60,
		priority: 3,
		dayIndex: null,
		orderIndex: null,
		...extra
	});

	// Far east, far west: geography alone would never put these together, which
	// is what makes them a fair test of whether the pin actually held.
	const east = (id: string, extra: Partial<PlanPoi> = {}) => place(id, 51.5081, -0.0759, extra);
	const west = (id: string, extra: Partial<PlanPoi> = {}) => place(id, 51.5007, -0.1974, extra);

	const dayOfIn = (result: ReturnType<typeof replan>, id: string) =>
		result.days.find((d) => d.stops.some((s) => s.poiId === id))?.index ?? null;
	const orderIn = (result: ReturnType<typeof replan>, dayIndex: number) =>
		result.days[dayIndex].stops.filter((s) => s.poiId).map((s) => s.poiId);

	it('keeps a pinned stop on the day it was pinned to', () => {
		const days = tripDays(pinTrip);
		const pois = [
			// Pinned to day 1 despite sitting in the middle of day 0's cluster.
			east('pinned', { dayIndex: 1, orderIndex: 0, pinned: true }),
			east('e1'),
			east('e2'),
			west('w1'),
			west('w2')
		];
		const result = replan({ pois, days, allowedModes: ['walk', 'transit'], timezone: 'Europe/London' });
		expect(dayOfIn(result, 'pinned')).toBe(1);
	});

	it('keeps a pinned stop at the place in the day it was pinned to', () => {
		const days = tripDays(pinTrip);
		const pois = [
			west('first', { dayIndex: 0, orderIndex: 0, pinned: true }),
			east('e1', { dayIndex: 0, orderIndex: 1 }),
			east('e2', { dayIndex: 0, orderIndex: 2 }),
			east('e3', { dayIndex: 0, orderIndex: 3 })
		];
		const result = replan({ pois, days, allowedModes: ['walk'], timezone: 'Europe/London' });
		// Nearest-neighbour from the hotel would never open in the far west.
		expect(orderIn(result, 0)[0]).toBe('first');
	});

	it('plans the free stops around the pin rather than ignoring it', () => {
		const days = tripDays(pinTrip);
		const pois = [
			east('pinned', { dayIndex: 0, orderIndex: 0, pinned: true }),
			east('e1'),
			west('w1')
		];
		const result = replan({ pois, days, allowedModes: ['walk', 'transit'], timezone: 'Europe/London' });
		// It is on the plan exactly once, and the others found homes too.
		const all = result.days.flatMap((d) => d.stops.map((s) => s.poiId)).filter(Boolean);
		expect(all.filter((id) => id === 'pinned')).toHaveLength(1);
		expect(result.unplaced).toEqual([]);
	});

	it('leaves an unpinned trip planned exactly as before', () => {
		const days = tripDays(pinTrip);
		const pois = [east('e1'), east('e2'), west('w1'), west('w2')];
		const input = { pois, days, allowedModes: ['walk', 'transit'] as Mode[], timezone: 'Europe/London' };
		expect(replan(input)).toEqual(replan(input));
	});
});

describe('a pin the day cannot fit', () => {
	it('is reported as unplaced but keeps its pin, so the caller can leave it be', () => {
		const tight: Trip = {
			hotelName: 'Hotel',
			hotel: { lat: 51.5145, lng: -0.127 },
			timezone: 'Europe/London',
			arrivalAt: '2026-10-02T06:00:00Z',
			departureAt: '2026-10-02T20:00:00Z',
			arrivalPoint: null,
			departurePoint: null,
			arrivalLegs: [],
			departureLegs: [],
			prep: null,
			arrivalBufferMin: 0,
			departureBufferMin: 0,
			bagDropMin: 0,
			// Half an hour of usable day, and a stop that wants eight times that.
			dayStart: '09:00',
			dayEnd: '09:30'
		};
		const days = tripDays(tight);
		const result = replan({
			pois: [
				{
					id: 'long',
					name: 'long',
					lat: 51.5081,
					lng: -0.0759,
					category: 'attraction',
					durationMin: 240,
					priority: 3,
					dayIndex: 0,
					orderIndex: 0,
					pinned: true
				}
			],
			days,
			allowedModes: ['walk'],
			timezone: 'Europe/London'
		});
		const [out] = result.unplaced;
		expect(out?.reason).toBe('day-full');
		expect(out?.poi.pinned).toBe(true);
	});
});

describe('a stop you leave from somewhere else', () => {
	const cableTrip: Trip = {
		hotelName: 'Hotel',
		hotel: { lat: 51.5145, lng: -0.127 },
		timezone: 'Europe/London',
		arrivalAt: '2026-10-02T06:00:00Z',
		departureAt: '2026-10-02T21:00:00Z',
		arrivalPoint: null,
		departurePoint: null,
		arrivalLegs: [],
		departureLegs: [],
		prep: null,
		arrivalBufferMin: 0,
		departureBufferMin: 0,
		bagDropMin: 0,
		dayStart: '09:00',
		dayEnd: '20:00'
	};
	// The IFS Cloud cable car: board at the Greenwich Peninsula, step off at
	// the Royal Docks, a kilometre away across the river.
	const north = { lat: 51.5083, lng: 0.0184 };
	const south = { lat: 51.5017, lng: 0.0083 };

	const cableCar = (exitAt: { lat: number; lng: number } | null): PlanPoi => ({
		id: 'cable',
		name: 'Cable car',
		lat: south.lat,
		lng: south.lng,
		category: 'attraction',
		durationMin: 20,
		priority: 3,
		dayIndex: 0,
		orderIndex: 0,
		exitAt
	});
	const afterwards: PlanPoi = {
		id: 'docks',
		name: 'Royal Docks',
		lat: 51.5095,
		lng: 0.0215,
		category: 'attraction',
		durationMin: 30,
		priority: 3,
		dayIndex: 0,
		orderIndex: 1
	};

	const legAfter = (exitAt: { lat: number; lng: number } | null) => {
		const result = schedule({
			pois: [cableCar(exitAt), afterwards],
			days: tripDays(cableTrip),
			allowedModes: ['walk', 'transit'],
			timezone: 'Europe/London'
		});
		return result.days[0].stops.find((s) => s.poiId === 'docks')!.legIn!;
	};

	it('measures the next leg from the exit, not the entrance', () => {
		// The docks are near the north terminal and far from the south one, so
		// the leg out has to get markedly shorter once the exit is known.
		expect(legAfter(north).km).toBeLessThan(legAfter(null).km);
	});

	it('carries the exit point onto the planned stop', () => {
		const result = schedule({
			pois: [cableCar(north)],
			days: tripDays(cableTrip),
			allowedModes: ['walk'],
			timezone: 'Europe/London'
		});
		expect(result.days[0].stops.find((s) => s.poiId === 'cable')!.exitAt).toEqual(north);
	});

	it('treats no exit point as ending where it started', () => {
		const result = schedule({
			pois: [cableCar(null)],
			days: tripDays(cableTrip),
			allowedModes: ['walk'],
			timezone: 'Europe/London'
		});
		expect(result.days[0].stops.find((s) => s.poiId === 'cable')!.exitAt).toBeNull();
	});
});

describe('a leg that goes nowhere', () => {
	const here = { lat: 51.886, lng: 0.2389 };

	it('costs nothing, whatever mode was chosen', () => {
		expect(leg(here, here, ['transit', 'walk'], true)).toEqual({
			mode: 'transit',
			minutes: 0,
			km: 0
		});
	});

	it('does not pick up the transit overhead', () => {
		// The overhead is a flat allowance for reaching the stop and waiting.
		// Standing still involves neither.
		expect(leg(here, { ...here }, ['transit'], true).minutes).toBe(0);
	});

	it('still costs something for a leg that does go somewhere', () => {
		expect(leg(here, { lat: 51.5145, lng: -0.127 }, ['transit'], true).minutes).toBeGreaterThan(0);
	});
});

describe('rating does not buy detours', () => {
	const cityTrip: Trip = {
		hotelName: 'Hotel',
		hotel: { lat: 51.5145, lng: -0.127 },
		timezone: 'Europe/London',
		arrivalAt: '2026-10-02T06:00:00Z',
		departureAt: '2026-10-03T21:00:00Z',
		arrivalPoint: null,
		departurePoint: null,
		arrivalLegs: [],
		departureLegs: [],
		prep: null,
		arrivalBufferMin: 0,
		departureBufferMin: 0,
		bagDropMin: 0,
		dayStart: '09:00',
		dayEnd: '19:00'
	};

	/** Five places along one road, west to east, so the short route is obvious. */
	const along = (i: number, priority: number): PlanPoi => ({
		id: `s${i}`,
		name: `s${i}`,
		lat: 51.5145,
		lng: -0.19 + i * 0.02,
		category: 'attraction',
		durationMin: 45,
		priority,
		dayIndex: null,
		orderIndex: null
	});

	const travelOf = (priorities: number[]) =>
		replan({
			pois: priorities.map((p, i) => along(i, p)),
			days: tripDays(cityTrip),
			allowedModes: ['walk', 'transit'],
			timezone: 'Europe/London'
		})
			.days.flatMap((d) => d.stops)
			.reduce((sum, s) => sum + (s.legIn?.minutes ?? 0), 0);

	it('walks no further to put the wanted stops first', () => {
		// Rating the road east-to-west used to be worth about a hundred minutes
		// of pretend cost across five stops, so 2-opt paid for rating order
		// with a real detour back down the road.
		expect(travelOf([1, 2, 3, 4, 5])).toBeLessThanOrEqual(travelOf([3, 3, 3, 3, 3]) + 5);
	});

	it('is the same however the ratings fall', () => {
		const flat = travelOf([3, 3, 3, 3, 3]);
		expect(travelOf([5, 4, 3, 2, 1])).toBeLessThanOrEqual(flat + 5);
		expect(travelOf([1, 5, 1, 5, 1])).toBeLessThanOrEqual(flat + 5);
	});
});

describe('meals the plan supplies itself', () => {
	const mealTrip: Trip = {
		hotelName: 'Hotel',
		hotel: { lat: 51.5145, lng: -0.127 },
		timezone: 'Europe/London',
		arrivalAt: '2026-10-02T05:00:00Z',
		departureAt: '2026-10-02T21:30:00Z',
		arrivalPoint: null,
		departurePoint: null,
		arrivalLegs: [],
		departureLegs: [],
		prep: null,
		arrivalBufferMin: 0,
		departureBufferMin: 0,
		bagDropMin: 0,
		dayStart: '08:00',
		dayEnd: '22:00'
	};

	const sight = (id: string, durationMin = 60): PlanPoi => ({
		id,
		name: id,
		lat: 51.5081,
		lng: -0.0759,
		category: 'attraction',
		durationMin,
		priority: 3,
		dayIndex: 0,
		orderIndex: Number(id.slice(1)),
		pinned: false
	});

	const mealsOn = (result: ReturnType<typeof schedule>) =>
		result.days[0].stops.filter((s) => s.anchorKind === 'meal').map((s) => s.name);

	const run = (pois: PlanPoi[]) =>
		schedule({
			pois,
			days: tripDays(mealTrip),
			allowedModes: ['walk', 'transit'],
			timezone: 'Europe/London'
		});

	it('offers each meal once, in its own window', () => {
		const result = run([sight('s0'), sight('s1'), sight('s2')]);
		expect(mealsOn(result)).toEqual(['Breakfast', 'Lunch', 'Dinner']);

		for (const stop of result.days[0].stops.filter((s) => s.anchorKind === 'meal')) {
			expect(slotAt(stop.arrive, 'Europe/London', slotsFrom(DEFAULT_WINDOWS))).not.toBeNull();
		}
	});

	it('takes real time, so the day is not a lie about what is left', () => {
		const lunch = run([sight('s0')]).days[0].stops.find((s) => s.name === 'Lunch')!;
		expect(lunch.durationMin).toBe(60);
		expect(lunch.depart.getTime() - lunch.arrive.getTime()).toBe(60 * 60_000);
	});

	it('costs nothing to reach: you eat where you already are', () => {
		const stops = run([sight('s0')]).days[0].stops;
		const lunch = stops.find((s) => s.name === 'Lunch')!;
		expect(lunch.legIn?.minutes ?? 0).toBe(0);
	});

	it('steps aside for a restaurant from the wishlist', () => {
		const restaurant: PlanPoi = {
			...sight('s1', 75),
			id: 'trattoria',
			name: 'Trattoria',
			category: 'restaurant',
			orderIndex: 1
		};
		const result = run([sight('s0'), restaurant, sight('s2')]);
		const names = result.days[0].stops.map((s) => s.name);

		expect(names).toContain('Trattoria');
		// Whichever window it landed in is filled; the plan does not offer a
		// second sitting for the same meal.
		const served = result.days[0].stops.find((s) => s.poiId === 'trattoria')!;
		const slot = slotAt(served.arrive, 'Europe/London', slotsFrom(DEFAULT_WINDOWS));
		if (slot) {
			expect(mealsOn(result)).not.toContain(slot[0].toUpperCase() + slot.slice(1));
		}
	});

	it('offers nothing on a day too short to reach a window', () => {
		const brief: Trip = { ...mealTrip, dayStart: '10:30', dayEnd: '11:30' };
		const result = schedule({
			pois: [],
			days: tripDays(brief),
			allowedModes: ['walk'],
			timezone: 'Europe/London'
		});
		expect(mealsOn(result)).toEqual([]);
	});
});
