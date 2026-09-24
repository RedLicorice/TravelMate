import { createClient } from 'jsr:@supabase/supabase-js@2';
import { cors } from '../_shared/cors.ts';
import { signedIn } from '../_shared/caller.ts';
import { afford } from '../_shared/budget.ts';

/**
 * A place's opening hours, from Google, written onto the place as data.
 *
 * For places saved before the hours were kept, or whose hours are a month
 * old: asked in the background for places the traveller can see, never
 * waited on. A place found on Google is asked for by its Google id; any
 * other by a search for its name where it stands. One call per place,
 * charged to the traveller's daily budget. A place Google has no hours for
 * is remembered as asked, and asked again after thirty days.
 */

const REFRESH_DAYS = 30;
const WITHIN_M = 150;
const MAX_PLACES = 20;

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

type Place = { id: string; name: string; lat: number; lng: number; source_id: string | null; opening_checked_at: string | null };
type Found = {
	displayName?: { text?: string };
	location?: { latitude: number; longitude: number };
	regularOpeningHours?: { periods?: unknown[] };
};

const plain = (s: string) =>
	s.normalize('NFD').replace(/\p{M}/gu, '').replace(/\([^)]*\)/g, ' ').toLowerCase().replace(/[^a-z0-9]+/g, '');
const sameName = (a: string, b: string) => {
	const x = plain(a);
	const y = plain(b);
	return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
};
const metres = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
	const r = (d: number) => (d * Math.PI) / 180;
	const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
	return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
};

async function periodsOf(place: Place, key: string): Promise<unknown[] | null> {
	const headers = { 'X-Goog-Api-Key': key, 'Content-Type': 'application/json' };
	if (place.source_id?.startsWith('google/')) {
		const res = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(place.source_id.slice(7))}`, {
			headers: { ...headers, 'X-Goog-FieldMask': 'regularOpeningHours.periods' }
		});
		if (!res.ok) throw new Error(`place details ${res.status}: ${(await res.text()).slice(0, 200)}`);
		const found = (await res.json()) as Found;
		return found.regularOpeningHours?.periods?.length ? found.regularOpeningHours.periods : null;
	}
	const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
		method: 'POST',
		headers: { ...headers, 'X-Goog-FieldMask': 'places.displayName,places.location,places.regularOpeningHours.periods' },
		body: JSON.stringify({
			textQuery: place.name,
			pageSize: 3,
			locationBias: { circle: { center: { latitude: place.lat, longitude: place.lng }, radius: WITHIN_M } }
		})
	});
	if (!res.ok) throw new Error(`places search ${res.status}: ${(await res.text()).slice(0, 200)}`);
	const { places = [] } = (await res.json()) as { places?: Found[] };
	const match = places.find(
		(p) =>
			p.location &&
			sameName(p.displayName?.text ?? '', place.name) &&
			metres(place, { lat: p.location.latitude, lng: p.location.longitude }) <= WITHIN_M
	);
	return match?.regularOpeningHours?.periods?.length ? match.regularOpeningHours.periods : null;
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
			.select('id,name,lat,lng,source_id,opening_checked_at')
			.in('id', poiIds as string[]);
		if (error) throw error;
		const due = (places as Place[]).filter(
			(p) => !p.opening_checked_at || Date.now() - Date.parse(p.opening_checked_at) > REFRESH_DAYS * 86_400_000
		);
		if (!due.length) return json({ done: 0 });

		const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
		if (!(await afford(db, traveller, due.length))) return json({ done: 0, error: 'budget' }, 429);
		const key = Deno.env.get('GOOGLE_MAPS_KEY')!;
		let done = 0;
		for (const place of due) {
			const periods = await periodsOf(place, key);
			const { error: failed } = await db
				.from('pois')
				.update({ opening_periods: periods, opening_checked_at: new Date().toISOString() })
				.eq('id', place.id);
			if (failed) throw failed;
			done++;
		}
		return json({ done });
	} catch (error) {
		console.error('hours function failed', error);
		return json({ done: 0, error: 'internal' }, 500);
	}
});
