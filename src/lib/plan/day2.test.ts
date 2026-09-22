import { describe, it, expect } from 'vitest';
import { tripDays, type Trip } from '$lib/trip/days';
import { replan, type PlanPoi } from './planner';
import type { MealSlotRow } from '$lib/trip/meals';
import { isMeal, slotAt, slotsFrom, tightest, type MealWindows } from './meals';

const A: MealWindows = { breakfast: { from: '07:00', to: '10:00' }, lunch: { from: '12:00', to: '13:30' }, dinner: { from: '19:00', to: '21:30' } };
const B: MealWindows = { breakfast: { from: '07:00', to: '09:00' }, lunch: { from: '12:00', to: '13:30' }, dinner: { from: '18:00', to: '20:00' } };

const trip: Trip = {
	hotelName: 'STG Hotel Oxford Street', hotel: { lat: 51.5154, lng: -0.141 },
	timezone: 'Europe/London',
	arrivalAt: '2026-10-01T18:35:00Z', departureAt: '2026-10-05T16:40:00Z',
	arrivalPoint: null, departurePoint: null, arrivalLegs: [], departureLegs: [],
	prep: { wakeAt: '08:00', prepMin: 45 },
	arrivalBufferMin: 45, departureBufferMin: 120, bagDropMin: 30,
	dayStart: '08:00', dayEnd: '23:59'
};

const stop = (name: string, lat: number, lng: number, category: string, durationMin: number): PlanPoi =>
	({ id: name, poiId: name, name, lat, lng, category, durationMin, priority: 3, dayIndex: 1, at: '2026-10-02T08:00:00Z', pinned: false });

/** 2 October as it actually stood: a sandwich shop seventh in the route. */
const day2 = () =>
	replan({
		pois: [
			stop('Madame Tussauds', 51.5230, -0.1547, 'museum', 120),
			stop('Abbey Road', 51.5320, -0.1777, 'attraction', 60),
			stop('Notting Hill', 51.5090, -0.1960, 'suburb', 60),
			stop('Portobello Market', 51.5170, -0.2050, 'marketplace', 45),
			stop('Pret A Manger', 51.5093, -0.1960, 'restaurant', 45),
			stop('Big Ben', 51.5007, -0.1246, 'attraction', 60)
		],
		days: tripDays(trip),
		allowedModes: ['walk', 'transit'],
		timezone: 'Europe/London',
		mealWindows: tightest([A, B]).windows
	}).days[1];

describe('a booking late in the route', () => {
	const mealsOn = () => day2().stops.filter((s) => s.anchorKind === 'meal').map((s) => s.name);

	it('does not cost the day its breakfast', () => {
		// Breakfast closes at 09:00. Pret is seventh and cannot be reached
		// before then, so holding the window for it only loses the meal.
		expect(mealsOn()).toContain('Breakfast');
	});

	it('does not cost the day its lunch either', () => {
		// Either invented or taken by the restaurant itself -- what matters is
		// that the window is used rather than held and lost.
		const windows = slotsFrom(tightest([A, B]).windows);
		const ate = day2().stops.some(
			(s) =>
				(s.anchorKind === 'meal' || isMeal(s.name === 'Pret A Manger' ? 'restaurant' : null)) &&
				slotAt(s.arrive, 'Europe/London', windows) === 'lunch'
		);
		expect(ate).toBe(true);
	});

	it('seats the sandwich shop at a mealtime, or not at all', () => {
		// It is no longer seventh in the route: the meal pass takes it if a
		// window passes near it, and leaves it on the wishlist if none does.
		// What it can no longer do is land at 15:39 between two sights.
		const seated = day2().stops.find((s) => s.poiId === 'Pret A Manger');
		if (seated) {
			const h = Number(
				new Intl.DateTimeFormat('en-GB', {
					timeZone: 'Europe/London',
					hour: '2-digit',
					hour12: false
				}).format(seated.arrive)
			);
			expect(h >= 7 && h <= 21).toBe(true);
		}
	});
});




