/**
 * Pointer-based drag for reordering stops.
 *
 * Not HTML5 drag-and-drop: that fires nothing on touch, and this app is used
 * on a phone. Not a drag library either -- the two drop targets here are a
 * list of stops and a row of day chips, which is not the list-to-list shape
 * those libraries are built around.
 *
 * Targets are found with elementFromPoint and data attributes, so anything can
 * be a target by declaring one.
 */
export type DropTarget =
	| { kind: 'stop'; id: string }
	| { kind: 'day'; index: number }
	/**
	 * The open space between two stops. Where in it the card was let go is the
	 * time it was let go at -- the gap is drawn to scale, so this is the one
	 * target that carries a moment as well as a place in the order.
	 */
	| { kind: 'gap'; day: number; before: string | null; at: string }
	| null;

/**
 * The nearest thing the card is scrolling inside.
 *
 * Needed because picking a card up opens the whole day, which pushes what is
 * under the finger hundreds of pixels down the list.
 */
function scrollParent(node: HTMLElement): HTMLElement | null {
	let el: HTMLElement | null = node.parentElement;
	while (el) {
		const overflow = getComputedStyle(el).overflowY;
		if ((overflow === 'auto' || overflow === 'scroll') && el.scrollHeight > el.clientHeight) {
			return el;
		}
		el = el.parentElement;
	}
	return null;
}

/** Hold before a drag begins, so a scroll is still a scroll. */
const HOLD_MS = 220;
/** Movement beyond this during the hold means they meant to scroll. */
const SLOP_PX = 8;
/**
 * How near an edge the finger has to be for the list to start crawling, and
 * how fast it crawls at the very edge.
 *
 * A day with its gaps open is taller than a phone, so most of where a card
 * could go is off the screen while it is being held. Without this, the only
 * places reachable are the ones that happened to be visible when it was picked
 * up -- which is what "I drop it and it does not move" looks like.
 */
const EDGE_PX = 90;
const EDGE_SPEED_PX = 16;

export function createDrag(onDrop: (draggedId: string, target: DropTarget) => void) {
	const state = $state({
		id: null as string | null,
		x: 0,
		y: 0,
		target: null as DropTarget
	});

	let holdTimer: ReturnType<typeof setTimeout> | null = null;
	let origin = { x: 0, y: 0 };
	let pending: string | null = null;
	let scroller: HTMLElement | null = null;
	let crawling: number | null = null;

	/** Creep the list along while the finger rests near one of its edges. */
	function crawl() {
		if (!state.id || !scroller) {
			crawling = null;
			return;
		}
		const box = scroller.getBoundingClientRect();
		const fromTop = state.y - box.top;
		const fromBottom = box.bottom - state.y;
		let dy = 0;
		if (fromTop < EDGE_PX) dy = -EDGE_SPEED_PX * (1 - Math.max(0, fromTop) / EDGE_PX);
		else if (fromBottom < EDGE_PX) dy = EDGE_SPEED_PX * (1 - Math.max(0, fromBottom) / EDGE_PX);
		if (dy) {
			scroller.scrollTop += dy;
			// What is under the finger changed without the finger moving.
			state.target = targetAt(state.x, state.y);
		}
		crawling = requestAnimationFrame(crawl);
	}

	function targetAt(x: number, y: number): DropTarget {
		// The dragged clone sits under the finger; hide it so it is not found.
		const el = document.elementFromPoint(x, y);
		const gap = el?.closest<HTMLElement>('[data-drop-gap]');
		if (gap && gap.dataset.gapStart && gap.dataset.gapEnd) {
			const box = gap.getBoundingClientRect();
			const fraction = Math.min(1, Math.max(0, (y - box.top) / box.height));
			const from = Date.parse(gap.dataset.gapStart);
			const to = Date.parse(gap.dataset.gapEnd);
			return {
				kind: 'gap',
				day: Number(gap.dataset.gapDay),
				before: gap.dataset.dropGap || null,
				at: new Date(from + fraction * (to - from)).toISOString()
			};
		}
		const stop = el?.closest<HTMLElement>('[data-drop-stop]');
		if (stop?.dataset.dropStop) return { kind: 'stop', id: stop.dataset.dropStop };
		const day = el?.closest<HTMLElement>('[data-drop-day]');
		if (day?.dataset.dropDay !== undefined) return { kind: 'day', index: Number(day.dataset.dropDay) };
		return null;
	}

	function move(event: PointerEvent) {
		if (!state.id) {
			// Still in the hold window: a real scroll cancels the pick-up.
			const far =
				Math.abs(event.clientX - origin.x) > SLOP_PX ||
				Math.abs(event.clientY - origin.y) > SLOP_PX;
			if (far) cancel();
			return;
		}
		event.preventDefault();
		state.x = event.clientX;
		state.y = event.clientY;
		state.target = targetAt(event.clientX, event.clientY);
	}

	function finish() {
		const id = state.id;
		const target = state.target;
		cleanup();
		if (id && target) onDrop(id, target);
	}

	function cancel() {
		cleanup();
	}

	function cleanup() {
		if (holdTimer) clearTimeout(holdTimer);
		holdTimer = null;
		if (crawling !== null) cancelAnimationFrame(crawling);
		crawling = null;
		scroller = null;
		pending = null;
		state.id = null;
		state.target = null;
		window.removeEventListener('pointermove', move);
		window.removeEventListener('pointerup', finish);
		window.removeEventListener('pointercancel', cancel);
		document.body.style.userSelect = '';
	}

	/**
	 * Attach to the grab handle of a draggable row. Returns a cleanup function,
	 * which is the shape a Svelte 5 attachment wants -- an attachment re-runs
	 * when its inputs change, so there is nothing for an `update` to do.
	 */
	function handle(node: HTMLElement, id: string) {
		function down(event: PointerEvent) {
			if (event.button !== 0 && event.pointerType === 'mouse') return;
			pending = id;
			origin = { x: event.clientX, y: event.clientY };
			state.x = event.clientX;
			state.y = event.clientY;

			window.addEventListener('pointermove', move, { passive: false });
			window.addEventListener('pointerup', finish);
			window.addEventListener('pointercancel', cancel);

			holdTimer = setTimeout(() => {
				if (pending !== id) return;
				// Where the card is before the day comes apart. Read now, while
				// the DOM is still the one the traveller is looking at.
				const before = node.getBoundingClientRect().top;
				scroller = scrollParent(node);
				state.id = id;
				if (crawling === null) crawling = requestAnimationFrame(crawl);
				document.body.style.userSelect = 'none';
				// A short buzz is the only feedback that the item is now held.
				navigator.vibrate?.(8);

				// Picking a card up opens every gap in the day, which is what
				// makes the day a place to drop into -- and which would shove the
				// card itself a few hundred pixels out from under the finger.
				// Scroll by as much as opened above it, so the card stays exactly
				// where it was grabbed and what is under the finger is what the
				// traveller is pointing at. Two frames: one for the layout, one
				// for anything it in turn moved.
				requestAnimationFrame(() =>
					requestAnimationFrame(() => {
						if (state.id !== id) return;
						if (!scroller) return;
						const shift = node.getBoundingClientRect().top - before;
						if (shift) scroller.scrollTop += shift;
					})
				);
			}, HOLD_MS);
		}

		node.addEventListener('pointerdown', down);
		return () => {
			node.removeEventListener('pointerdown', down);
			cleanup();
		};
	}

	return { state, handle };
}

