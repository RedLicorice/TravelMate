import { createClient } from 'jsr:@supabase/supabase-js@2';
import { cors } from '../_shared/cors.ts';
import { signedIn } from '../_shared/caller.ts';
import { afford } from '../_shared/budget.ts';
import { isPoint, type LatLng } from '../_shared/input.ts';

/**
 * Place search, answered by Google.
 *
 * Every search the app makes comes here -- places, hotels, stations, cities,
 * addresses -- and so does naming a dropped pin. Done on the server rather
 * than the phone for the same reasons routing is: the key stays here, and
 * each call is charged to the traveller's daily budget before it is made.
 * One call is one element of that budget.
 */

type Rect = { south: number; north: number; west: number; east: number };

type Ask =
	| {
			kind: 'text';
			query: string;
			/** One of Google's place types, to search only those. */
			type?: string | null;
			/** Search only inside this box. */
			within?: Rect | null;
			/** Rank results near here, without excluding anything further off. */
			near?: LatLng | null;
			limit?: number;
	  }
	| { kind: 'reverse'; at: LatLng };

/** What the app is told about a place, whichever call found it. */
type Found = {
	id: string;
	name: string;
	address: string;
	lat: number;
	lng: number;
	type: string | null;
	types: string[];
	countryCode: string | null;
	viewport: Rect | null;
	website: string | null;
	phone: string | null;
	hours: string | null;
	/** Opening periods as data (see 0066); null when Google has none. */
	periods: unknown[] | null;
};

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { ...cors, 'Content-Type': 'application/json' }
	});

const isRect = (r: unknown): r is Rect =>
	!!r &&
	typeof r === 'object' &&
	['south', 'north', 'west', 'east'].every((k) => Number.isFinite((r as Record<string, number>)[k]));

/** Google's type names are lower-case words joined by underscores; nothing else is passed on. */
const isType = (t: unknown): t is string => typeof t === 'string' && /^[a-z_]{2,40}$/.test(t);

function valid(ask: Ask): boolean {
	if (ask?.kind === 'reverse') return isPoint(ask.at);
	if (ask?.kind !== 'text') return false;
	if (typeof ask.query !== 'string' || !ask.query.trim() || ask.query.length > 200) return false;
	if (ask.type != null && !isType(ask.type)) return false;
	if (ask.within != null && !isRect(ask.within)) return false;
	if (ask.near != null && !isPoint(ask.near)) return false;
	if (ask.limit != null && !(Number.isInteger(ask.limit) && ask.limit >= 1 && ask.limit <= 20)) return false;
	return true;
}

const KEY = () => Deno.env.get('GOOGLE_MAPS_KEY')!;

type GooglePlace = {
	id: string;
	displayName?: { text?: string };
	formattedAddress?: string;
	location?: { latitude: number; longitude: number };
	primaryType?: string;
	types?: string[];
	viewport?: { low: { latitude: number; longitude: number }; high: { latitude: number; longitude: number } };
	addressComponents?: { shortText?: string; types?: string[] }[];
	websiteUri?: string;
	internationalPhoneNumber?: string;
	regularOpeningHours?: { weekdayDescriptions?: string[]; periods?: unknown[] };
};

const FIELDS = [
	'places.id',
	'places.displayName',
	'places.formattedAddress',
	'places.location',
	'places.primaryType',
	'places.types',
	'places.viewport',
	'places.addressComponents',
	'places.websiteUri',
	'places.internationalPhoneNumber',
	'places.regularOpeningHours.weekdayDescriptions',
	'places.regularOpeningHours.periods'
].join(',');

