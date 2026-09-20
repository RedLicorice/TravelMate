import { nominatim } from './nominatim';
export type { BBox, City, Place, PoiProvider } from './types';

/**
 * The active provider. Nominatim needs no key and no billing relationship,
 * which is why it ships first. Swapping to Google Places is a changed import
 * here plus one new file implementing PoiProvider.
 */
export const poi = nominatim;
