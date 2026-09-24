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
	/** Raw OSM opening_hours string when the source has one. */
	openingHours: string | null;
	/** Worth knowing before turning up, when OSM happens to know it. */
	website: string | null;
	phone: string | null;
	/**
	 * Which source the place came from and its id there: 'osm/node/123',
	 * 'google/ChIJ...'. What keeps the same place off a trip twice.
	 */
	sourceId: string | null;
	/**
	 * Other places of the same name in the same city. Present when the
	 * traveller said any branch will do; the planner then picks whichever is
	 * nearest to where the day has them.
	 */
	branches?: LatLng[];
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
