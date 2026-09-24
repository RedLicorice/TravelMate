import type { BBox, City, Place, Poi, PoiProvider } from './types';

const ENDPOINT = 'https://photon.komoot.io/api/';

/**
 * Photon feature. Only the fields actually read are declared; Photon returns
 * a different property set depending on what kind of thing matched.
 */
export type PhotonFeature = {
	geometry: { coordinates: [number, number] }; // [lon, lat]
	properties: {
		name?: string;
		osm_key?: string;
		osm_value?: string;
		osm_type?: string;
		osm_id?: number;
		country?: string;
		countrycode?: string;
		state?: string;
		county?: string;
		city?: string;
		district?: string;
		street?: string;
		housenumber?: string;
		postcode?: string;
		/** [west, north, east, south] -- not the order any other API uses. */
		extent?: [number, number, number, number];
		extra?: Record<string, string>;
	};
};

/**
 * How long a visit takes, by OSM value. Rough on purpose: the traveller can
 * edit it, and a visible wrong default beats a prompt that blocks capture.
 */
const DURATION_MIN: Record<string, number> = {
	// An activity is however long the traveller says; two hours is the length
	// of an afternoon's worth of one, which is what people ask for.
	activity: 120,
	museum: 120,
	gallery: 90,
	artwork: 15,
	attraction: 60,
	viewpoint: 20,
	castle: 90,
	ruins: 60,
	archaeological_site: 90,
	monument: 20,
	memorial: 15,
	place_of_worship: 30,
	cathedral: 45,
	park: 45,
	garden: 45,
	zoo: 120,
	aquarium: 90,
	theme_park: 240,
	restaurant: 75,
	cafe: 30,
	bar: 60,
	pub: 60,
	marketplace: 45,
	theatre: 150,
	cinema: 130,
	beach: 120,
	hotel: 0
};

/**
 * Something the traveller means to do rather than somewhere to go: two hours
 * shopping around Oxford Street, an afternoon walking in Hyde Park. It has a
 * place and a length, and no opening hours to keep.
 */
export const ACTIVITY_CATEGORY = 'activity';

export function durationFor(value: string | null): number {
	return DURATION_MIN[value ?? ''] ?? 60;
}

/** Photon's extent is [west, north, east, south]. Nothing else uses that order. */
export function toBBox(extent: PhotonFeature['properties']['extent']): BBox | null {
	if (!extent || extent.length !== 4) return null;
	const [west, north, east, south] = extent;
	return [west, north, east, south].some((n) => typeof n !== 'number' || Number.isNaN(n))
		? null
		: { south, north, west, east };
}

/** The context line under the name: street, area, region, country. */
export function contextOf(p: PhotonFeature['properties']): string {
	const street = [p.housenumber, p.street].filter(Boolean).join(' ');
	return [street, p.district, p.city, p.state, p.country].filter(Boolean).join(', ');
}

export function toPlace(f: PhotonFeature): Place {
	const p = f.properties;
	const [lng, lat] = f.geometry.coordinates;
	return {
		name: p.name?.trim() || p.street?.trim() || p.city?.trim() || 'Unnamed place',
		label: contextOf(p) || p.country || '',
		lat,
		lng
	};
}

export function toCity(f: PhotonFeature): City {
	return {
		...toPlace(f),
		countryCode: f.properties.countrycode?.toUpperCase() ?? null,
		bbox: toBBox(f.properties.extent)
	};
}

export function toPoi(f: PhotonFeature): Poi {
	const p = f.properties;
	const category = p.osm_value ?? p.osm_key ?? null;
	return {
		...toPlace(f),
		category,
		durationMin: durationFor(category),
		openingHours: p.extra?.opening_hours ?? null,
		// OSM tags these inconsistently; both spellings are common. Both are
		// validated here so nothing unsafe is ever stored, not just never shown.
		website: safeUrl(p.extra?.website ?? p.extra?.['contact:website']),
		phone: safePhone(p.extra?.phone ?? p.extra?.['contact:phone']),
		sourceId: p.osm_type && p.osm_id ? `osm/${p.osm_type}/${p.osm_id}` : null
	};
}

/**
 * OSM tags are editable by anyone, so a `website` tag can carry any scheme --
 * including `javascript:`, which would run in this app's origin, where the
 * session lives. Only http(s) survives, and only as an absolute URL.
 */
export function safeUrl(raw: string | undefined | null): string | null {
	if (!raw) return null;
	try {
		const url = new URL(raw.trim());
		return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
	} catch {
		// Not absolute, so not something to hand to an href.
		return null;
	}
}

/** Conservative: digits and the punctuation real numbers use, nothing else. */
export function safePhone(raw: string | undefined | null): string | null {
	if (!raw) return null;
	const trimmed = raw.trim();
	return /^[+０-９0-9][0-9\s\-().]{3,30}$/.test(trimmed) ? trimmed : null;
}

/** Where a journey starts and ends, and how early to be there. */
export type TerminalKind = 'airport' | 'train' | 'bus' | 'ferry' | 'other';

/** Minutes to be there before departure. Airports ask far more of you. */
export const ADVANCE_DEFAULT: Record<TerminalKind, number> = {
	airport: 120,
	train: 60,
	bus: 60,
	ferry: 90,
	other: 60
};

