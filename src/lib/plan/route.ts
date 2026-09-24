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
};

const legCache = new Map<string, LegRoute | null>();

/**
 * The routed detail of one leg: what to actually catch, and the line to draw.
 *
 * Asked only for the legs of a settled plan -- n-1 of them, not n² pairs --
 * which is the only point at which a plan is concrete enough to route.
 */
export async function legRoute(
	from: LatLng,
	to: LatLng,
	mode: Mode,
	departAt: string | null,
	options: { prefer?: 'rail' | null } = {}
): Promise<LegRoute | null> {
	// Two cards standing in the same place: there is no journey to route, and
	// asking costs a billed element to be told so.
	if (pointKeyOf(from) === pointKeyOf(to)) return null;

	const prefer =
		// Left to itself the router puts an airport run on a coach, which is
		// cheap and slow. Rail is what people mean by the train from the airport.
		options.prefer ?? (mode === 'transit' && haversineKm(from, to) > 20 ? 'rail' : null);

	// Keyed by the departure band, not the instant. On the instant, re-timing a
	// day by four minutes missed every leg in it and asked again for answers
	// the server had already given -- it caches by the hour, and so does this.
	const key = `${pointKeyOf(from)}>${pointKeyOf(to)}|${mode}|${departBucket(mode, departAt)}|${prefer ?? ''}`;
	if (legCache.has(key)) return legCache.get(key)!;

	try {
		const { data, error } = await supabase.functions.invoke('route', {
			body: { from, to, mode, departAt, prefer }
		});
		if (error) return null;
		const route = (data?.route ?? null) as LegRoute | null;
		legCache.set(key, route);
		return route;
	} catch {
		// Offline, or the function is down. Not remembered: asking again, once
		// there is a signal, is what Retry is for.
		return null;
	}
}
