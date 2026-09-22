/**
 * The minutes past midnight a card's own time label covers.
 *
 * Journey cards cost the day nothing -- the flight happened before the trip's
 * clock started -- so the planner gives them all the same instant and zero
 * length. Their real hours are on the label, and that is what a card must
 * show.
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

/** Minutes past midnight as 'HH:MM'. */
export const hhmmOf = (min: number) =>
	`${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(Math.round(min) % 60).padStart(2, '0')}`;

/**
 * The same two times, kept apart.
 *
 * A card shows them stacked with a rule between, so they have to be handed
 * over separately rather than already joined by a dash.
 */
export function cardTimes(
	label: string | null | undefined,
	clock: string,
	durationMin: number
): { from: string; to: string } {
	const [from, to] = cardTime(label, clock, durationMin).split('–');
	return { from, to: to ?? from };
}

/**
 * What a card says about its own time: begin and end whenever both are known,
 * and just the begin when the card has no length.
 *
 * `label` is the card's own stated time, which wins because it came off a
 * ticket. A span is used as it stands; a moment is the start, and the duration
 * supplies the end. With no label at all the planner's clock is the start.
 */
export function cardTime(label: string | null | undefined, clock: string, durationMin: number): string {
	const stated = spanOf(label);
	if (stated && stated.to > stated.from) return `${hhmmOf(stated.from)}–${hhmmOf(stated.to)}`;

	const from = stated?.from ?? spanOf(clock)?.from;
	if (from === undefined) return clock;

	// Both ends, always. A card showing one time says nothing about how long
	// it lasts, and a stop with no length is still a moment that begins and
	// ends -- reading 09:00–09:00 is how the plan says "this takes no time".
	return `${hhmmOf(from)}–${hhmmOf(from + durationMin)}`;
}
