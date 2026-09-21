import { supabase } from '$lib/supabase';
import type { BBox } from '$lib/poi';
import { reinterpret } from './days';
import type { Place, Trip } from './days';
import type { PoiRow } from './pois';
import type { PlanStopRow } from './plan';
import { emptyLeg, summaryOf, type JourneyLeg } from './journey';

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
	arrival_kind: string | null;
	/** The way in and the way out, leg by leg. */
	arrival_legs: JourneyLeg[];
	departure_legs: JourneyLeg[];
	departure_kind: string | null;
	/** Flight, train or sailing number, as printed on the ticket. */
	arrival_service: string | null;
	arrival_booking_ref: string | null;
	departure_service: string | null;
	departure_booking_ref: string | null;
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
	/** An uploaded picture for the trip. Null falls back to the country flag. */
	image_url: string | null;
	/** ISO 3166-1 alpha-2, from the city that was picked. */
	country_code: string | null;
	share_token: string | null;
	/** When Regenerate last produced a plan. Null before the first one. */
	plan_generated_at: string | null;
	/** Which planner produced it. Older than the app means re-time on sight. */
	plan_version: number;
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
	countryCode: string | null;
	terminals: Terminals;
};

/**
 * Where the trip begins and ends, and how early to be there.
 *
 * Null points are the off switch. There is deliberately no separate "use
 * terminals" flag: a flag can disagree with the data, and then the traveller
 * sees an airport on the screen that the planner is ignoring.
 */
export type Terminals = {
	arrivalName: string | null;
	arrivalLat: number | null;
	arrivalLng: number | null;
	arrivalKind: string | null;
	arrivalLegs: JourneyLeg[];
	arrivalBufferMin: number;
	departureName: string | null;
	departureLat: number | null;
	departureLng: number | null;
	departureKind: string | null;
	departureLegs: JourneyLeg[];
	departureBufferMin: number;
	bagDropMin: number;
};

/**
 * The journey is what the traveller edits; these columns are what the planner
 * reads. Derived on every write rather than kept in step by hand, because two
 * places holding the same fact is how an airport ends up on screen that the
 * planner has never heard of.
 *
 * A journey that states no time leaves the trip's own arrival or departure
 * time alone: the traveller may well have typed it before filling in the legs.
 */
const terminalColumns = (t: Terminals, timezone: string) => {
	const arrival = summaryOf(t.arrivalLegs, 'arrival', timezone);
	const departure = summaryOf(t.departureLegs, 'departure', timezone);
	const endLeg = t.arrivalLegs[t.arrivalLegs.length - 1];
	const startLeg = t.departureLegs[0];

	return {
		arrival_legs: t.arrivalLegs,
		departure_legs: t.departureLegs,

		arrival_point_name: arrival.name,
		arrival_point_lat: arrival.lat,
		arrival_point_lng: arrival.lng,
		arrival_kind: arrival.kind,
		arrival_service: endLeg?.service ?? null,
		arrival_booking_ref: endLeg?.bookingRef ?? null,
		arrival_buffer_min: t.arrivalBufferMin,

		departure_point_name: departure.name,
		departure_point_lat: departure.lat,
		departure_point_lng: departure.lng,
		departure_kind: departure.kind,
		departure_service: startLeg?.service ?? null,
		departure_booking_ref: startLeg?.bookingRef ?? null,
		departure_buffer_min: t.departureBufferMin,

		bag_drop_min: t.bagDropMin,
		...(arrival.at ? { arrival_at: arrival.at } : {}),
		...(departure.at ? { departure_at: departure.at } : {})
	};
};

/** A trip with no terminals: the planner then shapes every day the same way. */
export const noTerminals = (): Terminals => ({
	arrivalName: null, arrivalLat: null, arrivalLng: null, arrivalKind: null,
	arrivalLegs: [], arrivalBufferMin: 45,
	departureName: null, departureLat: null, departureLng: null, departureKind: null,
	departureLegs: [], departureBufferMin: 120, bagDropMin: 30
});

