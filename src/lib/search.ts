/**
 * How long a search box waits after the last keystroke before searching.
 *
 * Every search is a billed Google call, and a call already sent is billed
 * even when the next keystroke cancels it -- so the box waits for a pause
 * rather than asking at every letter. The lens button, or Enter, searches at
 * once for whoever does not want to wait.
 */
export const SEARCH_DEBOUNCE_MS = 750;