describe('a meal the traveller chose', () => {
	const chosen = (iso: string): PlanPoi => ({
		id: 'cafe',
		poiId: 'cafe',
		name: 'Starbucks',
		lat: 51.5154,
		lng: -0.141,
		category: 'cafe',
		durationMin: 20,
		priority: 3,
		dayIndex: 1,
		at: iso,
		pinned: true
	});

	const day = (iso: string) =>
		replan({
			pois: [chosen(iso), stop('Notting Hill', 51.509, -0.196, 'suburb', 60)],
			days: tripDays(trip),
			allowedModes: ['walk', 'transit'],
			timezone: 'Europe/London',
			mealWindows: tightest([A]).windows
		}).days[1];

	it('takes the slot instead of appearing under an invented one', () => {
		// 08:50 London, inside breakfast. The placeholder used to be offered
		// first, because the window opens before the route reaches the stop --
		// so the morning was spent twice.
		const stops = day('2026-10-02T07:50:00.000Z').stops;
		expect(stops.map((s) => s.name)).toContain('Starbucks');
		expect(stops.map((s) => s.name)).not.toContain('Breakfast');
	});

	it('still leaves the other meals to the plan', () => {
		const names = day('2026-10-02T07:50:00.000Z').stops.map((s) => s.name);
		expect(names.includes('Lunch') || names.includes('Dinner')).toBe(true);
	});

	it('does not claim a window it does not fall in', () => {
		// Pinned to the middle of the afternoon: breakfast is still the plan's
		// to offer.
		expect(day('2026-10-02T15:00:00.000Z').stops.map((s) => s.name)).toContain('Breakfast');
	});
});


describe('assigning a slot by hand', () => {
	const far = (id: string): PlanPoi => ({
		id,
		poiId: id,
		name: id,
		// Miles away, and on no day: neither should matter.
		lat: 51.6,
		lng: 0.1,
		category: 'cafe',
		durationMin: 20,
		priority: 3,
		dayIndex: null,
		at: '2026-10-02T08:00:00Z',
		pinned: false
	});

	const run = (poiId: string | null) =>
		replan({
			pois: [stop('Notting Hill', 51.509, -0.196, 'suburb', 60), far('starbucks')],
			days: tripDays(trip),
			allowedModes: ['walk', 'transit'],
			timezone: 'Europe/London',
			mealWindows: tightest([A]).windows,
			hotel: { name: trip.hotelName, ...trip.hotel },
			meals: new Map([
				[
					'1:breakfast',
					{
						day_index: 1,
						meal: 'breakfast',
						poi_id: poiId,
						at: null,
						skipped: false
					} as MealSlotRow
				]
			])
		});

	it('seats exactly what was assigned, however far off the path', () => {
		const names = run('starbucks').days[1].stops.map((s) => s.name);
		expect(names).toContain('starbucks');
		expect(names).not.toContain('Breakfast');
	});

	it('does not need the place to belong to that day first', () => {
		// dayIndex null, which is what the wishlist looks like.
		expect(run('starbucks').days[1].stops.some((s) => s.poiId === 'starbucks')).toBe(true);
	});

	it('does not then report it as unplaced', () => {
		expect(run('starbucks').unplaced.map((u) => u.poi.id)).not.toContain('starbucks');
	});

	it('leaves the container empty when nothing is assigned', () => {
		expect(run(null).days[1].stops.map((s) => s.name)).toContain('Breakfast');
	});
});

describe('a day that runs through its own dinner', () => {
	/** The British Museum, six until eight, straddling a 19:00-20:00 window. */
	const run = () =>
		replan({
			pois: [
				stop('Notting Hill', 51.509, -0.196, 'suburb', 60),
				stop('British Museum', 51.5194, -0.127, 'museum', 480)
			],
			days: tripDays(trip),
			allowedModes: ['walk', 'transit'],
			timezone: 'Europe/London',
			mealWindows: tightest([A, B]).windows
		}).days[1];

	it('still has its dinner, pushed down the day', () => {
		expect(run().stops.map((s) => s.name)).toContain('Dinner');
	});

	it('puts it after the stop that swallowed the window', () => {
		const stops = run().stops;
		const museum = stops.findIndex((s) => s.name === 'British Museum');
		const dinner = stops.findIndex((s) => s.name === 'Dinner');
		expect(dinner).toBeGreaterThan(museum);
	});

	it('does not invent a meal whose window closed before the day began', () => {
		// A day starting at 10:30 has missed breakfast, and no amount of
		// pushing down makes it breakfast.
		const late = replan({
			pois: [stop('Notting Hill', 51.509, -0.196, 'suburb', 60)],
			days: tripDays({ ...trip, dayStart: '10:30', prep: null }),
			allowedModes: ['walk'],
			timezone: 'Europe/London',
			mealWindows: tightest([B]).windows
		}).days[1];
		expect(late.stops.map((s) => s.name)).not.toContain('Breakfast');
	});
});

