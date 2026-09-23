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
/**
 * Where a held card would land: a day, and when on it.
 *
 * The rails are the ruler. Each draws its day to scale from top to bottom,
 * so the moment is read straight off the rail at the finger's height: over
 * the day on screen, the rail behind its cards; over a neighbour, that day's
 * own rail. What the rail says there is what the card is put at.
 *
 * `at` is null only for a target with no rail -- a day's tab -- which means
 * the end of that day.
 */
export type DropTarget = { day: number; at: string | null } | null;

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
		const el = document.elementFromPoint(x, y);
		// A neighbour's rail or a day's tab, or else anywhere over the day on
		// screen -- its cards sit on its rail, so under the finger is that rail.
		const zone =
			el?.closest<HTMLElement>('[data-drop-day]') ??
			el?.closest<HTMLElement>('[data-ruler]')?.querySelector<HTMLElement>('[data-ruler-here]');
		if (!zone?.dataset.dropDay) return null;
		const day = Number(zone.dataset.dropDay);
		const scale = zone.querySelector<HTMLElement>('[data-rail-from]');
		if (!scale) return { day, at: null };
		const box = scale.getBoundingClientRect();
		const fraction = Math.min(1, Math.max(0, (y - box.top) / box.height));
		const from = Number(scale.dataset.railFrom);
		const to = Number(scale.dataset.railTo);
		return { day, at: new Date(from + fraction * (to - from)).toISOString() };
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