/** OSM's own words for these places, mapped to ours. */
export function terminalKind(osmValue: string | null | undefined): TerminalKind {
	switch (osmValue) {
		case 'aerodrome':
		case 'airport':
			return 'airport';
		case 'station':
		case 'halt':
			return 'train';
		case 'bus_station':
			return 'bus';
		case 'ferry_terminal':
			return 'ferry';
		default:
			return 'other';
	}
}

/** Anything a traveller would never choose to "visit". */
const NOT_A_STOP = new Set(['house', 'residential', 'street', 'postcode', 'yes', 'commercial']);

async function get(params: Record<string, string>, signal?: AbortSignal): Promise<PhotonFeature[]> {
	const url = `${ENDPOINT}?${new URLSearchParams({ lang: 'en', ...params })}`;
	const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
	if (!res.ok) throw new Error(`Place search failed (${res.status})`);
	const body = await res.json();
	return body.features ?? [];
}

/** Photon wants bbox as minLon,minLat,maxLon,maxLat. */
const asParam = (b: BBox) => `${b.west},${b.south},${b.east},${b.north}`;

/**
 * A point to rank results around. Prefers the city's own coordinates, falls
 * back to the centre of its box -- screens built from a stored trip know the
 * box but not the original city pin, and 0,0 would bias every search to the
 * Gulf of Guinea.
 */
export function biasPoint(city: City | null): { lat: number; lng: number } | null {
	if (!city) return null;
	if (city.lat !== 0 || city.lng !== 0) return { lat: city.lat, lng: city.lng };
	if (city.bbox) {
		return {
			lat: (city.bbox.south + city.bbox.north) / 2,
			lng: (city.bbox.west + city.bbox.east) / 2
		};
	}
	return null;
}

/**
 * Photon is a search-as-you-type geocoder over the same OSM data as Nominatim.
 * It answers partial words ('lond', 'premier i'), which Nominatim does not, and
 * that is the whole reason this is the provider rather than that one.
 */
export const photon: PoiProvider = {
	attribution: '© OpenStreetMap contributors · Photon',

	async searchCities(query, signal) {
		const rows = await get({ q: query, limit: '6', layer: 'city' }, signal);
		// A country with no city match is useless here, but a town is not, so
		// fall back to an unlayered search rather than showing nothing.
		const features = rows.length ? rows : await get({ q: query, limit: '6' }, signal);
		return features.map(toCity);
	},

	async searchHotels(query, city, signal) {
		const params: Record<string, string> = { q: query, limit: '8', osm_tag: 'tourism:hotel' };
		if (city.bbox) params.bbox = asParam(city.bbox);
		const rows = await get(params, signal);
		// Falling back unfiltered catches guesthouses and hostels, which are not
		// tagged tourism:hotel but are still where somebody is sleeping.
		const features = rows.length
			? rows
			: (await get({ q: query, limit: '8', ...(city.bbox ? { bbox: asParam(city.bbox) } : {}) }, signal));
		return features.map(toPlace);
	},

	async searchAddresses(query, city, signal) {
		// Deliberately unfiltered: NOT_A_STOP exists to keep houses and streets
		// out of a "what shall we see" search, and an address search is exactly
		// the case where a house number is the answer.
		const params: Record<string, string> = { q: query, limit: '8' };
		if (city?.bbox) params.bbox = asParam(city.bbox);
		return (await get(params, signal)).map(toPoi);
	},

	async reverse(lat, lng, signal) {
		const url = `https://photon.komoot.io/reverse?${new URLSearchParams({
			lat: String(lat),
			lon: String(lng),
			limit: '1',
			lang: 'en'
		})}`;
		const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
		if (!res.ok) return null;
		const body = await res.json();
		const [feature] = (body.features ?? []) as PhotonFeature[];
		return feature ? toPoi(feature) : null;
	},

	async searchTerminals(query, city, signal) {
		// Everything, not a chosen four. Filtering to airports, stations, coach
		// and ferry meant a journey could not start at a car park, a hotel
		// shuttle stop, a port gate or the friend's house being driven from --
		// the search quietly refused to find what was typed. Results are biased
		// towards the city and otherwise left alone.
		//
		// Biased, never bounded: Stansted sits 20km north of London's own
		// bounding box, as most airports sit outside the city they serve, and
		// bounding the search hides exactly the airport wanted.
		const near = biasPoint(city);
		const params = new URLSearchParams({ lang: 'en', q: query, limit: '12' });
		if (near) {
			params.set('lat', String(near.lat));
			params.set('lon', String(near.lng));
		}
		const url = `${ENDPOINT}?${params}`;
		const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
		if (!res.ok) throw new Error(`Terminal search failed (${res.status})`);
		const body = await res.json();
		return ((body.features ?? []) as PhotonFeature[])
			.filter((f) => f.properties.name)
			.map((f) => ({ ...toPlace(f), kind: terminalKind(f.properties.osm_value) }));
	},

	async searchPlaces(query, city, signal) {
		const params: Record<string, string> = { q: query, limit: '12' };
		if (city.bbox) params.bbox = asParam(city.bbox);
		const rows = await get(params, signal);
		return rows
			.filter((f) => f.properties.name)
			.filter((f) => !NOT_A_STOP.has(f.properties.osm_value ?? ''))
			.map(toPoi)
			.slice(0, 10);
	}
};
