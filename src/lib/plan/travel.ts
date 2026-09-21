import type { LatLng } from '$lib/trip/days';
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
 * Valhalla's OSM instance routes roads and footpaths properly. It does NOT
 * route public transport: the multimodal costing needs GTFS the public
 * instance does not load, and no free keyless transit router exists. Transit
 * is therefore modelled from the road route rather than routed -- see
 * transitFrom below, which is honest about being an estimate.
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
			const costing = COSTING[mode];
			const road = table.get(cellKey(from, to, costing));
			if (!road) return null;
			if (mode !== 'transit') return road;
			return { minutes: transitFrom(road.minutes, road.km), km: road.km };
		}
	};
}

/** A table that knows nothing, so every leg falls back. The default. */
export const noTravel: TravelTable = { get: () => null };
