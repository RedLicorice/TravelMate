/**
 * Hold a card to open its menu.
 *
 * Cancelled by movement, because the same gesture starts a scroll: a list that
 * pops a menu when the traveller meant to scroll past it is worse than no menu
 * at all. Cancelled by a second finger too -- a pinch is not a long press.
 */
export function longPress(fire: () => void, ms = 450) {
	return (node: HTMLElement) => {
		let timer: ReturnType<typeof setTimeout> | null = null;
		let from: { x: number; y: number } | null = null;

		const stop = () => {
			if (timer) clearTimeout(timer);
			timer = null;
			from = null;
		};

		const down = (e: PointerEvent) => {
			// Secondary buttons are the desktop's own context menu.
			if (e.button !== 0) return;
			from = { x: e.clientX, y: e.clientY };
			timer = setTimeout(() => {
				stop();
				fire();
			}, ms);
		};

		const move = (e: PointerEvent) => {
			if (!from) return;
			if (Math.hypot(e.clientX - from.x, e.clientY - from.y) > 8) stop();
		};

		// The desktop equivalent, so a right click reaches the same menu.
		const menu = (e: MouseEvent) => {
			e.preventDefault();
			fire();
		};

		node.addEventListener('pointerdown', down);
		node.addEventListener('pointermove', move);
		node.addEventListener('pointerup', stop);
		node.addEventListener('pointercancel', stop);
		node.addEventListener('contextmenu', menu);

		return () => {
			stop();
			node.removeEventListener('pointerdown', down);
			node.removeEventListener('pointermove', move);
			node.removeEventListener('pointerup', stop);
			node.removeEventListener('pointercancel', stop);
			node.removeEventListener('contextmenu', menu);
		};
	};
}
