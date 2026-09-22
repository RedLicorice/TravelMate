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

		/**
		 * Eat the click the finger makes when it lifts.
		 *
		 * The menu opens while the finger is still down, so whatever the menu
		 * puts under that finger -- its own backdrop -- receives the click that
		 * ends the press and closes again immediately. Swallowed at the capture
		 * phase, before it reaches anything, and given up after a moment in
		 * case no click follows at all.
		 */
		const swallowNextClick = () => {
			const eat = (e: Event) => {
				e.preventDefault();
				e.stopPropagation();
				clearTimeout(giveUp);
			};
			const off = () => window.removeEventListener('click', eat, true);
			const giveUp = setTimeout(off, 700);
			window.addEventListener('click', eat, { capture: true, once: true });
		};

		const down = (e: PointerEvent) => {
			// Secondary buttons are the desktop's own context menu.
			if (e.button !== 0) return;
			// A press that starts on a drag handle belongs to the drag. Holding
			// the handle still for half a second while working out where to put
			// something would otherwise open the card over the top of it.
			if ((e.target as HTMLElement | null)?.closest('[data-grab]')) return;
			from = { x: e.clientX, y: e.clientY };
			timer = setTimeout(() => {
				stop();
				swallowNextClick();
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
