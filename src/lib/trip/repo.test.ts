import { describe, it, expect } from 'vitest';
import { toTrip, type TripRow } from './repo';
import { tripDays } from './days';

const row: TripRow = {
	id: 't1',
	user_id: 'u1',
	name: 'Rome',
	city: 'Rome',
	timezone: 'Europe/Rome',
	hotel_name: 'Hotel Artemide',
	hotel_lat: 41.8986,
	hotel_lng: 12.4768,
	arrival_at: '2026-04-10T13:00:00Z',
	departure_at: '2026-04-13T16:00:00Z',
	arrival_point_name: 'Fiumicino',
	arrival_point_lat: 41.8003,
	arrival_point_lng: 12.2389,
	departure_point_name: null,
	departure_point_lat: null,
	departure_point_lng: null,
	arrival_kind: 'airport',
	departure_kind: null,
	arrival_buffer_min: 45,
	departure_buffer_min: 120,
	bag_drop_min: 30,
	allowed_modes: ['walk', 'transit'],
	city_south: 41.8,
	city_north: 42.0,
	city_west: 12.4,
	city_east: 12.6,
	day_start: '09:00:00',
	day_end: '19:00:00',
	share_token: null,
	created_at: '2026-03-01T00:00:00Z'
};

describe('toTrip', () => {
	it('produces a Trip the day derivation accepts', () => {
		expect(tripDays(toTrip(row))).toHaveLength(4);
	});

	it('carries the arrival point through', () => {
		expect(toTrip(row).arrivalPoint).toEqual({
			name: 'Fiumicino',
			at: { lat: 41.8003, lng: 12.2389 }
		});
	});

	it('maps a missing departure point to null, not a half-built place', () => {
		expect(toTrip(row).departurePoint).toBeNull();
	});

	it('trims postgres time values to HH:MM', () => {
		const trip = toTrip(row);
		expect(trip.dayStart).toBe('09:00');
		expect(trip.dayEnd).toBe('19:00');
	});
});
