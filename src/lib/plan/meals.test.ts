import { describe, it, expect } from 'vitest';
import {
	DEFAULT_WINDOWS,
	effectiveDayStart,
	latestReady,
	readyAt,
	tightest,
	toHHMM,
	toHours,
	type MealWindows
} from './meals';

const win = (lf: string, lt: string, df: string, dt: string): MealWindows => ({
	breakfast: { from: '07:00', to: '10:00' },
	lunch: { from: lf, to: lt },
	dinner: { from: df, to: dt }
});

describe('toHours / toHHMM', () => {
	it('reads minutes as a fraction', () => {
		expect(toHours('12:30')).toBe(12.5);
		expect(toHours('09:00')).toBe(9);
	});

	it('round-trips', () => {
		expect(toHHMM(toHours('19:45'))).toBe('19:45');
	});

	it('pads single digits', () => {
		expect(toHHMM(9.5)).toBe('09:30');
	});
});

describe('tightest', () => {
	it('returns the defaults when nobody has said anything', () => {
		expect(tightest([]).windows).toEqual(DEFAULT_WINDOWS);
	});

	it('returns one person unchanged', () => {
		const mine = win('11:30', '14:00', '18:00', '20:30');
		expect(tightest([mine]).windows).toEqual(mine);
	});

	it('takes the overlap, not the average', () => {
		// An average would produce 12:30-14:30, a time that suits neither.
		const a = win('12:00', '14:00', '19:00', '21:00');
		const b = win('13:00', '15:00', '20:00', '22:00');
		const { windows } = tightest([a, b]);
		expect(windows.lunch).toEqual({ from: '13:00', to: '14:00' });
		expect(windows.dinner).toEqual({ from: '20:00', to: '21:00' });
	});

	it('narrows to the tightest across three people', () => {
		const { windows } = tightest([
			win('12:00', '15:00', '19:00', '22:00'),
			win('12:30', '14:30', '19:30', '21:30'),
			win('12:15', '14:00', '20:00', '21:00')
		]);
		expect(windows.lunch).toEqual({ from: '12:30', to: '14:00' });
		expect(windows.dinner).toEqual({ from: '20:00', to: '21:00' });
	});

	it('reports a conflict when the windows do not overlap at all', () => {
		// An early eater and a late eater: there is no honest shared window.
		const early = win('11:00', '12:00', '17:00', '18:00');
		const late = win('14:00', '15:00', '21:00', '22:00');
		const { windows, conflicts } = tightest([early, late]);
		expect(conflicts).toEqual(['lunch', 'dinner']);
		// The later start wins, with a half hour hung off it, rather than an
		// empty window that would silently match nothing.
		expect(windows.lunch.from).toBe('14:00');
		expect(windows.lunch.to).toBe('14:30');
	});

	it('flags only the meal that actually conflicts', () => {
		const a = win('12:00', '15:00', '19:00', '20:00');
		const b = win('13:00', '14:00', '21:00', '22:00');
		expect(tightest([a, b]).conflicts).toEqual(['dinner']);
	});

	it('treats a window shorter than half an hour as a conflict', () => {
		const a = win('12:00', '13:10', '19:00', '22:00');
		const b = win('13:00', '15:00', '19:00', '22:00');
		// 13:00-13:10 is technically an overlap and practically not lunch.
		expect(tightest([a, b]).conflicts).toContain('lunch');
	});
});

describe('being ready to leave', () => {
	it('adds prep to the wake time', () => {
		expect(readyAt('08:00', 30)).toBe('08:30');
		expect(readyAt('07:45', 45)).toBe('08:30');
	});

	it('handles no prep at all', () => {
		expect(readyAt('08:00', 0)).toBe('08:00');
	});

	it('takes the latest of the party, not the average', () => {
		// A plan starting before someone is dressed is one they miss the start of.
		expect(
			latestReady([
				{ wakeAt: '07:00', prepMin: 20 },
				{ wakeAt: '08:30', prepMin: 45 },
				{ wakeAt: '08:00', prepMin: 30 }
			])
		).toBe('09:15');
	});

	it('has no opinion when nobody has said', () => {
		expect(latestReady([])).toBeNull();
	});

	it('pushes the day start later, never earlier', () => {
		expect(effectiveDayStart('09:00', '08:30')).toBe('09:00');
		expect(effectiveDayStart('09:00', '10:15')).toBe('10:15');
		expect(effectiveDayStart('09:00', null)).toBe('09:00');
	});
});

describe('breakfast', () => {
	it('is part of the default windows', () => {
		expect(DEFAULT_WINDOWS.breakfast).toEqual({ from: '07:00', to: '10:00' });
	});

	it('intersects across people like the other meals', () => {
		const a: MealWindows = { ...DEFAULT_WINDOWS, breakfast: { from: '07:00', to: '09:00' } };
		const b: MealWindows = { ...DEFAULT_WINDOWS, breakfast: { from: '08:00', to: '10:00' } };
		expect(tightest([a, b]).windows.breakfast).toEqual({ from: '08:00', to: '09:00' });
	});

	it('survives a profile saved before breakfast existed', () => {
		// Older rows have only lunch and dinner. Falling back beats NaN.
		const legacy = { lunch: DEFAULT_WINDOWS.lunch, dinner: DEFAULT_WINDOWS.dinner } as MealWindows;
		expect(tightest([legacy]).windows.breakfast).toEqual(DEFAULT_WINDOWS.breakfast);
	});
});
