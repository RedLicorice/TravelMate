import { describe, it, expect } from 'vitest';
import { tripDays, type Trip } from '$lib/trip/days';
import { replan, schedule, type PlanPoi } from './planner';
import { chooseMode, leg } from './modes';
import { categoryCrowd, resolveCrowd, type CrowdProvider } from './crowd';

const hotel = { lat: 41.8986, lng: 12.4768 };

const trip: Trip = {
	hotelName: 'Hotel Artemide',
	hotel,
	timezone: 'Europe/Rome',
	arrivalAt: '2026-04-10T06:00:00Z',
	departureAt: '2026-04-12T18:00:00Z',
	arrivalPoint: null,
	departurePoint: null,
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
		expect(result.unplaced.map((p) => p.id)).toEqual(['a']);
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

	it('reports a museum as busy at midday', () => {
		expect(categoryCrowd.busyness('museum', at11, 'Europe/Rome')).toBeGreaterThan(0.8);
	});

	it('reports the same museum as quiet at opening', () => {
		const at9 = new Date('2026-04-10T07:00:00Z'); // 09:00 Rome
		expect(categoryCrowd.busyness('museum', at9, 'Europe/Rome')).toBeLessThan(0.5);
	});

	it('takes the first non-null answer in the chain', () => {
		const stub: CrowdProvider = { name: 'stub', busyness: () => 0.01 };
		expect(resolveCrowd([stub, categoryCrowd], 'museum', at11, 'Europe/Rome')).toBe(0.01);
	});

	it('falls through to the table when a provider returns null', () => {
		const nulls: CrowdProvider = { name: 'nulls', busyness: () => null };
		expect(resolveCrowd([nulls, categoryCrowd], 'museum', at11, 'Europe/Rome')).toBeGreaterThan(0.8);
	});

	it('still resolves when every provider returns null', () => {
		const nulls: CrowdProvider = { name: 'nulls', busyness: () => null };
		expect(resolveCrowd([nulls], 'museum', at11, 'Europe/Rome')).toBeGreaterThan(0);
	});
});
