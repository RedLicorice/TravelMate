import type { BBox, City, Place, PoiProvider } from './types';

const ENDPOINT = 'https://nominatim.openstreetmap.org/search';

/** Raw Nominatim jsonv2 row. Only the fields actually read are declared. */
export type NominatimRow = {
	name?: string;
	display_name: string;
	lat: string;
	lon: string;
	category?: string;
	type?: string;
	boundingbox?: [string, string, string, string];
	address?: { country_code?: string };
};

/** Nominatim orders boundingbox [south, north, west, east], all as strings. */
export function toBBox(raw: NominatimRow['boundingbox']): BBox | null {
	if (!raw || raw.length !== 4) return null;
	const [south, north, west, east] = raw.map(Number);
	return [south, north, west, east].some(Number.isNaN) ? null : { south, north, west, east };
}

/** The leading segment of display_name is the entity; the rest is context. */
export function toPlace(row: NominatimRow): Place {
	const [head, ...rest] = row.display_name.split(',').map((s) => s.trim());
	return {
		name: row.name?.trim() || head,
		label: rest.join(', ') || head,
		lat: Number(row.lat),
		lng: Number(row.lon)
	};
}

export function toCity(row: NominatimRow): City {
	return {
		...toPlace(row),
		countryCode: row.address?.country_code?.toUpperCase() ?? null,
		bbox: toBBox(row.boundingbox)
	};
}

async function get(params: Record<string, string>, signal?: AbortSignal): Promise<NominatimRow[]> {
	const url = `${ENDPOINT}?${new URLSearchParams({ format: 'jsonv2', ...params })}`;
	const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
	if (!res.ok) throw new Error(`Place search failed (${res.status})`);
	return res.json();
}

export const nominatim: PoiProvider = {
	attribution: '© OpenStreetMap contributors',

	async searchCities(query, signal) {
		const rows = await get(
			{ q: query, limit: '6', featureType: 'city', addressdetails: '1' },
			signal
		);
		return rows.map(toCity);
	},

	async searchHotels(query, city, signal) {
		// Bound to the city's own box so 'Premier Inn' does not return one in
		// another country. Without a box Nominatim ranks globally.
		const params: Record<string, string> = { q: query, limit: '8', addressdetails: '1' };
		if (city.bbox) {
			params.viewbox = `${city.bbox.west},${city.bbox.north},${city.bbox.east},${city.bbox.south}`;
			params.bounded = '1';
		}
		const rows = await get(params, signal);
		// Nominatim returns shops and landuse alongside hotels for a brand name.
		const lodging = rows.filter((r) => r.category === 'tourism' || r.type === 'hotel');
		return (lodging.length ? lodging : rows).map(toPlace);
	}
};
