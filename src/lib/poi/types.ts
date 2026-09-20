export type BBox = { south: number; north: number; west: number; east: number };

export type Place = {
	/** Short name for display, e.g. 'Premier Inn Ealing'. */
	name: string;
	/** Full context line, e.g. 'Ealing, London, United Kingdom'. */
	label: string;
	lat: number;
	lng: number;
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
}
