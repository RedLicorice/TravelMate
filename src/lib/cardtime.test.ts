import { describe, it, expect } from 'vitest';
import { cardTime, spanOf } from './cardtime';

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

describe('cardTime', () => {
	it('uses a stated span as it stands', () => {
		expect(cardTime('17:25–19:35', '09:00', 0)).toBe('17:25–19:35');
	});

	it('ends a stated moment with the time it takes', () => {
		// Landing at 19:35 and spending 45 minutes getting out.
		expect(cardTime('19:35', '09:00', 45)).toBe('19:35–20:20');
	});

	it('still says both ends when a stated moment takes no time', () => {
		expect(cardTime('17:25', '09:00', 0)).toBe('17:25–17:25');
	});

	it('derives the range from the clock when there is no label', () => {
		expect(cardTime(null, '09:00', 90)).toBe('09:00–10:30');
	});

	it('says both ends for a card with no length', () => {
		expect(cardTime(null, '09:00', 0)).toBe('09:00–09:00');
	});

	it('rolls past midnight without printing hour 24', () => {
		expect(cardTime(null, '23:30', 60)).toBe('23:30–00:30');
	});

	it('falls back to the clock for a label it cannot read', () => {
		expect(cardTime('your journey', '09:00', 0)).toBe('09:00–09:00');
	});
});
