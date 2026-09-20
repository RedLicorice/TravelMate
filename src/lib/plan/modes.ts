import type { LatLng } from '$lib/trip/days';
import { DETOUR, haversineKm } from './geo';

export type Mode = 'walk' | 'bike' | 'transit' | 'car' | 'carshare';

export type Leg = { mode: Mode; minutes: number; km: number };

/** km/h, before the detour factor. */
const SPEED: Record<Mode, number> = { walk: 4.5, bike: 13, transit: 18, car: 25, carshare: 25 };

/**
 * Flat overhead on any transit leg: walking to the stop, waiting, and walking
 * off at the far end. Not just the wait -- pricing only the wait at 6 minutes
 * makes transit beat walking from 600m, which is wrong on the street and would
 * have the planner put people on a bus for a seven-minute stroll. At 12 the
 * break-even lands near 1.2km, which is where the walk band ends.
 */
const TRANSIT_OVERHEAD_MIN = 12;

/** Preference order by distance band, filtered by what the traveller allows. */
function candidates(km: number, terminal: boolean): Mode[] {
	// Nobody walks or cycles to an airport with luggage.
	if (terminal) return ['transit', 'car', 'carshare'];
	if (km < 1.2) return ['walk', 'bike', 'transit', 'car', 'carshare'];
	if (km < 5) return ['bike', 'transit', 'car', 'carshare', 'walk'];
	return ['transit', 'car', 'carshare', 'bike', 'walk'];
}

export function chooseMode(km: number, allowed: Mode[], terminal = false): Mode {
	const preferred = candidates(km, terminal).find((m) => allowed.includes(m));
	// Always terminates: a leg must have an answer even when the traveller
	// allowed only modes that make no sense for this distance.
	return preferred ?? allowed[0] ?? 'walk';
}

export function leg(from: LatLng, to: LatLng, allowed: Mode[], terminal = false): Leg {
	const km = haversineKm(from, to) * DETOUR;
	const mode = chooseMode(km, allowed, terminal);
	const minutes = (km / SPEED[mode]) * 60 + (mode === 'transit' ? TRANSIT_OVERHEAD_MIN : 0);
	return { mode, minutes: Math.round(minutes), km: Math.round(km * 10) / 10 };
}
