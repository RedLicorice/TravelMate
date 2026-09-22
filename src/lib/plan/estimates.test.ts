import { describe, it, expect, vi } from 'vitest';
import { leg } from './modes';
import { departBucket } from './travel';
import { tableFromPlan, type PlanStopRow } from '$lib/trip/plan';

const hotel = { lat: 41.9028, lng: 12.4964 };
const museum = { lat: 41.9109, lng: 12.4818 };

const row = (p: Partial<PlanStopRow> & { order_index: number }): PlanStopRow => ({
	id: `row-${p.order_index}`,
	day_index: 0,
	poi_id: null,
	name: 'Stop',
	lat: hotel.lat,
	lng: hotel.lng,
	anchor: false,
	anchor_kind: null,
	time_label: null,
	starts_at: '2026-10-02T09:00:00Z',
	ends_at: '2026-10-02T10:00:00Z',
	duration_min: 60,
	pinned: false,
	leg_mode: null,
	leg_minutes: null,
	leg_km: null,
	leg_source: null,
	warnings: [],
	busyness: null,
	exit_lat: null,
	exit_lng: null,
	...p
});

describe('a leg says where its numbers came from', () => {
	it('is an estimate when it came from the speed model', () => {
		expect(leg(hotel, museum, ['walk']).source).toBe('estimate');
	});

	it('is an estimate when a table answered without saying', () => {
		const matrix = { get: () => ({ minutes: 21, km: 1.9 }) };
		expect(leg(hotel, museum, ['walk'], false, matrix).source).toBe('estimate');
	});

	it('is routed only when the table says so', () => {
		const routed = { get: () => ({ minutes: 26, km: 1.9, source: 'routed' as const }) };
		const answer = leg(hotel, museum, ['walk'], false, routed);
		expect(answer).toMatchObject({ minutes: 26, source: 'routed' });
	});

	it('is routed when there is nowhere to go', () => {
		// Nothing will ever come back to improve standing still, so it must not
		// sit in the plan asking to be looked up.
		expect(leg(hotel, hotel, ['transit']).source).toBe('routed');
	});
});

describe('the departure band', () => {
	it('matches the edge functions: transit by the UTC hour, roads not at all', () => {
		expect(departBucket('transit', '2026-10-02T08:30:00Z')).toBe('h8');
		expect(departBucket('transit', '2026-10-02T23:05:00Z')).toBe('h23');
		expect(departBucket('walk', '2026-10-02T08:30:00Z')).toBe('any');
		expect(departBucket('transit', null)).toBe('any');
	});

	it('does not change when a day is re-timed by a few minutes', () => {
		// Keyed on the instant, every drag missed the cache and asked again for
		// an answer the server already had.
		expect(departBucket('transit', '2026-10-02T08:02:00Z')).toBe(
			departBucket('transit', '2026-10-02T08:57:00Z')
		);
	});
});

describe('what a stored plan already knows', () => {
	const stored = [
		row({ order_index: 0 }),
		row({
			order_index: 1,
			lat: museum.lat,
			lng: museum.lng,
			leg_mode: 'walk',
			leg_minutes: 26,
			leg_km: 1.9,
			leg_source: 'routed'
		})
	];

	it('offers a routed leg back as routed', () => {
		expect(tableFromPlan(stored).get(hotel, museum, 'walk')).toEqual({
			minutes: 26,
			km: 1.9,
			source: 'routed'
		});
	});

	it('keeps the answer when the cards are moved about', () => {
		// The scheduler asks by where it is going, not by which stop it is
		// timing, so a refined journey survives the next drag.
		const table = tableFromPlan(stored);
		expect(leg(hotel, museum, ['walk'], false, table)).toMatchObject({
			minutes: 26,
			source: 'routed'
		});
	});

	it('says nothing about a leg it only estimated', () => {
		const guessed = [stored[0], { ...stored[1], leg_source: 'estimate' as const }];
		expect(tableFromPlan(guessed).get(hotel, museum, 'walk')).toBeNull();
	});

	it('departs from where the previous stop let the traveller out', () => {
		const exits = [
			{ ...stored[0], exit_lat: 41.8986, exit_lng: 12.4769 },
			stored[1]
		];
		const table = tableFromPlan(exits);
		expect(table.get(hotel, museum, 'walk')).toBeNull();
		expect(table.get({ lat: 41.8986, lng: 12.4769 }, museum, 'walk')).toMatchObject({
			source: 'routed'
		});
	});
});

describe('a journey that goes nowhere is never asked for', () => {
	it('does not call the routing function for two points in the same place', async () => {
		const invoke = vi.fn();
		vi.doMock('$lib/supabase', () => ({ supabase: { functions: { invoke } } }));
		const { legRoute } = await import('./route');
		expect(await legRoute(hotel, { ...hotel }, 'walk', null)).toBeNull();
		expect(invoke).not.toHaveBeenCalled();
		vi.doUnmock('$lib/supabase');
	});
});
