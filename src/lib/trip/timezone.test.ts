import { describe, it, expect } from 'vitest';
import { zoneAt } from './timezone';

describe('zoneAt', () => {
	it('knows the destination, not the traveller', () => {
		expect(zoneAt(51.5074, -0.1278)).toBe('Europe/London');
		expect(zoneAt(41.9028, 12.4964)).toBe('Europe/Rome');
		expect(zoneAt(35.6762, 139.6503)).toBe('Asia/Tokyo');
	});

	it('resolves an airport to the city it serves', () => {
		// Stansted is well outside London and still on London time.
		expect(zoneAt(51.886, 0.2389)).toBe('Europe/London');
	});

	it('handles a country with several zones', () => {
		expect(zoneAt(40.7128, -74.006)).toBe('America/New_York');
		expect(zoneAt(34.0522, -118.2437)).toBe('America/Los_Angeles');
	});

	it('gives nothing rather than a wrong answer for a bad pin', () => {
		expect(zoneAt(999, 999)).toBeNull();
	});
});
