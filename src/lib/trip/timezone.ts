import tzLookup from 'tz-lookup';

/**
 * The IANA zone a place sits in.
 *
 * Offline data rather than a lookup service: this is asked the moment a city
 * is picked, and a trip whose times are all an hour out because a request
 * failed is worse than no feature at all.
 *
 * A ticket quotes every time in the local time of the place it happens --
 * 08:00 leaving Rome, 15:45 landing in London -- so the destination's zone,
 * not the traveller's own, is what the trip runs on.
 */
export function zoneAt(lat: number, lng: number): string | null {
	try {
		return tzLookup(lat, lng);
	} catch {
		// Off the map: mid-ocean coordinates, or a bad pin.
		return null;
	}
}

/** The traveller's own zone. The right default only when they live there. */
export const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
