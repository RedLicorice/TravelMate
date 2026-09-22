import type { LatLng } from '$lib/trip/days';
import { DETOUR, haversineKm } from './geo';
import { noTravel, type TravelTable } from './travel';

export type Mode = 'walk' | 'bike' | 'transit' | 'car' | 'carshare';

/**
 * Where a leg's numbers came from.
 *
 * 'estimate' is the speed model, or a matrix cell: good enough to order a day
 * by, and shown with a star. 'routed' came back from the routing service for
 * this journey at this hour, and is what the day is actually timed on.
 */
export type LegSource = 'estimate' | 'routed';

export type Leg = { mode: Mode; minutes: number; km: number; source: LegSource };

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

export function leg(
	from: LatLng,
	to: LatLng,
	allowed: Mode[],
	terminal = false,
	travel: TravelTable = noTravel,
	departAt: string | null = null
): Leg {
	// Mode is still chosen on straight-line distance: it decides which network
	// to use, and a routed distance would not change that answer.
	const km = haversineKm(from, to) * DETOUR;
	const mode = chooseMode(km, allowed, terminal);

	// Going nowhere takes no time. Without this the transit overhead -- a flat
	// allowance for walking to the stop and waiting -- was charged on a leg of
	// zero length, which is what put "12 min · 0 km · transit" between two
	// cards standing in the same airport, and quietly spent an hour of the
	// arrival day on a journey that had already happened.
	// Routed, not estimated: there is nothing to look up about standing still,
	// so nothing will ever come back to improve it.
	if (km === 0) return { mode, minutes: 0, km: 0, source: 'routed' };

	// A time somebody resolved ahead of planning. A matrix cell is still an
	// estimate -- it was asked at the day's start hour, for every pair at once
	// -- so only a table that says 'routed' is taken as the real journey.
	const known = travel.get(from, to, mode, departAt);
	if (known) {
		return { mode, minutes: known.minutes, km: known.km, source: known.source ?? 'estimate' };
	}

	const minutes = (km / SPEED[mode]) * 60 + (mode === 'transit' ? TRANSIT_OVERHEAD_MIN : 0);
	return {
		mode,
		minutes: Math.round(minutes),
		km: Math.round(km * 10) / 10,
		source: 'estimate'
	};
}
