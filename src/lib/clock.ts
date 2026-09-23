/**
 * A date formatter, built once for each locale and set of options.
 *
 * Building one is slow and using one is fast, and the planner reads local
 * clocks thousands of times a walk -- every card of every day, every hour it
 * tries. Built fresh each time, that was a large share of every redraw.
 */
const made = new Map<string, Intl.DateTimeFormat>();

export function formatter(
	locale: string | undefined,
	options: Intl.DateTimeFormatOptions
): Intl.DateTimeFormat {
	const key = `${locale ?? ''}|${JSON.stringify(options)}`;
	let f = made.get(key);
	if (!f) made.set(key, (f = new Intl.DateTimeFormat(locale, options)));
	return f;
}
