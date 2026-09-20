import { supabase } from '$lib/supabase';
import type { BBox } from '$lib/poi';
import type { Place, Trip } from './days';
import type { PoiRow } from './pois';

export type TripRow = {
	id: string;
	user_id: string;
	name: string;
	city: string;
	timezone: string;
	hotel_name: string;
	hotel_lat: number;
	hotel_lng: number;
	arrival_at: string;
	departure_at: string;
	arrival_point_name: string | null;
	arrival_point_lat: number | null;
	arrival_point_lng: number | null;
	departure_point_name: string | null;
	departure_point_lat: number | null;
	departure_point_lng: number | null;
	arrival_buffer_min: number;
	departure_buffer_min: number;
	bag_drop_min: number;
	allowed_modes: string[];
	city_south: number | null;
	city_north: number | null;
	city_west: number | null;
	city_east: number | null;
	day_start: string;
	day_end: string;
	share_token: string | null;
	created_at: string;
};

export type NewTrip = {
	name: string;
	city: string;
	timezone: string;
	hotelName: string;
	hotelLat: number;
	hotelLng: number;
	arrivalAt: string;
	departureAt: string;
	cityBBox: BBox | null;
};

function place(name: string | null, lat: number | null, lng: number | null): Place | null {
	// The column constraint forbids a half-set pair, so either all three are
	// present or the point is genuinely absent.
	return name !== null && lat !== null && lng !== null ? { name, at: { lat, lng } } : null;
}

/** Postgres renders `time` as HH:MM:SS; the pure module speaks HH:MM. */
const hhmm = (t: string) => t.slice(0, 5);

export function toTrip(row: TripRow): Trip {
	return {
		hotelName: row.hotel_name,
		hotel: { lat: row.hotel_lat, lng: row.hotel_lng },
		timezone: row.timezone,
		arrivalAt: row.arrival_at,
		departureAt: row.departure_at,
		arrivalPoint: place(row.arrival_point_name, row.arrival_point_lat, row.arrival_point_lng),
		departurePoint: place(
			row.departure_point_name,
			row.departure_point_lat,
			row.departure_point_lng
		),
		arrivalBufferMin: row.arrival_buffer_min,
		departureBufferMin: row.departure_buffer_min,
		bagDropMin: row.bag_drop_min,
		dayStart: hhmm(row.day_start),
		dayEnd: hhmm(row.day_end)
	};
}

export async function listTrips(): Promise<TripRow[]> {
	const { data, error } = await supabase
		.from('trips')
		.select('*')
		.order('arrival_at', { ascending: true });
	if (error) throw new Error(error.message);
	return data ?? [];
}

export async function getTrip(id: string): Promise<TripRow | null> {
	const { data, error } = await supabase.from('trips').select('*').eq('id', id).maybeSingle();
	if (error) throw new Error(error.message);
	return data;
}

export async function createTrip(input: NewTrip): Promise<string> {
	const { data: auth } = await supabase.auth.getUser();
	if (!auth.user) throw new Error('Not signed in');

	const { data, error } = await supabase
		.from('trips')
		.insert({
			user_id: auth.user.id,
			name: input.name,
			city: input.city,
			timezone: input.timezone,
			hotel_name: input.hotelName,
			hotel_lat: input.hotelLat,
			hotel_lng: input.hotelLng,
			arrival_at: input.arrivalAt,
			departure_at: input.departureAt,
			city_south: input.cityBBox?.south ?? null,
			city_north: input.cityBBox?.north ?? null,
			city_west: input.cityBBox?.west ?? null,
			city_east: input.cityBBox?.east ?? null
		})
		.select('id')
		.single();
	if (error) throw new Error(error.message);
	return data.id;
}

/** The city box as stored, or null when the trip predates it being captured. */
export function cityBBox(row: TripRow): BBox | null {
	const { city_south, city_north, city_west, city_east } = row;
	// The column constraint guarantees all four or none, so one check is enough.
	return city_south !== null && city_north !== null && city_west !== null && city_east !== null
		? { south: city_south, north: city_north, west: city_west, east: city_east }
		: null;
}

/** True for a trip saved before the hotel picker existed: 0,0 is Null Island. */
export const hotelMissing = (row: TripRow) => row.hotel_lat === 0 && row.hotel_lng === 0;

export async function updateHotel(
	id: string,
	hotel: { name: string; lat: number; lng: number }
): Promise<void> {
	const { error } = await supabase
		.from('trips')
		.update({ hotel_name: hotel.name, hotel_lat: hotel.lat, hotel_lng: hotel.lng })
		.eq('id', id);
	if (error) throw new Error(error.message);
}

export async function updateCityBBox(id: string, bbox: BBox): Promise<void> {
	const { error } = await supabase
		.from('trips')
		.update({
			city_south: bbox.south,
			city_north: bbox.north,
			city_west: bbox.west,
			city_east: bbox.east
		})
		.eq('id', id);
	if (error) throw new Error(error.message);
}

export type TripEdit = {
	city: string;
	timezone: string;
	hotelName: string;
	hotelLat: number;
	hotelLng: number;
	arrivalAt: string;
	departureAt: string;
	allowedModes: string[];
	dayStart: string;
	dayEnd: string;
};

export async function updateTrip(id: string, edit: TripEdit): Promise<void> {
	const { error } = await supabase
		.from('trips')
		.update({
			name: edit.city,
			city: edit.city,
			timezone: edit.timezone,
			hotel_name: edit.hotelName,
			hotel_lat: edit.hotelLat,
			hotel_lng: edit.hotelLng,
			arrival_at: edit.arrivalAt,
			departure_at: edit.departureAt,
			allowed_modes: edit.allowedModes,
			day_start: edit.dayStart,
			day_end: edit.dayEnd
		})
		.eq('id', id);
	if (error) throw new Error(error.message);
}

export async function deleteTrip(id: string): Promise<void> {
	// pois cascade via the foreign key, so this is one statement, not two.
	const { error } = await supabase.from('trips').delete().eq('id', id);
	if (error) throw new Error(error.message);
}

/** A share token, minted on demand. Null revokes the link. */
export async function setShareToken(id: string, token: string | null): Promise<void> {
	const { error } = await supabase.from('trips').update({ share_token: token }).eq('id', id);
	if (error) throw new Error(error.message);
}

/**
 * A shared trip, read through the RPC rather than the table.
 *
 * Anonymous callers have no select policy on trips at all -- deliberately, as
 * a `share_token is not null` policy would let them write their own WHERE and
 * enumerate every shared trip. The function takes the token as an argument, so
 * an unguessable value is genuinely required.
 */
export async function getSharedTrip(
	token: string
): Promise<{ trip: TripRow; pois: PoiRow[] } | null> {
	const { data, error } = await supabase.rpc('get_shared_trip', { token });
	if (error) throw new Error(error.message);
	if (!data?.trip) return null;
	return data as { trip: TripRow; pois: PoiRow[] };
}
