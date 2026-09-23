import { google } from './google';
export type { BBox, City, Place, Poi, PoiProvider, Terminal } from './types';
export { ADVANCE_DEFAULT, terminalKind, type TerminalKind } from './photon';

/**
 * The active provider: Google, through the `places` server function, which
 * keeps the key and charges each search to the traveller's daily budget.
 * Photon -- free, keyless, OSM -- is still here, one changed line away.
 */
export const poi = google;
