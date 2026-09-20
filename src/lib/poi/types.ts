export type BBox = { south: number; north: number; west: number; east: number };

export type Place = {
	/** Short name for display, e.g. 'Premier Inn Ealing'. */
	name: string;
	/** Full context line, e.g. 'Ealing, London, United Kingdom'. */
	label: string;
	lat: number;
	lng: number;
};

export type Poi = Place & {
	/** OSM category, e.g. 'museum'. Drives the duration default and crowd curve. */
	category: string | null;
	/** Minutes a visit typically takes. A default, always editable. */
	durationMin: number;
	/** Raw OSM opening_hours string when the source has one. */
	openingHours: string | null;
	/** Worth knowing before turning up, when OSM happens to know it. */
	website: string | null;
	phone: string | null;
	osmId: string | null;
};

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
}
