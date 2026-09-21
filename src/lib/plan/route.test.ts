import { describe, it, expect } from 'vitest';
import { decodePolyline6 } from './route';

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