/**
 * Where a stop ends up after being dropped.
 *
 * Returns the full new assignment for the affected stops, so the caller writes
 * one coherent set of rows rather than patching indices in place and hoping
 * they stay consistent.
 */
export function reorder<T extends { id: string; dayIndex: number | null; orderIndex: number | null }>(
	all: T[],
	draggedId: string,
	target: DropTarget
): { id: string; dayIndex: number | null; orderIndex: number }[] {
	if (!target) return [];
	const dragged = all.find((p) => p.id === draggedId);
	if (!dragged) return [];

	const toDay =
		target.kind === 'day'
			? target.index
			: target.kind === 'gap'
				? target.day
				: (all.find((p) => p.id === target.id)?.dayIndex ?? dragged.dayIndex);
	if (toDay === null || toDay === undefined) return [];
	// Dropping a stop onto itself is a no-op, not an error.
	if (target.kind === 'stop' && target.id === draggedId) return [];

	const ordered = (day: number) =>
		all
			.filter((p) => p.dayIndex === day && p.id !== draggedId)
			.sort((a, b) => (a.orderIndex ?? 0) - (b.orderIndex ?? 0));

	const destination = ordered(toDay);

	let insertAt = destination.length; // dropped on a day chip: append
	if (target.kind === 'gap') {
		// Dropped in the space above a stop: it goes above that stop. Null is
		// the space after everything, which is where append already lands.
		const slot = target.before ? destination.findIndex((p) => p.id === target.before) : -1;
		if (slot >= 0) insertAt = slot;
	}
	if (target.kind === 'stop') {
		const slot = destination.findIndex((p) => p.id === target.id);
		// Dropping onto a stop means taking its place. Moving down the same day,
		// that slot is one further along once the dragged stop is lifted out --
		// insert-before would leave it sitting just above where it was dropped.
		const movingDownSameDay =
			dragged.dayIndex === toDay && (dragged.orderIndex ?? 0) < (all.find((p) => p.id === target.id)?.orderIndex ?? 0);
		insertAt = Math.max(0, movingDownSameDay ? slot + 1 : slot);
	}
	destination.splice(insertAt, 0, dragged);

	const rows = destination.map((p, i) => ({ id: p.id, dayIndex: toDay, orderIndex: i }));

	// The day it left has a gap in it now; close that up too.
	if (dragged.dayIndex !== null && dragged.dayIndex !== toDay) {
		rows.push(
			...ordered(dragged.dayIndex).map((p, i) => ({
				id: p.id,
				dayIndex: dragged.dayIndex as number,
				orderIndex: i
			}))
		);
	}
	return rows;
}

/**
 * Where a newly added stop goes when it was added from a slot in the plan
 * rather than from the wishlist.
 *
 * `beforeId` is the stop it should land above; null appends to the end of the
 * day. Anchors are never named here -- the slot below the hotel is "before the
 * first real stop", and the slot above the return is an append.
 */
export function insertInto<T extends { id: string; dayIndex: number | null; orderIndex: number | null }>(
	all: T[],
	newId: string,
	dayIndex: number,
	beforeId: string | null
): { id: string; dayIndex: number; orderIndex: number }[] {
	const added = all.find((p) => p.id === newId);
	if (!added) return [];

	const destination = all
		.filter((p) => p.dayIndex === dayIndex && p.id !== newId)
		.sort((a, b) => (a.orderIndex ?? 0) - (b.orderIndex ?? 0));

	const slot = beforeId ? destination.findIndex((p) => p.id === beforeId) : -1;
	destination.splice(slot < 0 ? destination.length : slot, 0, added);

	return destination.map((p, i) => ({ id: p.id, dayIndex, orderIndex: i }));
}
