import { describe, it, expect } from 'vitest';
import { cardTime, spanOf, stack } from './board';

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

/**
 * The board's own layout arithmetic, in the shape PlanBoard uses it: a journey
 * of moment-cards and a flight that must land on its own time.
 */
describe('a journey laid out on the board', () => {
	const PX = 1.1;
	const MIN_BLOCK = 26;
	type C = { key: string; top: number; height: number; from?: number; to?: number };

	/** Mirrors cardsFor: label gives the start, span or dwell gives the length. */
	const card = (key: string, from: number, to: number, dwell = 0): C => {
		const runs = to > from ? to - from : dwell;
		return { key, top: from * PX, height: Math.max(MIN_BLOCK, runs * PX), from, to: from + runs };
	};

	const lay = (cards: C[]) => {
		const ordered = [...cards].sort((a, b) => a.top - b.top);
		for (let i = 0; i < ordered.length - 1; i++) {
			const c = ordered[i];
			const n = ordered[i + 1];
			if (c.from === undefined || c.to !== c.from) continue;
			if (n.from !== c.from) continue;
			c.top -= c.height + 2;
		}
		return stack(ordered.sort((a, b) => a.top - b.top));
	};

	const reggio = 17 * 60 + 25;
	const stansted = 19 * 60 + 35;

	it('puts the flight on its own departure time, not below it', () => {
		const out = lay([card('reggio', reggio, reggio), card('flight', reggio, stansted)]);
		expect(out.find((c) => c.key === 'flight')!.top).toBe(reggio * PX);
	});

	it('hangs the boarding terminal above the line it shares', () => {
		const out = lay([card('reggio', reggio, reggio), card('flight', reggio, stansted)]);
		const r = out.find((c) => c.key === 'reggio')!;
		expect(r.top + r.height).toBeLessThanOrEqual(reggio * PX);
	});

	it('sizes the arrival airport by the time it takes to get out of it', () => {
		// Landing at 19:35 with 45 minutes of passport queue is a 45 minute
		// block, not a minimum-height one followed by a gap.
		const out = lay([card('flight', reggio, stansted), card('stansted', stansted, stansted, 45)]);
		expect(out.find((c) => c.key === 'stansted')!.height).toBeCloseTo(45 * PX, 5);
	});

	it('leaves no gap between the flight landing and the airport block', () => {
		const out = lay([card('flight', reggio, stansted), card('stansted', stansted, stansted, 45)]);
		const f = out.find((c) => c.key === 'flight')!;
		const s = out.find((c) => c.key === 'stansted')!;
		expect(s.top - (f.top + f.height)).toBeLessThanOrEqual(2);
	});

	it('does not drift across a whole journey', () => {
		const malpensa = 13 * 60 + 40;
		const out = lay([
			card('reggio', reggio, reggio),
			card('flight', reggio, stansted),
			card('stansted', stansted, stansted, 45)
		]);
		void malpensa;
		expect(out.find((c) => c.key === 'flight')!.top).toBe(reggio * PX);
		// Within the 2px the cards are separated by, not the hours the old
		// layout drifted by.
		const landed = out.find((c) => c.key === 'stansted')!.top;
		expect(landed).toBeGreaterThanOrEqual(stansted * PX);
		expect(landed - stansted * PX).toBeLessThanOrEqual(2);
	});
});

describe('cardTime', () => {
	it('uses a stated span as it stands', () => {
		expect(cardTime('17:25–19:35', '09:00', 0)).toBe('17:25–19:35');
	});

	it('ends a stated moment with the time it takes', () => {
		// Landing at 19:35 and spending 45 minutes getting out.
		expect(cardTime('19:35', '09:00', 45)).toBe('19:35–20:20');
	});

	it('leaves a stated moment alone when it takes no time', () => {
		expect(cardTime('17:25', '09:00', 0)).toBe('17:25');
	});

	it('derives the range from the clock when there is no label', () => {
		expect(cardTime(null, '09:00', 90)).toBe('09:00–10:30');
	});

	it('gives just the clock for a card with no length', () => {
		expect(cardTime(null, '09:00', 0)).toBe('09:00');
	});

	it('rolls past midnight without printing hour 24', () => {
		expect(cardTime(null, '23:30', 60)).toBe('23:30–00:30');
	});

	it('passes a label it cannot read straight through', () => {
		expect(cardTime('your journey', '09:00', 0)).toBe('09:00');
	});
});
