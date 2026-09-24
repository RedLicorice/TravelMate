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
