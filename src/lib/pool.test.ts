import { describe, it, expect } from 'vitest';
import { pool } from './pool';

describe('pool', () => {
	it('returns results in input order, not completion order', async () => {
		const out = await pool([30, 10, 20], 3, async (ms) => {
			await new Promise((r) => setTimeout(r, ms));
			return ms;
		});
		expect(out).toEqual([30, 10, 20]);
	});

	it('never runs more than the limit at once', async () => {
		let inFlight = 0;
		let peak = 0;
		await pool(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
			peak = Math.max(peak, ++inFlight);
			await new Promise((r) => setTimeout(r, 1));
			inFlight--;
		});
		expect(peak).toBe(4);
	});

	it('still visits every item when there are fewer than the limit', async () => {
		expect(await pool([1, 2], 8, async (n) => n * 2)).toEqual([2, 4]);
	});

	it('does nothing with nothing', async () => {
		expect(await pool([], 4, async () => 1)).toEqual([]);
	});
});
