import type { LatLng } from '$lib/trip/days';

const R_KM = 6371;
const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in km. */
export function haversineKm(a: LatLng, b: LatLng): number {
	const dLat = rad(b.lat - a.lat);
	const dLng = rad(b.lng - a.lng);
	const s =
		Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
	return 2 * R_KM * Math.asin(Math.sqrt(s));
}

/**
 * Straight-line distance understates a real journey: streets are a grid, rivers
 * have bridges, hills have switchbacks. 1.3 is the usual urban fudge.
 * ponytail: swap for a routing call in phase 7 -- only this file changes.
 */
export const DETOUR = 1.3;
