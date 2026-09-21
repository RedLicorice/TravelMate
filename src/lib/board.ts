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

/**
 * The minutes past midnight a card's own time label covers.
 *
 * Journey cards cost the day nothing -- the flight happened before the trip's
 * clock started -- so the planner gives them all the same instant and zero
 * length. Left at that they collapse into a stack at the top of the day. Their
 * real hours are on the label, and that is what the board must draw them at.
 *
 * '08:00' is a moment; '13:40–15:45' is a span. Anything else is not a time.
 */
export function spanOf(label: string | null | undefined): { from: number; to: number } | null {
	if (!label) return null;
	const parts = label.split(/[–-]/).map((p) => p.trim());
	const mins = parts.map((p) => {
		const m = /^(\d{1,2}):(\d{2})$/.exec(p);
		if (!m) return null;
		const h = Number(m[1]);
		const min = Number(m[2]);
		return h < 24 && min < 60 ? h * 60 + min : null;
	});
	if (mins[0] === null || mins.some((m) => m === null)) return null;

	const from = mins[0]!;
	// A span that ends before it starts ran past midnight; give it the rest of
	// the day rather than a negative height.
	const to = mins.length > 1 ? (mins[1]! >= from ? mins[1]! : 24 * 60) : from;
	return { from, to };
}
