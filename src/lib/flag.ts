/**
 * A country's flag, as a picture: country-flag-icons' SVG for an ISO 3166-1
 * alpha-2 code. Drawn, not an emoji -- the app uses none.
 *
 * Each flag is its own file, fetched only for a trip that needs it; the other
 * two hundred and sixty stay on the server.
 */
const FLAGS = import.meta.glob<string>('../../node_modules/country-flag-icons/3x2/*.svg', {
	query: '?url',
	import: 'default'
});

/** The flag's address, or null when there is no code or no flag for it. */
export async function flagUrl(code: string | null | undefined): Promise<string | null> {
	const cc = code?.trim().toUpperCase();
	if (!cc || !/^[A-Z]{2}$/.test(cc)) return null;
	const load = FLAGS[`../../node_modules/country-flag-icons/3x2/${cc}.svg`];
	return load ? load() : null;
}

/** What to show when there is neither a picture nor a flag: the city's first letters. */
export const initials = (city: string) => city.trim().slice(0, 2).toUpperCase() || '··';
