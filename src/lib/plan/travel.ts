import type { LatLng } from '$lib/trip/days';
import { supabase } from '$lib/supabase';
import { DETOUR, haversineKm } from './geo';
import type { Leg, Mode } from './modes';

/**
 * Real travel times, resolved before planning.
 *
 * The planner is synchronous -- it re-runs on every drag and hundreds of times
 * inside 2-opt -- so nothing here may be awaited from inside it. Every pair of
 * stops on a day is resolved up front into a plain table, in one matrix
 * request per costing, and the planner reads that table.
 *
 * Three sources, in order. Google Routes answers real timetabled transit and
 * traffic-aware roads, through an Edge Function that holds the key. Valhalla's
 * OSM instance routes roads and footpaths but NOT public transport -- its
 * multimodal costing needs GTFS the public instance does not load -- so a
 * Valhalla transit figure is modelled from the road route by transitFrom.
 * Beneath both, the straight-line model always answers.
 */
const MATRIX = 'https://valhalla1.openstreetmap.de/sources_to_targets';

/** Rounded coordinates, so the same place keys identically every time. */
export const pointKey = (p: LatLng) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;

const cellKey = (from: LatLng, to: LatLng, costing: string) =>
	`${pointKey(from)}>${pointKey(to)}|${costing}`;

export type TravelTable = {
	/** Minutes and km, or null when nothing was resolved for this pair. */
	get(from: LatLng, to: LatLng, mode: Mode): Omit<Leg, 'mode'> | null;
};

/** One answered pair, as the Edge Function returns it. */
export type TravelCell = {
	from: string;
	to: string;
	minutes: number;
	km: number;
	source: 'google' | 'valhalla';
};

/**
 * Build a lookup from answered cells.
 *
 * A Google transit figure is used exactly as given: it already includes the
 * walk to the platform, the wait and the transfers, so putting transitFrom on
 * top would charge for those twice. The band applies only to road-derived
 * estimates.
 */
export function tableFrom(cells: TravelCell[]): TravelTable {
	const byKey = new Map(cells.map((c) => [`${c.from}>${c.to}`, c]));
	return {
		get(from, to, mode) {
			const cell = byKey.get(`${pointKey(from)}>${pointKey(to)}`);
			if (!cell) return null;
			if (mode === 'transit' && cell.source !== 'google') {
				return { minutes: transitFrom(cell.minutes, cell.km), km: cell.km };
			}
			return { minutes: cell.minutes, km: cell.km };
		}
	};
}

/** Two tables consulted in order; the first with an answer wins. */
export const firstOf = (tables: TravelTable[]): TravelTable => ({
	get(from, to, mode) {
		for (const table of tables) {
			const answer = table.get(from, to, mode);
			if (answer) return answer;
		}
		return null;
	}
});

/** Which Valhalla costing stands in for each of our modes. */
const COSTING: Record<Mode, 'pedestrian' | 'bicycle' | 'auto'> = {
	walk: 'pedestrian',
	bike: 'bicycle',
	car: 'auto',
	carshare: 'auto',
	transit: 'auto' // modelled from the road route; see transitFrom
};

/**
 * Transit, estimated from the road route because it cannot be routed.
 *
 * Two bands, because one number cannot describe both a bus across town and an
 * airport express. Below 20km, urban transit is slower than driving: stops,
 * transfers, walking to the platform. Above it, the journey is almost always
 * an express service on its own right of way, which beats city traffic.
 *
 * A worked example: Stansted to central London is 57km of road and 76 driving
 * minutes. This yields about 65, which is what the timetable says. The old
 * flat 18km/h model said 222.
 */
export function transitFrom(roadMinutes: number, km: number): number {
	if (km < 20) return Math.round(roadMinutes * 1.25 + 8);
	const expressMinutes = (km / 60) * 60; // 60km/h door to door including stops
	return Math.round(Math.min(roadMinutes, expressMinutes) + 15);
}

/** The estimate used when nothing better is available. Unchanged behaviour. */
export function haversineLeg(from: LatLng, to: LatLng, mode: Mode): Omit<Leg, 'mode'> {
	const km = haversineKm(from, to) * DETOUR;
	const SPEED: Record<Mode, number> = { walk: 4.5, bike: 13, transit: 18, car: 25, carshare: 25 };
	const minutes = (km / SPEED[mode]) * 60 + (mode === 'transit' ? 12 : 0);
	return { minutes: Math.round(minutes), km: Math.round(km * 10) / 10 };
}

type Cell = { time?: number | null; distance?: number | null };

