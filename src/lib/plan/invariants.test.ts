import { describe, it, expect } from 'vitest';
import { tripDays, type Trip } from '$lib/trip/days';
import { replan, schedule, type PlanPoi, type PlannedDay } from './planner';

/**
 * Things that must be true of any plan, whatever produced it.
 *
 * Every one of these was false at some point and no test said so: times ran
 * backwards, days were budgeted at an hour, stops were dropped while other
 * days sat empty, and a stop could run a whole meal past the end of its day.
 */
const trip: Trip = {
	hotelName: 'Hotel',
	hotel: { lat: 51.5145, lng: -0.127 },
	timezone: 'Europe/London',
	arrivalAt: '2026-10-02T06:00:00Z',
	departureAt: '2026-10-05T20:00:00Z',
	arrivalPoint: null,
	departurePoint: null,
	arrivalLegs: [],
	departureLegs: [],
	prep: null,
	arrivalBufferMin: 0,
	departureBufferMin: 0,
	bagDropMin: 0,
	dayStart: '09:00',
	dayEnd: '22:00'
};

const poi = (id: string, lat: number, lng: number, extra: Partial<PlanPoi> = {}): PlanPoi => ({
	id,
	name: id,
	lat,
	lng,
	category: 'attraction',
	durationMin: 90,
	priority: 3,
	dayIndex: null,
	orderIndex: null,
	pinned: false,
	...extra
});

const spread = [
	poi('a', 51.5081, -0.0759),
	poi('b', 51.5194, -0.127),
	poi('c', 51.5033, -0.1196),
	poi('d', 51.5138, -0.0984),
	poi('e', 51.5076, -0.0994),
	poi('f', 51.5055, -0.091),
	poi('g', 51.5007, -0.1974),
	poi('h', 51.5027, -0.1954)
];

const forwards = (day: PlannedDay) => {
	for (let i = 1; i < day.stops.length; i++) {
		expect(day.stops[i].arrive.getTime()).toBeGreaterThanOrEqual(
			day.stops[i - 1].depart.getTime()
		);
	}
};

describe('time only moves forwards', () => {
	it('holds for an ordinary plan', () => {
		const result = replan({
			pois: spread,
			days: tripDays(trip),
			allowedModes: ['walk', 'transit'],
			timezone: 'Europe/London'
		});
		result.days.forEach(forwards);
	});

	it('holds when a pin is held earlier than the day can reach it', () => {
		// The pin used to rewind the clock, and every stop after it was timed
		// from a moment already spent.
		const result = schedule({
			pois: [
				poi('long', 51.5081, -0.0759, { dayIndex: 0, orderIndex: 0, durationMin: 180 }),
				poi('held', 51.5194, -0.127, {
					dayIndex: 0,
					orderIndex: 1,
					pinned: true,
					pinnedAt: '2026-10-02T08:30:00.000Z'
				}),
				poi('after', 51.5033, -0.1196, { dayIndex: 0, orderIndex: 2 })
			],
			days: tripDays(trip),
			allowedModes: ['walk', 'transit'],
			timezone: 'Europe/London'
		});
		result.days.forEach(forwards);
	});
});

describe('a day is budgeted as a day', () => {
	it('does not drop a stop while another day sits empty', () => {
		const result = replan({
			pois: spread,
			days: tripDays(trip),
			allowedModes: ['walk', 'transit'],
			timezone: 'Europe/London'
		});

		const dropped = result.unplaced.filter((u) => u.reason === 'day-full');
		if (!dropped.length) return;

		// Anything dropped must not fit anywhere: every day is full enough that
		// its last stop leaves less room than the dropped one needs.
		for (const { poi: p } of dropped) {
			for (const day of result.days) {
				const window = tripDays(trip)[day.index];
				const end = day.stops[day.stops.length - 1]?.depart.getTime() ?? window.start.getTime();
				const room = (window.end.getTime() - end) / 60_000;
				expect(room).toBeLessThan(p.durationMin);
			}
		}
	});
});

describe('one dragged card does not empty the day', () => {
	it('keeps the rest of the day when a stop is held to a time', () => {
		// Every drag records a moment. Seeding a timed pin by its rank rather
		// than its own place put it first and left everything behind it to be
		// dropped -- so dragging one card lost the other four.
		const result = replan({
			pois: [
				poi('a', 51.5081, -0.0759, { dayIndex: 0, orderIndex: 0 }),
				poi('b', 51.5194, -0.127, { dayIndex: 0, orderIndex: 1 }),
				poi('c', 51.5033, -0.1196, { dayIndex: 0, orderIndex: 2 }),
				poi('d', 51.5138, -0.0984, { dayIndex: 0, orderIndex: 3 }),
				poi('dinner', 51.5076, -0.0994, {
					dayIndex: 0,
					orderIndex: 4,
					category: 'restaurant',
					durationMin: 90,
					pinned: true,
					pinnedAt: '2026-10-02T18:00:00.000Z'
				})
			],
			days: tripDays(trip),
			allowedModes: ['walk', 'transit'],
			timezone: 'Europe/London'
		});

		const onPlan = result.days.flatMap((d) => d.stops.map((s) => s.poiId)).filter(Boolean);
		expect(onPlan).toContain('dinner');
		for (const id of ['a', 'b', 'c', 'd']) expect(onPlan).toContain(id);
	});
});

describe('nothing runs past the end of its day unannounced', () => {
	it('warns when a stop and the way home overrun', () => {
		const tight: Trip = { ...trip, dayEnd: '14:00' };
		const result = schedule({
			pois: [
				poi('s1', 51.5081, -0.0759, { dayIndex: 0, orderIndex: 0, durationMin: 60 }),
				poi('s2', 51.5194, -0.127, { dayIndex: 0, orderIndex: 1, durationMin: 120 }),
				poi('s3', 51.5033, -0.1196, { dayIndex: 0, orderIndex: 2, durationMin: 75 })
			],
			days: tripDays(tight),
			allowedModes: ['walk', 'transit'],
			timezone: 'Europe/London'
		});

		const day = result.days[0];
		const end = tripDays(tight)[0].end.getTime();
		for (const stop of day.stops) {
			if (stop.depart.getTime() <= end) continue;
			// Past the end of the day is allowed only when the plan says so.
			expect(stop.warnings.some((w) => w.kind === 'overflow')).toBe(true);
		}
	});
});
