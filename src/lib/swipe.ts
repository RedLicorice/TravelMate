/**
 * Swipe a sheet down to close it.
 *
 * The sheet follows the finger down while it is pulled, and closes when let
 * go far enough down; short of that it springs back. Only from the top: a
 * sheet scrolled into its own content scrolls, as it should, and is pulled
 * down only once it is back at its top.
 *
 * Touch events rather than pointer events: the browser takes a touch that
 * starts moving for its own scrolling and cancels the pointer, but touch
 * events keep arriving. The pull is taken from the browser only while it is
 * a pull -- downward, from the top -- so the page does not bounce or reload
 * under it.
 */
const CLOSE_PX = 80;

export function swipeToClose(onclose: () => void) {
	return (node: HTMLElement) => {
		let from: number | null = null;
		let pulled = 0;

		const start = (e: TouchEvent) => {
			if (e.touches.length !== 1 || node.scrollTop > 0) return;
			from = e.touches[0].clientY;
			pulled = 0;
		};
		const move = (e: TouchEvent) => {
			if (from === null) return;
			pulled = Math.max(0, e.touches[0].clientY - from);
			if (pulled > 0 && e.cancelable) e.preventDefault();
			node.style.transform = pulled ? `translateY(${pulled}px)` : '';
		};
		const end = () => {
			if (from === null) return;
			from = null;
			node.style.transform = '';
			if (pulled > CLOSE_PX) onclose();
		};

		node.addEventListener('touchstart', start, { passive: true });
		node.addEventListener('touchmove', move, { passive: false });
		node.addEventListener('touchend', end);
		node.addEventListener('touchcancel', end);
		return () => {
			node.removeEventListener('touchstart', start);
			node.removeEventListener('touchmove', move);
			node.removeEventListener('touchend', end);
			node.removeEventListener('touchcancel', end);
		};
	};
}

/**
 * Swipe sideways to move to the neighbouring day: left for the next, right
 * for the previous.
 *
 * Only a clearly sideways move counts -- 60 px across and at least one and a
 * half times more across than down -- so scrolling the day is never taken for
 * a swipe. Not from the screen's outer 24 px, where the iPhone's own back
 * gesture lives. While it is a swipe the list follows the finger a little;
 * let go, it moves to the day and slides in from the side it came from, or
 * springs back when there is no day that way. Without motion (reduce motion)
 * it simply changes.
 */
const EDGE_PX = 24;
const SWIPE_PX = 60;

export function swipeSideways(opts: {
	/** Whether a swipe may start now: not while a card is held or a sheet is open. */
	enabled: () => boolean;
	/** Move one day; answers whether there was a day to move to. */
	go: (step: 1 | -1) => boolean;
}) {
	return (node: HTMLElement) => {
		let from: { x: number; y: number } | null = null;
		let sideways: boolean | null = null;
		let dx = 0;
		const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

		const start = (e: TouchEvent) => {
			const t = e.touches[0];
			if (e.touches.length !== 1 || !opts.enabled() || t.clientX < EDGE_PX || t.clientX > innerWidth - EDGE_PX) {
				from = null;
				return;
			}
			from = { x: t.clientX, y: t.clientY };
			sideways = null;
			dx = 0;
		};
		const move = (e: TouchEvent) => {
			if (!from) return;
			const t = e.touches[0];
			dx = t.clientX - from.x;
			const dy = t.clientY - from.y;
			if (sideways === null && Math.max(Math.abs(dx), Math.abs(dy)) > 10) sideways = Math.abs(dx) > 1.5 * Math.abs(dy);
			if (!sideways) return;
			if (e.cancelable) e.preventDefault();
			if (!still()) {
				node.style.transition = 'none';
				node.style.transform = `translateX(${dx * 0.35}px)`;
			}
		};
		const end = () => {
			if (!from || !sideways) {
				from = null;
				return;
			}
			from = null;
			const step: 1 | -1 = dx < 0 ? 1 : -1;
			const moved = Math.abs(dx) >= SWIPE_PX && opts.go(step);
			if (still()) {
				node.style.transform = '';
				return;
			}
			if (moved) {
				// In from the side the new day came from.
				node.style.transition = 'none';
				node.style.transform = `translateX(${step * 48}px)`;
				node.style.opacity = '0.4';
				requestAnimationFrame(() => {
					node.style.transition = 'transform 180ms ease-out, opacity 180ms ease-out';
					node.style.transform = '';
					node.style.opacity = '';
				});
			} else {
				node.style.transition = 'transform 180ms ease-out';
				node.style.transform = '';
			}
		};

		node.addEventListener('touchstart', start, { passive: true });
		node.addEventListener('touchmove', move, { passive: false });
		node.addEventListener('touchend', end);
		node.addEventListener('touchcancel', end);
		return () => {
			node.removeEventListener('touchstart', start);
			node.removeEventListener('touchmove', move);
			node.removeEventListener('touchend', end);
			node.removeEventListener('touchcancel', end);
		};
	};
}
