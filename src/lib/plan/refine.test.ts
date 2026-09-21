import { describe, it, expect, vi } from 'vitest';
import { routedTable } from './refine';
import type { PlannedDay } from './planner';
import type { LegRoute } from './route';

const stansted = { lat: 51.886, lng: 0.2389 };
const hotel = { lat: 51.5145, lng: -0.127 };
const museum = { lat: 51.5194, lng: -0.127 };

const stop = (
	name: string,
	at: { lat: number; lng: number },
	legIn: { mode: 'walk' | 'transit'; minutes: number; km: number } | null
) => ({
	poiId: null,
	name,
	at,
	arrive: new Date('2026-10-02T14:00:00Z'),
	depart: new Date('2026-10-02T14:00:00Z'),
	durationMin: 0,
	legIn,
	anchor: false,
	busyness: null,
	warnings: []
});

const day = (stops: ReturnType<typeof stop>[]): PlannedDay => ({
	index: 0,
	date: '2026-10-02',
	stops,
	overflowed: []
});

const routed = (minutes: number, km: number): LegRoute => ({
	minutes,
	movingMinutes: minutes,
	km,
	polyline: null,
	steps: [],
	source: 'google'
});

describe('routedTable', () => {
	it('replaces the matrix estimate with what the leg actually routes to', async () => {
		const route = vi.fn().mockResolvedValue(routed(119, 57.2));
		const table = await routedTable(
			[day([stop('Stansted', stansted, null), stop('Hotel', hotel, { mode: 'transit', minutes: 222, km: 57.2 })])],
			route
		);

		expect(table.get(stansted, hotel, 'transit')).toEqual({ minutes: 119, km: 57.2 });
	});

	it('does not put the transit band on top of a routed answer', async () => {
		// The routed figure already contains its walking, waiting and changes.
		const table = await routedTable(
			[day([stop('Stansted', stansted, null), stop('Hotel', hotel, { mode: 'transit', minutes: 222, km: 57.2 })])],
			async () => routed(119, 57.2)
		);
		expect(table.get(stansted, hotel, 'transit')!.minutes).toBe(119);
	});

	it('departs when the plan says the traveller leaves', async () => {
		const route = vi.fn().mockResolvedValue(routed(20, 2));
		const first = stop('Hotel', hotel, null);
		first.depart = new Date('2026-10-03T08:45:00Z');
		await routedTable([day([first, stop('Museum', museum, { mode: 'transit', minutes: 30, km: 2 })])], route);

		expect(route).toHaveBeenCalledWith(hotel, museum, 'transit', '2026-10-03T08:45:00.000Z');
	});

	it('asks once for a pair that appears on more than one day', async () => {
		const route = vi.fn().mockResolvedValue(routed(20, 2));
		const pair = () => day([stop('Hotel', hotel, null), stop('Museum', museum, { mode: 'walk', minutes: 30, km: 2 })]);
		await routedTable([pair(), pair()], route);
		expect(route).toHaveBeenCalledTimes(1);
	});

	it('leaves a leg alone when routing has no answer', async () => {
		const table = await routedTable(
			[day([stop('Hotel', hotel, null), stop('Museum', museum, { mode: 'walk', minutes: 30, km: 2 })])],
			async () => null
		);
		expect(table.get(hotel, museum, 'walk')).toBeNull();
	});
});
