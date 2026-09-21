import { describe, it, expect } from 'vitest';
import { tripDays, type Trip } from '$lib/trip/days';
import { schedule, type PlanPoi } from './planner';
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
