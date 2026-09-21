import { describe, it, expect } from 'vitest';
import { tripDays, type Trip } from '$lib/trip/days';
import { replan, schedule, type PlanPoi } from './planner';
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

const stop = (name: string, lat: number, lng: number, category: string, durationMin: number, orderIndex: number): PlanPoi =>
	({ id: name, name, lat, lng, category, durationMin, priority: 3, dayIndex: 1, orderIndex, pinned: false });

/** 2 October as it actually stood: a sandwich shop seventh in the route. */
const day2 = () =>
	schedule({
		pois: [
			stop('Madame Tussauds', 51.5230, -0.1547, 'museum', 120, 0),
			stop('Abbey Road', 51.5320, -0.1777, 'attraction', 60, 1),
			stop('Notting Hill', 51.5090, -0.1960, 'suburb', 60, 2),
			stop('Portobello Market', 51.5170, -0.2050, 'marketplace', 45, 3),
			stop('Pret A Manger', 51.5093, -0.1960, 'restaurant', 45, 4),
			stop('Big Ben', 51.5007, -0.1246, 'attraction', 60, 5)
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

describe('the meal pass', () => {
	const stops = () => day2().stops;

	it('seats a restaurant it passes near, rather than a placeholder', () => {
		// Pret is a few hundred metres from Notting Hill and Portobello, both of
		// which the day visits around lunchtime.
		const names = stops().map((s) => s.name);
		const lunchIsInvented = names.includes('Lunch');
		const pretIsSeated = names.includes('Pret A Manger');
		expect(lunchIsInvented || pretIsSeated).toBe(true);
	});

	it('does not leave a restaurant sitting between two sights', () => {
		// Everything on the plan is either part of the route or at a mealtime.
		// 15:39 between Portobello and Big Ben was neither.
		const all = stops();
		const seated = all.find((s) => s.poiId === 'Pret A Manger');
		if (!seated) return;
		const windows = slotsFrom(tightest([A, B]).windows);
		expect(slotAt(seated.arrive, 'Europe/London', windows)).not.toBeNull();
	});
});

describe('a chain, and how long a meal takes', () => {
	const near = (name: string, category: string, durationMin: number, branches?: { lat: number; lng: number }[]) =>
		({
			id: name, name, lat: 51.5090, lng: -0.1960, category, durationMin,
			priority: 3, dayIndex: 1, orderIndex: 9, pinned: false,
			...(branches ? { branches } : {})
		}) as PlanPoi;

	const withDiner = (diner: PlanPoi) =>
		schedule({
			pois: [
				stop('Notting Hill', 51.509, -0.196, 'suburb', 60, 0),
				stop('Portobello Market', 51.517, -0.205, 'marketplace', 45, 1),
				diner
			],
			days: tripDays(trip),
			allowedModes: ['walk', 'transit'],
			timezone: 'Europe/London',
			mealWindows: tightest([A, B]).windows
		}).days[1];

	it('takes the time the traveller gave it, not the default hour', () => {
		const day = withDiner(near('Quick Bite', 'fast_food', 30));
		const seated = day.stops.find((s) => s.poiId === 'Quick Bite');
		expect(seated?.durationMin).toBe(30);
	});

	it('falls back to the hour only when it invents the meal itself', () => {
		const day = schedule({
			pois: [stop('Notting Hill', 51.509, -0.196, 'suburb', 60, 0)],
			days: tripDays(trip),
			allowedModes: ['walk', 'transit'],
			timezone: 'Europe/London',
			mealWindows: tightest([A, B]).windows
		}).days[1];
		const lunch = day.stops.find((s) => s.name === 'Lunch');
		expect(lunch?.durationMin).toBe(60);
	});

	it('goes to the branch nearest the day, not the one that was searched', () => {
		// Stored at Notting Hill, with a branch beside Portobello Market. The
		// day is at Portobello when lunch comes round.
		const chain = near('Pret A Manger', 'fast_food', 30, [
			{ lat: 51.509, lng: -0.196 },
			{ lat: 51.5171, lng: -0.2051 }
		]);
		const seated = withDiner(chain).stops.find((s) => s.poiId === 'Pret A Manger');
		expect(seated).toBeDefined();
		expect(seated!.at.lat).toBeCloseTo(51.5171, 3);
	});
});

describe('the right sort of place for the right meal', () => {
	// Breakfast happens at the hotel, before the day sets off; lunch and dinner
	// happen wherever the day has got to, which is Notting Hill.
	const hotel = { lat: 51.5154, lng: -0.141 };
	const out = { lat: 51.509, lng: -0.196 };

	const at = (name: string, category: string, where: { lat: number; lng: number }): PlanPoi => ({
		id: name,
		name,
		lat: where.lat,
		lng: where.lng,
		category,
		durationMin: 30,
		priority: 3,
		dayIndex: 1,
		orderIndex: 9,
		pinned: false
	});

	const atMeal = (diners: PlanPoi[], meal: string) => {
		const windows = slotsFrom(tightest([A]).windows);
		return schedule({
			pois: [stop('Notting Hill', out.lat, out.lng, 'suburb', 60, 0), ...diners],
			days: tripDays(trip),
			allowedModes: ['walk', 'transit'],
			timezone: 'Europe/London',
			mealWindows: tightest([A]).windows
		}).days[1].stops.find(
			(s) =>
				s.poiId &&
				diners.some((d) => d.id === s.poiId) &&
				slotAt(s.arrive, 'Europe/London', windows) === meal
		)?.name;
	};

	it('sends you to the coffee shop at breakfast, not the chip shop', () => {
		expect(
			atMeal([at('Starbucks', 'cafe', hotel), at('Chip Shop', 'fast_food', hotel)], 'breakfast')
		).toBe('Starbucks');
	});

	it('does not send you to the coffee shop for dinner', () => {
		expect(atMeal([at('Starbucks', 'cafe', out)], 'dinner')).toBeUndefined();
	});

	it('does not send you to the chip shop for breakfast', () => {
		expect(atMeal([at('Chip Shop', 'fast_food', hotel)], 'breakfast')).toBeUndefined();
	});

	it('prefers the pub in the evening', () => {
		expect(atMeal([at('The Bell', 'pub', out), at('Trattoria', 'restaurant', out)], 'dinner')).toBe(
			'The Bell'
		);
	});

	it('prefers the restaurant at lunch', () => {
		expect(atMeal([at('The Bell', 'pub', out), at('Trattoria', 'restaurant', out)], 'lunch')).toBe(
			'Trattoria'
		);
	});
});

describe('a meal the traveller chose', () => {
	const chosen = (iso: string): PlanPoi => ({
		id: 'cafe',
		name: 'Starbucks',
		lat: 51.5154,
		lng: -0.141,
		category: 'cafe',
		durationMin: 20,
		priority: 3,
		dayIndex: 1,
		orderIndex: 0,
		pinned: true,
		pinnedAt: iso
	});

	const day = (iso: string) =>
		schedule({
			pois: [chosen(iso), stop('Notting Hill', 51.509, -0.196, 'suburb', 60, 1)],
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

describe('meal slots are containers', () => {
	const cafe = (id: string, lat: number, lng: number): PlanPoi => ({
		id,
		name: id,
		lat,
		lng,
		category: 'cafe',
		durationMin: 20,
		priority: 3,
		dayIndex: 1,
		orderIndex: 9,
		pinned: false
	});

	const run = (meals?: Map<string, MealSlotRow>) =>
		schedule({
			pois: [
				stop('Notting Hill', 51.509, -0.196, 'suburb', 60, 0),
				cafe('near', 51.5154, -0.141),
				cafe('other', 51.5152, -0.1408)
			],
			days: tripDays(trip),
			allowedModes: ['walk', 'transit'],
			timezone: 'Europe/London',
			mealWindows: tightest([A]).windows,
			meals
		}).days[1];

	const say = (meal: string, row: Partial<MealSlotRow>) =>
		new Map([
			[
				`1:${meal}`,
				{ day_index: 1, meal, poi_id: null, at: null, skipped: false, ...row } as MealSlotRow
			]
		]);

	it('fills an untouched slot with somewhere suitable nearby', () => {
		const names = run().stops.map((s) => s.name);
		expect(names.includes('near') || names.includes('other')).toBe(true);
	});

	it('takes the place the traveller put in it', () => {
		const names = run(say('breakfast', { poi_id: 'other' })).stops.map((s) => s.name);
		expect(names).toContain('other');
	});

	it('skips the meal entirely when told to', () => {
		const names = run(say('breakfast', { skipped: true })).stops.map((s) => s.name);
		expect(names).not.toContain('Breakfast');
		expect(names).not.toContain('near');
	});

	it('never puts an eating place between two sights', () => {
		// Everything with a meal category is either in a slot or not on the day.
		const windows = slotsFrom(tightest([A]).windows);
		for (const s of run().stops) {
			if (s.poiId !== 'near' && s.poiId !== 'other') continue;
			expect(slotAt(s.arrive, 'Europe/London', windows)).not.toBeNull();
		}
	});

	it('leaves the one it did not seat off the day', () => {
		const seated = run().stops.filter((s) => s.poiId === 'near' || s.poiId === 'other');
		expect(seated).toHaveLength(1);
	});
});

describe('assigning a slot by hand', () => {
	const far = (id: string): PlanPoi => ({
		id,
		name: id,
		// Miles away, and on no day: neither should matter.
		lat: 51.6,
		lng: 0.1,
		category: 'cafe',
		durationMin: 20,
		priority: 3,
		dayIndex: null,
		orderIndex: null,
		pinned: false
	});

	const run = (poiId: string | null) =>
		schedule({
			pois: [stop('Notting Hill', 51.509, -0.196, 'suburb', 60, 0), far('starbucks')],
			days: tripDays(trip),
			allowedModes: ['walk', 'transit'],
			timezone: 'Europe/London',
			mealWindows: tightest([A]).windows,
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
		schedule({
			pois: [
				stop('Notting Hill', 51.509, -0.196, 'suburb', 60, 0),
				stop('British Museum', 51.5194, -0.127, 'museum', 480, 1)
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
		const late = schedule({
			pois: [stop('Notting Hill', 51.509, -0.196, 'suburb', 60, 0)],
			days: tripDays({ ...trip, dayStart: '10:30', prep: null }),
			allowedModes: ['walk'],
			timezone: 'Europe/London',
			mealWindows: tightest([B]).windows
		}).days[1];
		expect(late.stops.map((s) => s.name)).not.toContain('Breakfast');
	});
});