export const terminalsOf = (row: TripRow): Terminals => ({
	arrivalName: row.arrival_point_name,
	arrivalLat: row.arrival_point_lat,
	arrivalLng: row.arrival_point_lng,
	arrivalKind: row.arrival_kind,
	arrivalLegs: row.arrival_legs ?? [],
	arrivalBufferMin: row.arrival_buffer_min,
	departureName: row.departure_point_name,
	departureLat: row.departure_point_lat,
	departureLng: row.departure_point_lng,
	departureKind: row.departure_kind,
	departureLegs: row.departure_legs ?? [],
	departureBufferMin: row.departure_buffer_min,
	bagDropMin: row.bag_drop_min
});

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
		// The services get cards of their own beside their terminals, so the
		// terminal keeps its own plain name.
		arrivalLegs: row.arrival_legs ?? [],
		departureLegs: row.departure_legs ?? [],
		// Filled in by the caller, which is the only place that knows who is
		// on the trip and therefore when the last of them is ready.
		prep: null,
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
			city_east: input.cityBBox?.east ?? null,
			country_code: input.countryCode,
			...terminalColumns(input.terminals, input.timezone)
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

/**
 * The trip's own allowances: dropping bags, getting out of an airport, being
 * there before a flight.
 *
 * Each of these shows on the plan as a card, and the card is where a traveller
 * notices it is wrong -- so it can be changed from there rather than only from
 * the edit screen three taps away.
 */
export async function updateAllowance(
	id: string,
	patch: { bag_drop_min?: number; arrival_buffer_min?: number; departure_buffer_min?: number }
): Promise<void> {
	const { error } = await supabase.from('trips').update(patch).eq('id', id);
	if (error) throw new Error(error.message);
}

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

/**
 * Set the trip's picture, or clear it back to the country flag.
 *
 * The object is keyed by trip id, which is exactly what the storage policy
 * checks, so a collaborator can change it and a stranger cannot.
 */
export async function setTripImage(id: string, url: string | null): Promise<void> {
	const { error } = await supabase.from('trips').update({ image_url: url }).eq('id', id);
	if (error) throw new Error(error.message);
}

/** Trips saved before the country was captured. Filled in once, on sight. */
export async function updateCountryCode(id: string, code: string): Promise<void> {
	const { error } = await supabase.from('trips').update({ country_code: code }).eq('id', id);
	if (error) throw new Error(error.message);
}

/**
 * Move a trip onto the right timezone, keeping every time the traveller typed
 * reading the same on the clock.
 *
 * The stored plan is left alone deliberately: its times are now wrong by an
 * hour and Regenerate is what fixes them, which is also the moment the
 * traveller sees the plan change rather than finding it silently moved.
 */
export async function repairTimezone(row: TripRow, zone: string): Promise<TripRow> {
	const patch = {
		timezone: zone,
		arrival_at: reinterpret(row.arrival_at, row.timezone, zone),
		departure_at: reinterpret(row.departure_at, row.timezone, zone)
	};
	const { error } = await supabase.from('trips').update(patch).eq('id', row.id);
	if (error) throw new Error(error.message);
	return { ...row, ...patch };
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
	terminals: Terminals;
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
			day_end: edit.dayEnd,
			...terminalColumns(edit.terminals, edit.timezone)
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
): Promise<{ trip: TripRow; pois: PoiRow[]; plan: PlanStopRow[] } | null> {
	const { data, error } = await supabase.rpc('get_shared_trip', { token });
	if (error) throw new Error(error.message);
	if (!data?.trip) return null;
	return data as { trip: TripRow; pois: PoiRow[]; plan: PlanStopRow[] };
}

/**
 * Join a trip using a share link. Returns the trip id, or null when the token
 * is unknown or revoked -- the same answer for both, so neither is confirmed.
 *
 * Membership is granted by the function rather than by an insert, because a
 * client that could insert its own trip_members row would not need a token.
 */
export async function joinTrip(token: string): Promise<string | null> {
	const { data, error } = await supabase.rpc('join_trip', { token });
	if (error) throw new Error(error.message);
	return (data as string | null) ?? null;
}
