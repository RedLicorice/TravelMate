/**
 * What a paid function will accept from a caller.
 *
 * Everything here is sent by a browser we do not control, and everything it
 * reaches costs money: a coordinate goes into a billed request, a mode picks
 * the upstream product, a departure becomes a cache key. A bad value does not
 * fail cheaply -- `TRAVEL_MODE[mode]` with mode "constructor" answers with an
 * inherited function, which JSON.stringify drops, which bills a drive the
 * traveller never asked for. So the shape is checked once, at the door.
 */

export type LatLng = { lat: number; lng: number };
export type Mode = 'walk' | 'bike' | 'transit' | 'car' | 'carshare';

/** A Set, not an object: `has` cannot be answered by the prototype. */
const MODES: ReadonlySet<string> = new Set(['walk', 'bike', 'transit', 'car', 'carshare']);

export const isMode = (m: unknown): m is Mode => typeof m === 'string' && MODES.has(m);

export const isPoint = (p: unknown): p is LatLng =>
	!!p &&
	typeof p === 'object' &&
	Number.isFinite((p as LatLng).lat) &&
	Number.isFinite((p as LatLng).lng) &&
	Math.abs((p as LatLng).lat) <= 90 &&
	Math.abs((p as LatLng).lng) <= 180;

/** Absent is fine; present and unparseable is not -- it buckets to "hNaN". */
export const isWhen = (t: unknown): t is string | null | undefined =>
	t === null || t === undefined || (typeof t === 'string' && !Number.isNaN(Date.parse(t)));
