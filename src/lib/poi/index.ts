import { photon } from './photon';
export type { BBox, City, Place, Poi, PoiProvider, Terminal } from './types';
export { ADVANCE_DEFAULT, terminalKind, type TerminalKind } from './photon';

/**
 * The active provider. Photon answers partial words as the traveller types,
 * which is what a picker needs; Nominatim requires whole words. Both are free,
 * keyless, and read the same OSM data.
 *
 * Swapping to Google Places is a changed import here plus one new file
 * implementing PoiProvider. No caller changes.
 */
export const poi = photon;
