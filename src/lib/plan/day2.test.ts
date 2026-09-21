import { describe, it, expect } from 'vitest';
import { tripDays, type Trip } from '$lib/trip/days';
import { schedule, type PlanPoi } from './planner';
import { tightest, type MealWindows } from './meals';

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
		expect(mealsOn()).toContain('Lunch');
	});

	it('still keeps the booking on the plan', () => {
		expect(day2().stops.some((s) => s.poiId === 'Pret A Manger')).toBe(true);
	});
});
