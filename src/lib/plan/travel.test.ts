import { describe, it, expect } from 'vitest';
import { firstOf, haversineLeg, pointKey, tableFrom, transitFrom } from './travel';
import { leg } from './modes';
import type { TravelTable } from './travel';

describe('transitFrom', () => {
	it('beats the old flat model on an airport run', () => {
		// The complaint that prompted this: Stansted to central London came out
		// at 222 minutes. The road route is 57km and 76 driving minutes; the
		// Stansted Express plus tube is about 65 by the timetable.
		const estimate = transitFrom(76, 57.2);
		expect(estimate).toBeGreaterThan(50);
		expect(estimate).toBeLessThan(80);
	});

	it('makes urban transit slower than driving, not faster', () => {
		// Stops, transfers and the walk to the platform. A bus across town does
		// not beat a car.
		expect(transitFrom(20, 6)).toBeGreaterThan(20);
	});

	it('never claims an express is slower than driving the same road', () => {
		// Above the long-distance band it takes the better of the two, so a
		// congested motorway cannot make the train look worse than it is.
		expect(transitFrom(120, 50)).toBeLessThanOrEqual(120 + 15);
	});

	it('grows with distance', () => {
		expect(transitFrom(90, 70)).toBeGreaterThan(transitFrom(40, 30));
	});
});

describe('haversineLeg', () => {
	it('is still what answers when nothing was resolved', () => {
		const a = { lat: 41.9, lng: 12.48 };
		const b = { lat: 41.95, lng: 12.52 };
		expect(haversineLeg(a, b, 'walk').minutes).toBeGreaterThan(0);
	});
});

describe('leg with a resolved table', () => {
	const a = { lat: 51.886, lng: 0.2389 };
	const b = { lat: 51.5145, lng: -0.127 };

	const table: TravelTable = {
		get: (from, to, mode) =>
			pointKey(from) === pointKey(a) && mode === 'transit' ? { minutes: 65, km: 57.2 } : null
	};

	it('prefers the routed answer over the speed model', () => {
		const routed = leg(a, b, ['transit'], true, table);
		expect(routed.minutes).toBe(65);
		expect(routed.km).toBe(57.2);
	});

	it('falls back to the model when the table has no answer', () => {
		const estimated = leg(b, a, ['transit'], true, table);
		// The old model on this distance lands far north of the real journey,
		// which is exactly why the table exists -- but it must still answer.
		expect(estimated.minutes).toBeGreaterThan(100);
	});

	it('keeps choosing the mode itself', () => {
		// The table supplies minutes, not the decision about which network to
		// use; a 300m hop is still a walk.
		const near = { lat: 51.5145, lng: -0.1245 };
		expect(leg(b, near, ['walk', 'transit'], false, table).mode).toBe('walk');
	});
});

describe('tableFrom', () => {
	const stansted = { lat: 51.886, lng: 0.2389 };
	const london = { lat: 51.5145, lng: -0.127 };

	it('uses a Google transit figure exactly as given', () => {
		// Google already routed the train, including the walk to the platform,
		// the wait and the transfers. Running transitFrom over it would charge
		// for those a second time.
		const table = tableFrom([
			{ from: pointKey(stansted), to: pointKey(london), minutes: 99, km: 65.8, source: 'google' }
		]);
		expect(table.get(stansted, london, 'transit')).toEqual({ minutes: 99, km: 65.8 });
	});

	it('still applies the band to a Valhalla road figure', () => {
		const table = tableFrom([
			{ from: pointKey(stansted), to: pointKey(london), minutes: 76, km: 57.2, source: 'valhalla' }
		]);
		const answer = table.get(stansted, london, 'transit')!;
		expect(answer.minutes).not.toBe(76);
		expect(answer.minutes).toBe(transitFrom(76, 57.2));
	});

	it('returns null for a pair it has never seen', () => {
		expect(tableFrom([]).get(stansted, london, 'walk')).toBeNull();
	});
});

describe('firstOf', () => {
	const a = { lat: 1, lng: 1 };
	const b = { lat: 2, lng: 2 };
	const answers = (minutes: number): TravelTable => ({ get: () => ({ minutes, km: 1 }) });
	const silent: TravelTable = { get: () => null };

	it('takes the first table that answers', () => {
		expect(firstOf([answers(10), answers(20)]).get(a, b, 'walk')!.minutes).toBe(10);
	});

	it('falls through a table with no answer', () => {
		expect(firstOf([silent, answers(20)]).get(a, b, 'walk')!.minutes).toBe(20);
	});

	it('returns null when nothing answers, so the caller can estimate', () => {
		expect(firstOf([silent, silent]).get(a, b, 'walk')).toBeNull();
	});
});

