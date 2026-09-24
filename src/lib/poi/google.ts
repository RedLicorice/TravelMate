import { supabase } from '$lib/supabase';
import { biasPoint, durationFor, safePhone, safeUrl, type TerminalKind } from './photon';
import type { BBox, City, LatLng, Place, Poi, PoiProvider, Terminal } from './types';

/**
 * Place search answered by Google, through the `places` server function --
 * which holds the key and charges each search to the traveller's daily
 * budget. What it answers is put into the same shapes OSM's answers were, so
 * nothing past this file knows the source changed.
 */

type Found = {
	id: string;
	name: string;
	address: string;
	lat: number;
	lng: number;
	type: string | null;
	types: string[];
	countryCode: string | null;
	viewport: BBox | null;
	website: string | null;
	phone: string | null;
	hours: string | null;
};

type Ask =
	| { kind: 'text'; query: string; type?: string; within?: BBox | null; near?: LatLng | null; limit?: number }
	| { kind: 'reverse'; at: LatLng };

async function ask(body: Ask, signal?: AbortSignal): Promise<Found[]> {
	const { data, error } = await supabase.functions.invoke('places', { body, signal });
	if (error) {
		// The function's own word for it -- budget, bad_request, internal --
		// when it gave one, so the screen and the trail can say which.
		const said = await (error as { context?: Response }).context?.json?.().catch(() => null);
		throw new Error(`Place search failed (${said?.error ?? error.message})`);
	}
	return (data?.places ?? []) as Found[];
}

/**
 * Google's words for a place, in the ones the app already reasons with: how
 * long a visit takes, which meals a place suits and when it is busy are all
 * keyed by these. A type with no counterpart is kept as Google says it.
 */
const CATEGORY: Record<string, string> = {
	museum: 'museum',
	art_gallery: 'gallery',
	tourist_attraction: 'attraction',
	historical_landmark: 'monument',
	monument: 'monument',
	observation_deck: 'viewpoint',
	church: 'place_of_worship',
	mosque: 'place_of_worship',
	synagogue: 'place_of_worship',
	hindu_temple: 'place_of_worship',
	place_of_worship: 'place_of_worship',
	park: 'park',
	national_park: 'park',
	garden: 'garden',
	botanical_garden: 'garden',
	zoo: 'zoo',
	aquarium: 'aquarium',
	amusement_park: 'theme_park',
	beach: 'beach',
	restaurant: 'restaurant',
	cafe: 'cafe',
	coffee_shop: 'cafe',
	bakery: 'bakery',
	bar: 'bar',
	pub: 'pub',
	fast_food_restaurant: 'fast_food',
	food_court: 'food_court',
	market: 'marketplace',
	movie_theater: 'cinema',
	performing_arts_theater: 'theatre',
	lodging: 'hotel',
	hotel: 'hotel'
};

function categoryOf(f: Found): string | null {
	if (f.type && CATEGORY[f.type]) return CATEGORY[f.type];
	// Every kind of restaurant -- italian_restaurant, sushi_restaurant -- is a restaurant.
	if (f.type?.endsWith('_restaurant')) return 'restaurant';
	return f.types.map((t) => CATEGORY[t]).find(Boolean) ?? f.type;
}

const toPlace = (f: Found): Place => ({ name: f.name, label: f.address, lat: f.lat, lng: f.lng });

function toPoi(f: Found): Poi {
	const category = categoryOf(f);
	return {
		...toPlace(f),
		category,
		durationMin: durationFor(category),
		openingHours: f.hours,
		website: safeUrl(f.website),
		phone: safePhone(f.phone),
		// Which place this is, so the same one is not put on a trip twice.
		sourceId: `google/${f.id}`
	};
}

function kindOf(f: Found): TerminalKind {
	const has = (t: string) => f.types.includes(t);
	if (has('airport') || has('international_airport')) return 'airport';
	if (has('train_station') || has('subway_station') || has('light_rail_station')) return 'train';
	if (has('bus_station') || has('bus_stop')) return 'bus';
	if (has('ferry_terminal')) return 'ferry';
	return 'other';
}

/** Streets, postcodes and whole regions: never somewhere a traveller visits. */
const NOT_A_STOP = new Set([
	'street_address',
	'route',
	'premise',
	'subpremise',
	'postal_code',
	'locality',
	'sublocality',
	'neighborhood',
	'political',
	'country',
	'administrative_area_level_1',
	'administrative_area_level_2'
]);

export const google: PoiProvider = {
	attribution: 'Google Maps',

	async searchCities(query, signal) {
		const found = await ask({ kind: 'text', query, type: 'locality', limit: 6 }, signal);
		// A town Google does not call a locality is still a town: asked again,
		// untyped, rather than showing nothing.
		const rows = found.length ? found : await ask({ kind: 'text', query, limit: 6 }, signal);
		return rows.map(
			(f): City => ({ ...toPlace(f), countryCode: f.countryCode, bbox: f.viewport })
		);
	},

	async searchHotels(query, city, signal) {
		const within = city.bbox;
		const near = within ? null : biasPoint(city);
		const found = await ask({ kind: 'text', query, type: 'lodging', within, near, limit: 8 }, signal);
		// Guesthouses and flats are not always lodging to Google either.
		const rows = found.length ? found : await ask({ kind: 'text', query, within, near, limit: 8 }, signal);
		return rows.map(toPlace);
	},

	async searchPlaces(query, city, signal) {
		const within = city.bbox;
		const near = within ? null : biasPoint(city);
		const rows = await ask({ kind: 'text', query, within, near, limit: 12 }, signal);
		return rows
			.filter((f) => !(f.type && NOT_A_STOP.has(f.type)))
			.map(toPoi)
			.slice(0, 10);
	},

	async searchAddresses(query, city, signal) {
		// Houses and streets are the answer here, so nothing is filtered out.
		const within = city?.bbox ?? null;
		const near = within ? null : biasPoint(city);
		return (await ask({ kind: 'text', query, within, near, limit: 8 }, signal)).map(toPoi);
	},

	async searchTerminals(query, city, signal) {
		// Biased, never bounded: an airport usually sits outside the city it
		// serves. And unfiltered, so a journey can start at a car park or a
		// friend's house.
		const rows = await ask({ kind: 'text', query, near: biasPoint(city), limit: 12 }, signal);
		return rows.map((f): Terminal => ({ ...toPlace(f), kind: kindOf(f) }));
	},

	async reverse(lat, lng, signal) {
		const [f] = await ask({ kind: 'reverse', at: { lat, lng } }, signal).catch(() => []);
		return f ? toPoi(f) : null;
	}
};
