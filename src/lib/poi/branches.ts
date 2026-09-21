import type { LatLng, Poi } from './types';

/**
 * Two names that mean the same shop.
 *
 * OSM spells a chain several ways -- "MeatLiquor", "Meat Liquor",
 * "Pret A Manger", "Pret a Manger (Oxford St)" -- so the comparison drops
 * case, punctuation and anything in brackets, which is where the branch is
 * usually written.
 */
export const sameBrand = (a: string, b: string) => brandOf(a) === brandOf(b);

export const brandOf = (name: string) =>
	name
		.replace(/\([^)]*\)/g, ' ')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '');

/**
 * The other results that are the same shop as `pick`.
 *
 * Empty when it is the only one, which is the common case and the one that
 * must stay quiet: a traveller adding the Tate Modern should not be asked
 * whether they meant any Tate.
 */
export function branchesOf(pick: Poi, results: Poi[]): LatLng[] {
	const here = (p: { lat: number; lng: number }) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;
	const mine = here(pick);
	const seen = new Set([mine]);
	const out: LatLng[] = [{ lat: pick.lat, lng: pick.lng }];

	for (const r of results) {
		if (!sameBrand(r.name, pick.name)) continue;
		const key = here(r);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ lat: r.lat, lng: r.lng });
	}
	return out.length > 1 ? out : [];
}

/** The branch nearest `from`, or the place itself when it has none. */
export function nearestBranch(
	place: { lat: number; lng: number; branches?: LatLng[] | null },
	from: LatLng,
	distance: (a: LatLng, b: LatLng) => number
): LatLng {
	const here = { lat: place.lat, lng: place.lng };
	if (!place.branches?.length) return here;
	return place.branches.reduce(
		(best, b) => (distance(from, b) < distance(from, best) ? b : best),
		here
	);
}
