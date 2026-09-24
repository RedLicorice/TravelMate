/**
 * Opening hours, as Google gives them: periods in the place's local time,
 * day 0 = Sunday. A period with no close is open round the clock.
 *
 * Worked in minutes of the local week (0 = Sunday 00:00), so a period that
 * runs past midnight, or past Saturday night into Sunday, is one interval.
 */
export type OpeningPeriod = {
	open: { day: number; hour: number; minute?: number };
	close?: { day: number; hour: number; minute?: number };
};

const WEEK = 7 * 24 * 60;
const DAY_OF: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formats = new Map<string, Intl.DateTimeFormat>();

/** An instant as minutes into its local week. */
function minuteOfWeek(ms: number, tz: string): number {
	let f = formats.get(tz);
	if (!f) {
		f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
		formats.set(tz, f);
	}
	const parts = f.formatToParts(new Date(ms));
	const get = (t: string) => parts.find((p) => p.type === t)!.value;
	return DAY_OF[get('weekday')] * 1440 + (Number(get('hour')) % 24) * 60 + Number(get('minute'));
}

/** Every opening as [open, close) in minutes of the week, repeated a week either side. */
function intervals(periods: OpeningPeriod[]): [number, number][] {
	const out: [number, number][] = [];
	for (const p of periods) {
		const open = p.open.day * 1440 + p.open.hour * 60 + (p.open.minute ?? 0);
		let close = p.close ? p.close.day * 1440 + p.close.hour * 60 + (p.close.minute ?? 0) : open + WEEK;
		if (close <= open) close += WEEK;
		for (const shift of [-WEEK, 0, WEEK]) out.push([open + shift, close + shift]);
	}
	return out;
}

/**
 * Whether the place is open for the whole visit, from `start` for
 * `minutes`. Unknown hours (null or empty) are never a reason to object.
 */
export function openThrough(periods: OpeningPeriod[] | null | undefined, start: number, minutes: number, tz: string): boolean {
	if (!periods?.length) return true;
	const from = minuteOfWeek(start, tz);
	return intervals(periods).some(([o, c]) => o <= from && from + minutes <= c);
}

/**
 * The earliest moment from `start` at which a whole visit of `minutes` fits
 * inside an opening, no later than `latest`; null when none does.
 */
export function nextOpenStart(
	periods: OpeningPeriod[] | null | undefined,
	start: number,
	minutes: number,
	latest: number,
	tz: string
): number | null {
	if (!periods?.length) return start;
	const from = minuteOfWeek(start, tz);
	let best: number | null = null;
	for (const [o, c] of intervals(periods)) {
		const begin = Math.max(o, from);
		if (begin + minutes > c) continue;
		const at = start + (begin - from) * 60_000;
		if (at <= latest && (best === null || at < best)) best = at;
	}
	return best;
}
