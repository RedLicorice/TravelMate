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
 * The day on screen, as a ruler read off its own cards.
 *
 * Each card declares when it starts and ends (data-start, data-end, in ms);
 * its top edge is its start and its bottom edge its end, and the space
 * between two cards runs evenly from the one's end to the next one's start.
 * Above the first card and below the last it runs to the day's own edges
 * (data-from, data-to on the ruler). So a card's beginning and end are
 * exactly where the ruler says its hours are, whatever height it is drawn.
 */
export type Ruler = {
	top: number;
	height: number;
	points: [number, number][];
	/** The cards themselves, top to bottom: where each sits (as fractions) and when it starts. */
	cards: { id: string; top: number; bottom: number; start: number }[];
};

export function measure(ruler: HTMLElement): Ruler {
	const box = ruler.getBoundingClientRect();
	const from = Number(ruler.dataset.from);
	const to = Number(ruler.dataset.to);
	const cards = [...ruler.querySelectorAll<HTMLElement>('[data-start]')]
		.map((el) => ({
			id: el.dataset.card ?? '',
			r: el.getBoundingClientRect(),
			start: Number(el.dataset.start),
			end: Number(el.dataset.end)
		}))
		.sort((a, b) => a.r.top - b.r.top);
	const frac = (y: number) => (y - box.top) / box.height;
	const points: [number, number][] = [[0, Math.min(from, cards[0]?.start ?? from)]];
	for (const c of cards) {
		points.push([frac(c.r.top), c.start], [frac(c.r.bottom), c.end]);
	}
	points.push([1, Math.max(to, cards.at(-1)?.end ?? to)]);
	// Time only runs forward down the page: a card drawn below one it starts
	// before (an overlap) does not pull the ruler back.
	for (let i = 1; i < points.length; i++) points[i][1] = Math.max(points[i][1], points[i - 1][1]);
	return {
		top: box.top,
		height: box.height,
		points,
		cards: cards.map((c) => ({ id: c.id, top: frac(c.r.top), bottom: frac(c.r.bottom), start: c.start }))
	};
}

const between = (points: [number, number][], x: number, from: 0 | 1, to: 0 | 1): number => {
	for (let i = 1; i < points.length; i++) {
		const [a, b] = [points[i - 1], points[i]];
		if (x <= b[from] || i === points.length - 1) {
			const span = b[from] - a[from];
			const t = span > 0 ? Math.min(1, Math.max(0, (x - a[from]) / span)) : 0;
			return a[to] + t * (b[to] - a[to]);
		}
	}
	return points[0]?.[to] ?? 0;
};

/** The moment at a height on the ruler, as a fraction of it (0 top, 1 bottom). */
export const timeAt = (r: Ruler, fraction: number) => between(r.points, fraction, 0, 1);
/** Where a moment is on the ruler, as a fraction of it. */
export const placeOf = (r: Ruler, ms: number) => between(r.points, ms, 1, 0);

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

export function createDrag(
	onDrop: (draggedId: string, target: DropTarget) => void,
	/** The day on screen's ruler, as the screen last measured it. */
	ruler: () => Ruler | null
) {
	const state = $state({
		id: null as string | null,
		x: 0,
		y: 0,
		target: null as DropTarget
	});

	let holdTimer: ReturnType<typeof setTimeout> | null = null;
	let origin = { x: 0, y: 0 };
	let pending: string | null = null;
	/** Whether the finger has gone anywhere since picking the card up. */
	let moved = false;
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
		// The day on screen reads its own cards: where they are is when they are.
		const here = zone.dataset.rulerHere !== undefined ? ruler() : null;
		const onScreen = zone.closest<HTMLElement>('[data-ruler]');
		if (here && onScreen) {
			const box = onScreen.getBoundingClientRect();
			const fraction = Math.min(1, Math.max(0, (y - box.top) / box.height));
			// Where the finger is decides the order: above a card, or on its
			// upper half, the held card goes before it; lower down, after it.
			// The line gives the minute -- unless the line's minute is later
			// than the card it is going before starts (a card out of order with
			// the one above it), and then it is that card's start, and that card
			// and everything after it are pushed down.
			let at = timeAt(here, fraction);
			const next = here.cards.find((c) => c.id !== state.id && (c.top + c.bottom) / 2 > fraction);
			if (next && next.start < at) at = next.start;
			return { day, at: new Date(at).toISOString() };
		}
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
		if (
			Math.abs(event.clientX - origin.x) > SLOP_PX ||
			Math.abs(event.clientY - origin.y) > SLOP_PX
		) {
			moved = true;
		}
		state.x = event.clientX;
		state.y = event.clientY;
		state.target = targetAt(event.clientX, event.clientY);
	}

	function finish() {
		const id = state.id;
		const target = state.target;
		const went = moved;
		cleanup();
		// Picked up and put straight back down is not a move: the card keeps
		// the time it had, and nothing is written.
		if (id && target && went) onDrop(id, target);
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
			moved = false;
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