async function matrix(points: LatLng[], costing: string, signal?: AbortSignal) {
	const body = {
		sources: points.map((p) => ({ lat: p.lat, lon: p.lng })),
		targets: points.map((p) => ({ lat: p.lat, lon: p.lng })),
		costing,
		units: 'kilometers'
	};
	const res = await fetch(MATRIX, {
		method: 'POST',
		signal,
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body)
	});
	if (!res.ok) throw new Error(String(res.status));
	const parsed = await res.json();
	return (parsed?.sources_to_targets ?? []) as Cell[][];
}

/**
 * Resolve every pair among `points` for the modes in use.
 *
 * One request per costing, not one per leg: a day of ten stops is a hundred
 * pairs, and the 2-opt search needs all of them because it reorders freely.
 */
export async function resolveTravel(
	points: LatLng[],
	modes: Mode[],
	departAt?: string | null,
	signal?: AbortSignal
): Promise<TravelTable> {
	if (points.length < 2) return noTravel;

	// Google first, one request per mode in use. The function caps the matrix
	// itself and returns an error rather than a truncated answer.
	const google = await resolveFromFunction(points, modes, departAt ?? null);

	// Valhalla fills whatever Google could not answer -- a city it does not
	// cover, or a request that was refused. Skipped entirely when Google has
	// answered every mode already: it is a shared courtesy service, and when
	// it is down the browser logs a failed request for every call whether the
	// result is needed or not.
	const unanswered = [...new Set(modes)].filter(
		(mode) => !google.get(points[0], points[1], mode)
	);
	if (!unanswered.length) return google;

	const valhalla = await resolveFromValhalla(points, unanswered, signal);
	return firstOf([google, valhalla]);
}

async function resolveFromFunction(
	points: LatLng[],
	modes: Mode[],
	departAt: string | null
): Promise<TravelTable> {
	const cells: TravelCell[] = [];
	for (const mode of new Set(modes)) {
		try {
			const { data, error } = await supabase.functions.invoke('travel', {
				body: { points, mode, departAt }
			});
			if (error) continue;
			const answered = (data?.cells ?? []) as TravelCell[];
			// Cells are per mode, so tag them before merging: the same pair has a
			// different answer on foot than on a train.
			for (const cell of answered) {
				cells.push({ ...cell, from: `${mode}|${cell.from}`, to: `${mode}|${cell.to}` });
			}
		} catch {
			// Offline, or the function is down. The chain continues.
		}
	}
	const byKey = new Map(cells.map((c) => [`${c.from}>${c.to}`, c]));
	return {
		get(from, to, mode) {
			const cell = byKey.get(`${mode}|${pointKey(from)}>${mode}|${pointKey(to)}`);
			if (!cell) return null;
			if (mode === 'transit' && cell.source !== 'google') {
				return { minutes: transitFrom(cell.minutes, cell.km), km: cell.km };
			}
			return { minutes: cell.minutes, km: cell.km };
		}
	};
}

async function resolveFromValhalla(
	points: LatLng[],
	modes: Mode[],
	signal?: AbortSignal
): Promise<TravelTable> {
	const table = new Map<string, Omit<Leg, 'mode'>>();

	// Valhalla's matrix is quadratic; a very long day is not a reasonable ask
	// of a shared courtesy service.
	const usable = points.length >= 2 && points.length <= 20;
	const costings = [...new Set(modes.map((m) => COSTING[m]))];

	if (usable) {
		for (const costing of costings) {
			try {
				const rows = await matrix(points, costing, signal);
				rows.forEach((row, i) =>
					row.forEach((cell, j) => {
						if (i === j) return;
						const minutes = (cell.time ?? 0) / 60;
						const km = cell.distance ?? 0;
						// Zero is how the matrix reports "no route", not a journey
						// that takes no time. Leaving it out lets the fallback answer.
						if (minutes <= 0 || km <= 0) return;
						table.set(cellKey(points[i], points[j], costing), {
							minutes: Math.round(minutes),
							km: Math.round(km * 10) / 10
						});
					})
				);
			} catch {
				// Router down, or the day is unroutable. The fallback still plans.
			}
		}
	}

	return {
		get(from, to, mode) {
			const road = table.get(cellKey(from, to, COSTING[mode]));
			if (!road) return null;
			if (mode !== 'transit') return road;
			return { minutes: transitFrom(road.minutes, road.km), km: road.km };
		}
	};
}

/** A table that knows nothing, so every leg falls back. The default. */
export const noTravel: TravelTable = { get: () => null };
