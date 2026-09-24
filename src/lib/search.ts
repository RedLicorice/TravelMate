/**
 * How long a search box waits after the last keystroke before searching.
 *
 * Every search is a billed Google call, and a call already sent is billed
 * even when the next keystroke cancels it -- so the box waits for a pause
 * rather than asking at every letter. The lens button, or Enter, searches at
 * once for whoever does not want to wait.
 */
export const SEARCH_DEBOUNCE_MS = 750;

/** Text as a search compares it: no case, no accents -- "Café" is "cafe". */
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/**
 * Full-text match: every word of the query appears somewhere in the fields,
 * in any order. "kyoto ramen" finds the ramen shop whose address is in
 * Kyoto. An empty query matches everything.
 */
export function matchesAll(query: string, fields: (string | null | undefined)[]): boolean {
	const words = fold(query).split(/\s+/).filter(Boolean);
	if (!words.length) return true;
	const haystack = fold(fields.filter(Boolean).join('\n'));
	return words.every((w) => haystack.includes(w));
}