async function text(ask: Extract<Ask, { kind: 'text' }>): Promise<Found[]> {
	const body: Record<string, unknown> = {
		textQuery: ask.query.trim(),
		languageCode: 'en',
		pageSize: ask.limit ?? 10
	};
	if (ask.type) body.includedType = ask.type;
	if (ask.within) {
		body.locationRestriction = {
			rectangle: {
				low: { latitude: ask.within.south, longitude: ask.within.west },
				high: { latitude: ask.within.north, longitude: ask.within.east }
			}
		};
	} else if (ask.near) {
		body.locationBias = {
			circle: { center: { latitude: ask.near.lat, longitude: ask.near.lng }, radius: 50000 }
		};
	}
	const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'X-Goog-Api-Key': KEY(),
			'X-Goog-FieldMask': FIELDS
		},
		body: JSON.stringify(body)
	});
	if (!res.ok) throw new Error(`places ${res.status}: ${(await res.text()).slice(0, 300)}`);
	const { places = [] } = (await res.json()) as { places?: GooglePlace[] };
	return places.filter((p) => p.location).map((p) => ({
		id: p.id,
		name: p.displayName?.text ?? p.formattedAddress ?? '',
		address: p.formattedAddress ?? '',
		lat: p.location!.latitude,
		lng: p.location!.longitude,
		type: p.primaryType ?? null,
		types: p.types ?? [],
		countryCode: p.addressComponents?.find((c) => c.types?.includes('country'))?.shortText ?? null,
		viewport: p.viewport
			? {
					south: p.viewport.low.latitude,
					west: p.viewport.low.longitude,
					north: p.viewport.high.latitude,
					east: p.viewport.high.longitude
				}
			: null,
		website: p.websiteUri ?? null,
		phone: p.internationalPhoneNumber ?? null,
		hours: p.regularOpeningHours?.weekdayDescriptions?.join('; ') ?? null,
		periods: p.regularOpeningHours?.periods?.length ? p.regularOpeningHours.periods : null
	}));
}

async function reverse(at: LatLng): Promise<Found[]> {
	const url = `https://maps.googleapis.com/maps/api/geocode/json?${new URLSearchParams({
		latlng: `${at.lat},${at.lng}`,
		language: 'en',
		key: KEY()
	})}`;
	const res = await fetch(url);
	if (!res.ok) throw new Error(`geocode ${res.status}`);
	const body = (await res.json()) as {
		status: string;
		error_message?: string;
		results?: {
			place_id: string;
			formatted_address: string;
			geometry: { location: { lat: number; lng: number } };
			types: string[];
			address_components: { long_name: string; short_name: string; types: string[] }[];
		}[];
	};
	if (body.status !== 'OK' && body.status !== 'ZERO_RESULTS') {
		throw new Error(`geocode ${body.status}: ${body.error_message ?? ''}`);
	}
	const [r] = body.results ?? [];
	if (!r) return [];
	const part = (type: string) => r.address_components.find((c) => c.types.includes(type));
	const street = [part('route')?.long_name, part('street_number')?.long_name].filter(Boolean).join(' ');
	return [
		{
			id: r.place_id,
			name: street || r.formatted_address.split(',')[0],
			address: r.formatted_address,
			lat: r.geometry.location.lat,
			lng: r.geometry.location.lng,
			type: r.types[0] ?? null,
			types: r.types,
			countryCode: part('country')?.short_name ?? null,
			viewport: null,
			website: null,
			phone: null,
			hours: null,
			periods: null
		}
	];
}

Deno.serve(async (req) => {
	if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
	// Paid work, so it is done for a traveller and nobody else.
	const traveller = await signedIn(req);
	if (!traveller) return json({ places: [] }, 401);
	try {
		const ask = (await req.json()) as Ask;
		if (!valid(ask)) return json({ places: [], error: 'bad_request' }, 400);
		const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
		if (!(await afford(db, traveller, 1))) return json({ places: [], error: 'budget' }, 429);
		const places = ask.kind === 'reverse' ? await reverse(ask.at) : await text(ask);
		return json({ places });
	} catch (error) {
		console.error('places function failed', error);
		// The caller gets no upstream text: it can carry the request, key-adjacent
		// detail and Google's internals. The log has it.
		return json({ places: [], error: 'internal' }, 500);
	}
});
