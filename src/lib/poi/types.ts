import type { OpeningPeriod } from '$lib/plan/hours';

export type BBox = { south: number; north: number; west: number; east: number };

export type Place = {
	/** Short name for display, e.g. 'Premier Inn Ealing'. */
	name: string;
	/** Full context line, e.g. 'Ealing, London, United Kingdom'. */
	label: string;
	lat: number;
	lng: number;
};

export type LatLng = { lat: number; lng: number };

export type Poi = Place & {
	/** Category, e.g. 'museum'. Drives the duration default and crowd curve. */
	category: string | null;
	/** Minutes a visit typically takes. A default, always editable. */
	durationMin: number;
	/** Opening hours as text to show, when the source has them. */
	openingHours: string | null;
	/** Opening hours as data the planner reads (Google's periods); absent from sources without them. */
	openingPeriods?: OpeningPeriod[] | null;
	/** Worth knowing before turning up, when OSM happens to know it. */
	website: string | null;
	phone: string | null;
	/**
	 * Which source the place came from and its id there: 'osm/node/123',
	 * 'google/ChIJ...'. What keeps the same place off a trip twice.
	 */
	sourceId: string | null;
	/**
	 * Other places of the same name the search found, as points. Kept
	 * whichever branch the traveller meant, so they can change their mind
	 * later without searching again.
	 */
	branches?: LatLng[];
	/** Any branch will do: the planner then picks whichever is nearest to where the day has them. */
	anyBranch?: boolean;
};

/** An airport, station, coach station or ferry terminal. */
export type Terminal = Place & { kind: 'airport' | 'train' | 'bus' | 'ferry' | 'other' };

export type City = Place & {
	countryCode: string | null;
	/** Used to bound a later hotel search to this city. */
	bbox: BBox | null;
};

/**
 * The seam. Swapping Nominatim for Google Places is one new file implementing
 * this and a changed import in index.ts -- no caller changes.
 */
export interface PoiProvider {
	readonly attribution: string;
	searchCities(query: string, signal?: AbortSignal): Promise<City[]>;
	searchHotels(query: string, city: City, signal?: AbortSignal): Promise<Place[]>;
	searchPlaces(query: string, city: City, signal?: AbortSignal): Promise<Poi[]>;
	/** Bounded loosely: an airport often sits outside the city's own box. */
	searchTerminals(query: string, city: City | null, signal?: AbortSignal): Promise<Terminal[]>;
	/** Houses and streets included -- the opposite of searchPlaces. */
	searchAddresses(query: string, city: City | null, signal?: AbortSignal): Promise<Poi[]>;
	/** What is at this point, for naming a dropped pin. */
	reverse(lat: number, lng: number, signal?: AbortSignal): Promise<Poi | null>;
}
