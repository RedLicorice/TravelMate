/**
 * Push a day's blocks apart so none of them overlaps.
 *
 * Blocks are placed by the clock, but a block has a floor height -- a ten
 * minute coffee still needs a readable card -- so a short one can run past its
 * own end time and into whatever comes next. Two cards on top of each other
 * read as one, which is worse than a card sitting slightly late.
 *
 * Items must already be in time order. Each keeps its height and is moved down
 * only as far as the block above it forces.
 */
export function stack<T extends { top: number; height: number }>(
	items: T[],
	gap = 2
): T[] {
	let floor = -Infinity;
	return items.map((item) => {
		const top = Math.max(item.top, floor);
		floor = top + item.height + gap;
		return { ...item, top };
	});
}
