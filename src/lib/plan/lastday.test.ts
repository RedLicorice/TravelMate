import { describe, it, expect } from 'vitest';
import { tripDays, type Trip } from '$lib/trip/days';
import { schedule, type PlanPoi } from './planner';

/** Departing Stansted at 18:00, wanting to be there two hours before. */
const trip: Trip = {
	hotelName: 'Hotel',
	hotel: { lat: 51.5145, lng: -0.127 },
	timezone: 'Europe/London',
	arrivalAt: '2026-10-01T08:00:00Z',
	departureAt: '2026-10-02T17:00:00Z', // 18:00 London
	arrivalPoint: null,
	departurePoint: { name: 'Stansted', at: { lat: 51.886, lng: 0.2389 } },
	arrivalBufferMin: 0,
	departureBufferMin: 120,
	bagDropMin: 30,
	dayStart: '09:00',
	dayEnd: '19:00'
};

describe('the last day must reach check-in', () => {
	it('leaves enough time to get from the hotel to the airport', () => {
		const days = tripDays(trip);
		const last = days[days.length - 1];

		const pois: PlanPoi[] = [
			{
				id: 'tower',
				name: 'Tower',
				lat: 51.5081,
				lng: -0.0759,
				category: 'attraction',
				durationMin: 120,
				priority: 3,
				dayIndex: days.length - 1,
				orderIndex: 0
			}
		];
		const result = schedule({
			pois,
			days,
			allowedModes: ['walk', 'transit'],
			timezone: 'Europe/London'
		});

		const stops = result.days[days.length - 1].stops;
		const terminal = stops[stops.length - 1];

		// Being at the airport after check-in closes is missing the flight. The
		// overflow probe used to sum only the closing anchors' dwell, so the
		// hotel-to-airport transfer went uncounted and the day ran 8 minutes
		// past its own deadline -- far more with a routed transfer.
		expect(terminal.arrive.getTime()).toBeLessThanOrEqual(last.end.getTime());
	});
});
