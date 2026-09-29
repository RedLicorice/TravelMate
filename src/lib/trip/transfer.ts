import { mutate } from '$lib/store/store.svelte';
import { getTrip, privateRow, withoutRefs, type TripRow } from './repo';
import { listPois, type PoiRow } from './pois';
import { listPlacements, type PlacementRow } from './placements';

/**
 * A trip as a file: saved to the phone, and read back in as a trip of its own.
 *
 * The trip, its places and its cards -- what the traveller made. Not the
 * saved plan, which is worked out from those again once the trip is back, and
 * not who it is shared with: whoever reads the file in owns what it makes.
 */
export type TripFile = {
	format: 'travelmate-trip';
	version: 1;
	exportedAt: string;
	trip: TripRow;
	pois: PoiRow[];
	placements: PlacementRow[];
};

export function exportTrip(tripId: string): TripFile | null {
	const trip = getTrip(tripId);
	if (!trip) return null;
	return {
		format: 'travelmate-trip',
		version: 1,
		exportedAt: new Date().toISOString(),
		trip,
		pois: listPois(tripId),
		placements: listPlacements(tripId)
	};
}

/** Hand the file to the browser to save. */
export function download(file: TripFile) {
	const blob = new Blob([JSON.stringify(file, null, 1)], { type: 'application/json' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = `${file.trip.name || file.trip.city}.travelmate.json`.replace(/[\\/:*?"<>|]+/g, ' ');
	a.click();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Read a file and say what is wrong with it, if anything. The file comes from
 * anywhere, so its shape is checked before any of it is written; what it
 * says inside the rows the server checks, as it does any edit.
 */
export function readTripFile(text: string): TripFile {
	let file: unknown;
	try {
		file = JSON.parse(text);
	} catch {
		throw new Error('This is not a trip file.');
	}
	const f = file as Partial<TripFile>;
	if (f?.format !== 'travelmate-trip' || f.version !== 1) throw new Error('This is not a trip file.');
	if (!f.trip || typeof f.trip !== 'object' || !Array.isArray(f.pois) || !Array.isArray(f.placements)) {
		throw new Error('This trip file is incomplete.');
	}
	return f as TripFile;
}

/**
 * Make a new trip from a file, owned by `userId`. Everything gets a new id,
 * so a trip read in twice is two trips, and one read back into the database
 * it came from sits beside the original. Returns the new trip's id.
 */
export async function importTrip(file: TripFile, userId: string): Promise<string> {
	const now = new Date().toISOString();
	const id = crypto.randomUUID();
	const poiIds = new Map(file.pois.map((p) => [p.id, crypto.randomUUID()]));
	// A file written before the booking references moved off the trip still
	// has them on it: they go where the references live now.
	const { arrival_booking_ref: _a, departure_booking_ref: _d, share_token: _s, ...kept } =
		file.trip as TripRow & Record<string, unknown>;
	const arrival = kept.arrival_legs ?? [];
	const departure = kept.departure_legs ?? [];
	const own = privateRow(id, arrival, departure);
	const trip: TripRow = {
		...kept,
		id,
		user_id: userId,
		arrival_legs: withoutRefs(arrival),
		departure_legs: withoutRefs(departure),
		plan_generated_at: null,
		plan_version: 0,
		created_at: now,
		version: 1
	};
	await mutate(`Imported ${trip.name || trip.city}`, id, (w) => {
		w.insert('trips', trip);
		w.insert('trip_private', own);
		for (const p of file.pois) {
			w.insert('pois', { ...p, id: poiIds.get(p.id)!, trip_id: id, added_by: userId, created_at: now, updated_at: now, version: 1 });
		}
		for (const pl of file.placements) {
			// A card for a place the file does not have cannot be made.
			if (pl.poi_id && !poiIds.has(pl.poi_id)) continue;
			w.insert('placements', {
				...pl,
				id: crypto.randomUUID(),
				trip_id: id,
				poi_id: pl.poi_id ? poiIds.get(pl.poi_id)! : null,
				created_at: now,
				version: 1
			});
		}
	});
	return id;
}
