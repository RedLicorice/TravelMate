import { supabase } from '$lib/supabase';
import type { Place, Trip } from './days';

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
			departure_at: input.departureAt
		})
		.select('id')
		.single();
	if (error) throw new Error(error.message);
	return data.id;
}
