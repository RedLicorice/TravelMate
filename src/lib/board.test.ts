import { describe, it, expect } from 'vitest';
import { spanOf, stack } from './board';

describe('stack', () => {
	const spans = (out: { top: number; height: number }[]) =>
		out.map((b) => [b.top, b.top + b.height]);

	it('leaves blocks that already fit exactly where they are', () => {
		const out = stack([
			{ top: 0, height: 40 },
			{ top: 60, height: 40 }
		]);
		expect(out.map((b) => b.top)).toEqual([0, 60]);
	});

	it('pushes a block down when the one above runs into it', () => {
		// A 26px floor on a 10-minute stop overruns the next block's start.
		const out = stack([
			{ top: 0, height: 26 },
			{ top: 11, height: 26 }
		]);
		expect(out[1].top).toBeGreaterThanOrEqual(26);
	});

	it('never overlaps, however short the blocks are', () => {
		const out = stack(Array.from({ length: 12 }, (_, i) => ({ top: i * 4, height: 26 })));
		const ends = spans(out);
		for (let i = 1; i < ends.length; i++) {
			expect(ends[i][0]).toBeGreaterThanOrEqual(ends[i - 1][1]);
		}
	});

	it('keeps every block its own height', () => {
		const out = stack([
			{ top: 0, height: 26 },
			{ top: 2, height: 90 }
		]);
		expect(out.map((b) => b.height)).toEqual([26, 90]);
	});

	it('cascades: one long overrun moves everything below it', () => {
		const out = stack([
			{ top: 0, height: 100 },
			{ top: 10, height: 20 },
			{ top: 20, height: 20 }
		]);
		expect(out[1].top).toBeGreaterThanOrEqual(100);
		expect(out[2].top).toBeGreaterThanOrEqual(out[1].top + 20);
	});

	it('does nothing with nothing', () => {
		expect(stack([])).toEqual([]);
	});
});

describe('spanOf', () => {
	it('reads a moment', () => {
		expect(spanOf('08:00')).toEqual({ from: 480, to: 480 });
	});

	it('reads a span', () => {
		expect(spanOf('13:40–15:45')).toEqual({ from: 820, to: 945 });
	});

	it('accepts a plain hyphen as well as a dash', () => {
		expect(spanOf('13:40-15:45')).toEqual({ from: 820, to: 945 });
	});

	it('gives a flight over midnight the rest of the day, not a negative', () => {
		expect(spanOf('23:30–01:10')).toEqual({ from: 1410, to: 1440 });
	});

	it('is nothing for anything that is not a time', () => {
		expect(spanOf('your journey')).toBeNull();
		expect(spanOf('30 min')).toBeNull();
		expect(spanOf('25:00')).toBeNull();
		expect(spanOf(null)).toBeNull();
	});
});
