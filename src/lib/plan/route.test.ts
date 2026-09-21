import { describe, it, expect } from 'vitest';
import { decodePolyline, decodePolyline6, groupSteps, type RouteStep } from './route';

/**
 * A real fragment from Valhalla's OSM instance, routing on foot between two
 * points in central Rome. Hand-written encodings are not a test of anything.
 */
const REAL_FRAGMENT = 'stw{nAywnyV`DoPJs@';

describe('decodePolyline6', () => {
	it('decodes a real Valhalla shape to the right place', () => {
		const points = decodePolyline6(REAL_FRAGMENT);
		expect(points).toHaveLength(3);
		expect(points[0].lat).toBeCloseTo(41.89014, 4);
		expect(points[0].lng).toBeCloseTo(12.49268, 4);
	});

	it('walks the deltas forward rather than repeating the first point', () => {
		const points = decodePolyline6(REAL_FRAGMENT);
		expect(points[2].lat).toBeCloseTo(41.89005, 4);
		expect(points[2].lng).toBeCloseTo(12.49299, 4);
	});

	it('uses precision 6, not the 5 most decoders assume', () => {
		// At precision 5 this same string yields 418.9, 124.9 -- off the globe
		// entirely, rather than subtly wrong. Worth pinning.
		const [first] = decodePolyline6(REAL_FRAGMENT);
		expect(Math.abs(first.lat)).toBeLessThan(90);
		expect(Math.abs(first.lng)).toBeLessThan(180);
	});

	it('handles an empty string without throwing', () => {
		expect(decodePolyline6('')).toEqual([]);
	});
});

describe('decodePolyline precision', () => {
	it('decodes Google polylines at precision 5', () => {
		// The same bytes at precision 6 would land a tenth as far out -- in the
		// Atlantic rather than in Rome.
		const [point] = decodePolyline('_p~iF~ps|U', 5);
		expect(point.lat).toBeCloseTo(38.5, 1);
		expect(point.lng).toBeCloseTo(-120.2, 1);
	});

	it('keeps the Valhalla shorthand decoding at 6', () => {
		const [point] = decodePolyline6('stw{nAywnyV');
		expect(point.lat).toBeCloseTo(41.89014, 4);
	});
});

describe('groupSteps', () => {
	const walk = (seconds: number, instruction: string): RouteStep => ({
		kind: 'walk',
		seconds,
		minutes: Math.round(seconds / 60),
		instruction
	});

	it('collapses a run of walking into one step', () => {
		const grouped = groupSteps([walk(70, 'Head north'), walk(50, 'Turn left'), walk(60, 'Arrive')]);
		expect(grouped).toHaveLength(1);
		expect(grouped[0].kind).toBe('walk');
		expect(grouped[0].minutes).toBe(3);
	});

	it('sums seconds before rounding, not after', () => {
		// Three 50-second walks round to 1+1+1 individually but are 2 together.
		const grouped = groupSteps([walk(50, 'a'), walk(50, 'b'), walk(50, 'c')]);
		expect(grouped[0].minutes).toBe(3);
		expect(grouped[0].seconds).toBe(150);
	});

	it('keeps transit and waiting between the walks', () => {
		const grouped = groupSteps([
			walk(120, 'to the station'),
			{ kind: 'wait', seconds: 300, minutes: 5, line: 'Central', to: 'Liverpool St' },
			{ kind: 'transit', seconds: 600, minutes: 10, line: 'Central', from: 'A', to: 'B' },
			walk(90, 'out'),
			walk(30, 'and left')
		]);
		expect(grouped.map((s) => s.kind)).toEqual(['walk', 'wait', 'transit', 'walk']);
		expect(grouped[3].minutes).toBe(2);
	});

	it('drops the turn instructions it merged away', () => {
		expect(groupSteps([walk(60, 'Turn left')])[0].instruction).toBeUndefined();
	});

	it('leaves an empty route alone', () => {
		expect(groupSteps([])).toEqual([]);
	});
});
