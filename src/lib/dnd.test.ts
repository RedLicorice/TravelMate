import { describe, it, expect } from 'vitest';
import { insertInto, reorder } from './dnd.svelte';

type Row = { id: string; dayIndex: number | null; orderIndex: number | null };

const rows = (): Row[] => [
	{ id: 'a', dayIndex: 0, orderIndex: 0 },
	{ id: 'b', dayIndex: 0, orderIndex: 1 },
	{ id: 'c', dayIndex: 0, orderIndex: 2 },
	{ id: 'x', dayIndex: 1, orderIndex: 0 },
	{ id: 'y', dayIndex: 1, orderIndex: 1 }
];

/** The resulting order of a given day, as ids. */
const orderOf = (result: ReturnType<typeof reorder>, day: number) =>
	result
		.filter((r) => r.dayIndex === day)
		.sort((a, b) => a.orderIndex - b.orderIndex)
		.map((r) => r.id);

describe('reorder within a day', () => {
	it('moves a stop up', () => {
		const result = reorder(rows(), 'c', { kind: 'slot', day: 0, index: 0, at: null }, 0);
		expect(orderOf(result, 0)).toEqual(['c', 'a', 'b']);
	});

	it('moves a stop down', () => {
		const result = reorder(rows(), 'a', { kind: 'slot', day: 0, index: 3, at: null }, 2);
		expect(orderOf(result, 0)).toEqual(['b', 'c', 'a']);
	});

	it('renumbers from zero with no gaps', () => {
		const result = reorder(rows(), 'c', { kind: 'slot', day: 0, index: 0, at: null });
		const day0 = result.filter((r) => r.dayIndex === 0).map((r) => r.orderIndex).sort();
		expect(day0).toEqual([0, 1, 2]);
	});

	it('leaves the day as it was when nothing actually moved', () => {
		// Let go where it already is: the same order, written back.
		expect(orderOf(reorder(rows(), 'b', { kind: 'slot', day: 0, index: 1, at: null }, 1), 0)).toEqual([
			'a',
			'b',
			'c'
		]);
	});
});

describe('moving between days', () => {
	it('lands at the counted position on the day it was dropped on', () => {
		const result = reorder(rows(), 'a', { kind: 'slot', day: 1, index: 1, at: null }, 1);
		expect(orderOf(result, 1)).toEqual(['x', 'a', 'y']);
	});

	it('appends when dropped on a day chip', () => {
		const result = reorder(rows(), 'a', { kind: 'day', index: 1 });
		expect(orderOf(result, 1)).toEqual(['x', 'y', 'a']);
	});

	it('closes the gap left behind in the old day', () => {
		const result = reorder(rows(), 'a', { kind: 'day', index: 1 });
		// b and c must renumber to 0 and 1, or the day keeps a hole where a was.
		expect(orderOf(result, 0)).toEqual(['b', 'c']);
		expect(result.filter((r) => r.dayIndex === 0).map((r) => r.orderIndex).sort()).toEqual([0, 1]);
	});

	it('can pull an unscheduled stop onto a day', () => {
		const withLoose: Row[] = [...rows(), { id: 'loose', dayIndex: null, orderIndex: null }];
		const result = reorder(withLoose, 'loose', { kind: 'day', index: 0 });
		expect(orderOf(result, 0)).toEqual(['a', 'b', 'c', 'loose']);
	});

	it('does nothing without a target', () => {
		expect(reorder(rows(), 'a', null)).toEqual([]);
	});

	it('does nothing for a stop it has never heard of', () => {
		expect(reorder(rows(), 'ghost', { kind: 'day', index: 0 })).toEqual([]);
	});
});

describe('dropping at a counted position', () => {
	const slot = (index: number) => ({ kind: 'slot', day: 0, index, at: null }) as const;

	it('puts the card where the traveller pointed, counting from the top', () => {
		// The caller counts how many of the day's own stops are above the place
		// the card was let go, so this has nothing left to guess at.
		expect(orderOf(reorder(rows(), 'a', slot(0), 1), 0)).toEqual(['b', 'a', 'c']);
		expect(orderOf(reorder(rows(), 'c', slot(0), 1), 0)).toEqual(['a', 'c', 'b']);
		expect(orderOf(reorder(rows(), 'x', slot(0), 1), 0)).toEqual(['a', 'x', 'b', 'c']);
	});

	it('takes the top of the day and the end of it', () => {
		expect(orderOf(reorder(rows(), 'c', slot(0), 0), 0)).toEqual(['c', 'a', 'b']);
		expect(orderOf(reorder(rows(), 'a', slot(0), 9), 0)).toEqual(['b', 'c', 'a']);
	});
});

describe('insertInto', () => {
	const day = (n: number) => [
		{ id: 'a', dayIndex: n, orderIndex: 0 },
		{ id: 'b', dayIndex: n, orderIndex: 1 },
		{ id: 'c', dayIndex: n, orderIndex: 2 }
	];
	const fresh = { id: 'new', dayIndex: null, orderIndex: null };

	it('lands the stop above the one it was added under', () => {
		const rows = insertInto([...day(1), fresh], 'new', 1, 'b');
		expect(rows.map((r) => r.id)).toEqual(['a', 'new', 'b', 'c']);
		expect(rows.map((r) => r.orderIndex)).toEqual([0, 1, 2, 3]);
	});

	it('appends when no stop follows the slot', () => {
		expect(insertInto([...day(1), fresh], 'new', 1, null).map((r) => r.id)).toEqual([
			'a',
			'b',
			'c',
			'new'
		]);
	});

	it('goes first when the slot is above every stop', () => {
		expect(insertInto([...day(1), fresh], 'new', 1, 'a').map((r) => r.id)).toEqual([
			'new',
			'a',
			'b',
			'c'
		]);
	});

	it('leaves the other days alone', () => {
		const rows = insertInto([...day(0), ...day(1).map((p) => ({ ...p, id: p.id + '1' })), fresh], 'new', 1, null);
		expect(rows.every((r) => r.dayIndex === 1)).toBe(true);
	});

	it('is the only stop on an empty day', () => {
		expect(insertInto([fresh], 'new', 2, null)).toEqual([
			{ id: 'new', dayIndex: 2, orderIndex: 0 }
		]);
	});

	it('does nothing for a stop it cannot find', () => {
		expect(insertInto(day(1), 'ghost', 1, null)).toEqual([]);
	});
});
