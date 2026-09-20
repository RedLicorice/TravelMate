import { describe, it, expect } from 'vitest';
import { reorder } from './dnd.svelte';

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
		const result = reorder(rows(), 'c', { kind: 'stop', id: 'a' });
		expect(orderOf(result, 0)).toEqual(['c', 'a', 'b']);
	});

	it('moves a stop down', () => {
		const result = reorder(rows(), 'a', { kind: 'stop', id: 'c' });
		expect(orderOf(result, 0)).toEqual(['b', 'c', 'a']);
	});

	it('renumbers from zero with no gaps', () => {
		const result = reorder(rows(), 'c', { kind: 'stop', id: 'b' });
		const day0 = result.filter((r) => r.dayIndex === 0).map((r) => r.orderIndex).sort();
		expect(day0).toEqual([0, 1, 2]);
	});

	it('treats a drop on itself as a no-op', () => {
		expect(reorder(rows(), 'b', { kind: 'stop', id: 'b' })).toEqual([]);
	});
});

describe('moving between days', () => {
	it('inserts before the stop it was dropped on', () => {
		const result = reorder(rows(), 'a', { kind: 'stop', id: 'y' });
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

describe('drop position when moving down', () => {
	it('takes the slot of the stop it was dropped on, both directions', () => {
		// The edge case every reorder gets wrong once: lifting the dragged stop
		// out shifts everything below it up by one, so moving down needs to
		// insert after the target, while moving up inserts before.
		expect(orderOf(reorder(rows(), 'a', { kind: 'stop', id: 'b' }), 0)).toEqual(['b', 'a', 'c']);
		expect(orderOf(reorder(rows(), 'c', { kind: 'stop', id: 'b' }), 0)).toEqual(['a', 'c', 'b']);
	});

	it('still inserts before when the stop comes from another day', () => {
		// Nothing shifts in the destination, so there is no slot to compensate.
		expect(orderOf(reorder(rows(), 'x', { kind: 'stop', id: 'b' }), 0)).toEqual(['a', 'x', 'b', 'c']);
	});
});
