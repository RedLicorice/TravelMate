import { describe, it, expect } from 'vitest';
import { staleCount, toPlannedDays, type PlanStopRow } from './plan';
import type { Day, Waypoint } from './days';

/** Just enough of a day for toPlannedDays: its date and its anchors. */
const aDay = (date: string, anchors: Waypoint[] = []): Day => ({
	date,
	start: new Date(`${date}T09:00:00Z`),
	end: new Date(`${date}T19:00:00Z`),
	fixedStart: anchors,
	fixedEnd: [],
	usableMin: 600
});

const row = (p: Partial<PlanStopRow> & { day_index: number; order_index: number }): PlanStopRow => ({
	id: `row-${p.day_index}-${p.order_index}`,
	leg_source: null,
	placement_id: null,
	poi_id: null,
	name: 'Stop',
	lat: 51.5,
	lng: -0.12,
	anchor: false,
	anchor_kind: null,
	time_label: null,
	starts_at: '2026-10-03T09:00:00.000Z',
	ends_at: '2026-10-03T10:00:00.000Z',
	duration_min: 60,
	pinned: false,
	leg_mode: null,
	leg_minutes: null,
	leg_km: null,
	warnings: [],
	busyness: null,
	exit_lat: null,
	exit_lng: null,
	...p
});

describe('toPlannedDays', () => {
	it('groups rows into days in order', () => {
		const days = toPlannedDays(
			[
				row({ day_index: 1, order_index: 1, name: 'second' }),
				row({ day_index: 0, order_index: 0, name: 'first' }),
				row({ day_index: 1, order_index: 0, name: 'middle' })
			],
			[aDay('2026-10-02'), aDay('2026-10-03')]
		);

		expect(days.map((d) => d.date)).toEqual(['2026-10-02', '2026-10-03']);
		expect(days[0].stops.map((s) => s.name)).toEqual(['first']);
		expect(days[1].stops.map((s) => s.name)).toEqual(['middle', 'second']);
	});

	it('keeps a day the plan left empty, so the board still shows its date', () => {
		const days = toPlannedDays([row({ day_index: 1, order_index: 0 })], [aDay('2026-10-02'), aDay('2026-10-03')]);
		expect(days).toHaveLength(2);
		expect(days[0].stops).toEqual([]);
	});

	it('rebuilds the leg that led into each stop', () => {
		const [day] = toPlannedDays(
			[
				row({ day_index: 0, order_index: 0 }),
				row({ day_index: 0, order_index: 1, leg_mode: 'transit', leg_minutes: 24, leg_km: 7.4 })
			],
			[aDay('2026-10-02')]
		);
		expect(day.stops[0].legIn).toBeNull();
		// A row stored before legs said where they came from was routed the old
		// way, synchronously, so it counts as routed rather than asking again.
		expect(day.stops[1].legIn).toEqual({
			mode: 'transit',
			minutes: 24,
			km: 7.4,
			source: 'routed'
		});
	});

	it('restores times as instants, not strings', () => {
		const [day] = toPlannedDays([row({ day_index: 0, order_index: 0 })], [aDay('2026-10-03')]);
		expect(day.stops[0].arrive.toISOString()).toBe('2026-10-03T09:00:00.000Z');
		expect(day.stops[0].depart.getTime() - day.stops[0].arrive.getTime()).toBe(60 * 60_000);
	});

	it('returns nothing for a trip with no stored plan', () => {
		expect(toPlannedDays([], [])).toEqual([]);
	});
});

describe('staleCount', () => {
	const plannedAt = '2026-09-21T12:00:00.000Z';

	it('counts places added since the plan was made', () => {
		expect(
			staleCount(
				[
					{ created_at: '2026-09-20T10:00:00.000Z' },
					{ created_at: '2026-09-21T13:00:00.000Z' },
					{ created_at: '2026-09-21T14:00:00.000Z' }
				],
				plannedAt
			)
		).toBe(2);
	});

	it('counts a place edited since the plan was made', () => {
		expect(
			staleCount(
				[{ created_at: '2026-09-01T10:00:00.000Z', updated_at: '2026-09-21T13:00:00.000Z' }],
				plannedAt
			)
		).toBe(1);
	});

	it('is zero when the plan is newer than everything', () => {
		expect(
			staleCount(
				[
					{ created_at: '2026-09-01T10:00:00.000Z', updated_at: '2026-09-01T10:00:00.000Z' },
					{ created_at: '2026-09-20T10:00:00.000Z', updated_at: null }
				],
				plannedAt
			)
		).toBe(0);
	});

	it('treats a trip with no plan as entirely stale', () => {
		expect(staleCount([{ created_at: '2026-09-01T10:00:00.000Z' }], null)).toBe(1);
	});
});

describe('an exit point on a stored stop', () => {
	it('survives the round trip', () => {
		const [day] = toPlannedDays(
			[row({ day_index: 0, order_index: 0, exit_lat: 51.5083, exit_lng: 0.0184 })],
			[aDay('2026-10-03')]
		);
		expect(day.stops[0].exitAt).toEqual({ lat: 51.5083, lng: 0.0184 });
	});

	it('is null for an ordinary stop', () => {
		const [day] = toPlannedDays([row({ day_index: 0, order_index: 0 })], [aDay('2026-10-03')]);
		expect(day.stops[0].exitAt).toBeNull();
	});
});

describe('a meal the plan supplied itself', () => {
	it('survives being stored and read back', () => {
		const [only] = toPlannedDays(
			[
				row({
					day_index: 0,
					order_index: 0,
					anchor: true,
					anchor_kind: 'meal',
					name: 'Lunch',
					duration_min: 60,
					poi_id: null
				})
			],
			[aDay('2026-10-03')]
		);
		const lunch = only.stops[0];
		expect(lunch.name).toBe('Lunch');
		expect(lunch.anchorKind).toBe('meal');
		expect(lunch.durationMin).toBe(60);
	});

	it('is not mistaken for the hotel when the day has no waypoint by that name', () => {
		// The kind is stored, so the fallback that guesses from the day's own
		// anchors must not overwrite it.
		const [only] = toPlannedDays(
			[row({ day_index: 0, order_index: 0, anchor: true, anchor_kind: 'meal', name: 'Dinner' })],
			[aDay('2026-10-03', [{ name: 'Hotel', at: { lat: 0, lng: 0 }, dwellMin: 0, kind: 'hotel' }])]
		);
		expect(only.stops[0].anchorKind).toBe('meal');
	});
});
