import { createClient } from 'jsr:@supabase/supabase-js@2';
import { cors } from '../_shared/cors.ts';
import { signedIn } from '../_shared/caller.ts';
import { afford } from '../_shared/budget.ts';

/**
 * A place's peak hours, from Foursquare, written onto the place.
 *
 * Asked for places the traveller can see, in the background, never waited
 * on: the answer lands on the place and reaches the app like any other
 * change to it. One Foursquare search per place, which returns the venue's
 * busy windows and popularity with it; charged to the traveller's daily
 * budget. A place Foursquare does not know is remembered as asked, so it is
 * not asked again for thirty days.
 */

const REFRESH_DAYS = 30;
/** The venue has to be where the place is: a street away is a different café. */
const WITHIN_M = 150;
const MAX_PLACES = 20;

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

type Place = { id: string; name: string; lat: number; lng: number; busy_checked_at: string | null };
type Venue = {
	fsq_place_id?: string;
	fsq_id?: string;
	name: string;
	distance?: number;
	popularity?: number;
	hours_popular?: { day: number; open: string; close: string }[];
};

/** Names compared as a person would: no case, accents, punctuation or branch in brackets. */
const plain = (s: string) =>
	s
		.normalize('NFD')
		.replace(/\p{M}/gu, '')
		.replace(/\([^)]*\)/g, ' ')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '');

const sameName = (a: string, b: string) => {
	const x = plain(a);
	const y = plain(b);
	return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
};

/**
 * One search near the place, asking for the busy data in the same call.
 * Foursquare issues two kinds of key: a service key for the current Places
 * API (Bearer, versioned) and an API key for the older v3 one. Which this
 * project holds is not something the code can know ahead, so the current API
 * is asked first and the older one if the key is refused there.
 */
async function search(place: Place, key: string): Promise<Venue[]> {
	const q = new URLSearchParams({
		query: place.name,
		ll: `${place.lat},${place.lng}`,
		radius: String(WITHIN_M),
		limit: '5'
	});
	const current = await fetch(
		`https://places-api.foursquare.com/places/search?${q}&fields=fsq_place_id,name,distance,popularity,hours_popular`,
		{ headers: { Authorization: `Bearer ${key}`, 'X-Places-Api-Version': '2025-06-17', Accept: 'application/json' } }
	);
	if (current.ok) return ((await current.json()).results ?? []) as Venue[];
	if (current.status !== 401 && current.status !== 403) {
		throw new Error(`foursquare ${current.status}: ${(await current.text()).slice(0, 200)}`);
	}
	const older = await fetch(
		`https://api.foursquare.com/v3/places/search?${q}&fields=fsq_id,name,distance,popularity,hours_popular`,
		{ headers: { Authorization: key, Accept: 'application/json' } }
	);
	if (!older.ok) throw new Error(`foursquare v3 ${older.status}: ${(await older.text()).slice(0, 200)}`);
	return ((await older.json()).results ?? []) as Venue[];
}

Deno.serve(async (req) => {
	if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
	const traveller = await signedIn(req);
	if (!traveller) return json({ done: 0 }, 401);
	try {
		const { poiIds } = (await req.json()) as { poiIds: unknown };
		if (
			!Array.isArray(poiIds) ||
			!poiIds.length ||
			poiIds.length > MAX_PLACES ||
			!poiIds.every((id) => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id))
		) {
			return json({ done: 0, error: 'bad_request' }, 400);
		}

		// Read as the traveller: only places they can see are answered.
		const asTraveller = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
			global: { headers: { Authorization: req.headers.get('Authorization')! } }
		});
		const { data: places, error } = await asTraveller
			.from('pois')
			.select('id,name,lat,lng,busy_checked_at')
			.in('id', poiIds as string[]);
		if (error) throw error;

		const due = (places as Place[]).filter(
			(p) => !p.busy_checked_at || Date.now() - Date.parse(p.busy_checked_at) > REFRESH_DAYS * 86_400_000
		);
		if (!due.length) return json({ done: 0 });

		const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
		if (!(await afford(db, traveller, due.length))) return json({ done: 0, error: 'budget' }, 429);
		const key = Deno.env.get('FOURSQUARE_KEY')!;

		let done = 0;
		for (const place of due) {
			const venues = await search(place, key);
			const venue = venues
				.filter((v) => sameName(v.name, place.name) && (v.distance ?? 0) <= WITHIN_M)
				.sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0))[0];
			const { error: failed } = await db
				.from('pois')
				.update({
					fsq_place_id: venue ? (venue.fsq_place_id ?? venue.fsq_id ?? null) : null,
					busy_windows: venue?.hours_popular?.length ? venue.hours_popular : null,
					popularity: typeof venue?.popularity === 'number' ? venue.popularity : null,
					busy_checked_at: new Date().toISOString()
				})
				.eq('id', place.id);
			if (failed) throw failed;
			done++;
		}
		return json({ done });
	} catch (error) {
		console.error('busyness function failed', error);
		return json({ done: 0, error: 'internal' }, 500);
	}
});
