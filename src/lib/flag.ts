/**
 * The flag for an ISO 3166-1 alpha-2 country code, as regional indicator
 * symbols.
 *
 * No network and no asset: 'GB' is two letters offset into the regional
 * indicator block, which every platform with flag glyphs renders as a flag.
 * Windows has no flag font and shows the two letters instead, which is why
 * `flagLabel` exists -- a readable fallback rather than a broken image.
 */
export function flagEmoji(code: string | null | undefined): string | null {
	if (!code) return null;
	const cc = code.trim().toUpperCase();
	if (!/^[A-Z]{2}$/.test(cc)) return null;
	return String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

/** What to show when there is no picture: a flag, or failing that, initials. */
export function flagLabel(code: string | null | undefined, city: string): string {
	return flagEmoji(code) ?? city.trim().slice(0, 2).toUpperCase() ?? '··';
}
