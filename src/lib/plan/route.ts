import type { LatLng } from '$lib/trip/days';
import { supabase } from '$lib/supabase';
import { haversineKm } from './geo';
import { departBucket } from './travel';
import type { Mode } from './modes';

const pointKeyOf = (p: LatLng) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;

export type RouteStep = {
	kind: 'transit' | 'walk' | 'drive' | 'wait';
	/** Raw, so steps sum without the drift of rounding each one. */
	seconds: number;
	line?: string;
	headsign?: string;
	from?: string;
	to?: string;
	departAt?: string;
	arriveAt?: string;
	minutes: number;
	stops?: number;
	instruction?: string;
};

export type LegRoute = {
	/** Door to door, waits included -- what the leg actually costs. */
	minutes: number;
	/**
	 * Time actually moving. Google's own duration, which excludes waiting for
	 * the first service: the difference is time standing on a platform.
	 */
	movingMinutes: number;
	km: number;
	polyline: string | null;
	steps: RouteStep[];
	source: 'google' | 'cache';
	/** One line telling this route from the others: its lines, or its road. */
	summary: string;
};

/** Held for this visit only: the path is never stored anywhere. */
const legCache = new Map<string, LegRoute[]>();

/**
 * The routes Google offers for one leg, the one it recommends first: what to
 * catch, how long it takes, and the line to draw. Empty when it has none.
 *
 * Asked only for a journey the traveller is looking at -- a sheet opened on
 * it -- never for every pair, and never kept beyond this visit.
 */
export async function legRoutes(
	from: LatLng,
	to: LatLng,
	mode: Mode,
	departAt: string | null,
	options: { prefer?: 'rail' | null } = {}
): Promise<LegRoute[] | null> {
	// Two cards standing in the same place: there is no journey to route, and
	// asking costs a billed element to be told so.
	if (pointKeyOf(from) === pointKeyOf(to)) return [];

	const prefer =
		// Left to itself the router puts an airport run on a coach, which is
		// cheap and slow. Rail is what people mean by the train from the airport.
		options.prefer ?? (mode === 'transit' && haversineKm(from, to) > 20 ? 'rail' : null);

	// Keyed by the departure band, not the instant: the server's answers are by
	// the hour, and so are these.
	const key = `${pointKeyOf(from)}>${pointKeyOf(to)}|${mode}|${departBucket(mode, departAt)}|${prefer ?? ''}`;
	if (legCache.has(key)) return legCache.get(key)!;

	try {
		const { data, error } = await supabase.functions.invoke('route', {
			body: { from, to, mode, departAt, prefer }
		});
		// Offline, over budget, or the function is down: null, not remembered,
		// so asking again with a signal is what Retry does.
		if (error) return null;
		const routes = ((data?.routes ?? (data?.route ? [data.route] : [])) as LegRoute[]).filter(Boolean);
		legCache.set(key, routes);
		return routes;
	} catch {
		return null;
	}
}
