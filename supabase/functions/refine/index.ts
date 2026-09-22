import { createClient } from 'jsr:@supabase/supabase-js@2';
import { cors } from '../_shared/cors.ts';
import { signedIn } from '../_shared/caller.ts';
import { routeLeg } from '../_shared/leg.ts';
import { isMode, type LatLng, type Mode } from '../_shared/input.ts';

/**
 * The real travel times for a plan the traveller has already been shown.
 *
 * A drag re-times the day from the speed model and writes it straight away,
 * so the card lands under the finger. Those legs are stored as estimates.
 * This works through them afterwards, routes each one properly, and writes
 * the answer back onto the stop it belongs to -- which is why a stop keeps
 * its row across saves (0038). An open plan hears about it through Realtime
 * and re-walks its clock; a closed one finds the work already done.
 *
 * Nothing here decides where a stop goes. It answers "how long does this
 * journey take", and the client is what schedules around the answer.
 */

/** As many legs as one call will work through: a trip's worth, not a week's. */
const MAX_LEGS = 40;
/** Lanes into Google. Enough to finish a day quickly, few enough to be polite. */
const LANES = 4;

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { ...cors, 'Content-Type': 'application/json' }
	});

const key = (p: LatLng) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;

const isUuid = (s: unknown): s is string =>
	typeof s === 'string' &&
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

type Row = {
	id: string;
	day_index: number;
	order_index: number;
	lat: number;
	lng: number;
	exit_lat: number | null;
	exit_lng: number | null;
	starts_at: string;
	ends_at: string;
	leg_mode: string | null;
	leg_minutes: number | null;
	leg_source: string | null;
};

/** The journeys a stored plan is still guessing at. */
function estimatesIn(rows: Row[]): { row: Row; from: LatLng; to: LatLng; mode: Mode; departAt: string }[] {
	const out: { row: Row; from: LatLng; to: LatLng; mode: Mode; departAt: string }[] = [];
	const byDay = new Map<number, Row[]>();
	for (const row of rows) byDay.set(row.day_index, [...(byDay.get(row.day_index) ?? []), row]);

	for (const day of byDay.values()) {
		const ordered = [...day].sort((a, b) => a.order_index - b.order_index);
		ordered.forEach((row, i) => {
			const previous = ordered[i - 1];
			if (!previous || row.leg_source !== 'estimate') return;
			if (!isMode(row.leg_mode) || (row.leg_minutes ?? 0) <= 0) return;
			const from = { lat: previous.exit_lat ?? previous.lat, lng: previous.exit_lng ?? previous.lng };
			const to = { lat: row.lat, lng: row.lng };
			// Two cards in the same place: nothing to route, and 0038 already
			// stores that as routed. Belt and braces.
			if (key(from) === key(to)) return;
			out.push({ row, from, to, mode: row.leg_mode, departAt: previous.ends_at });
		});
	}
	return out;
}

Deno.serve(async (req) => {
	if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

	// Paid work, so it is done for a traveller and nobody else.
	const traveller = await signedIn(req);
	if (!traveller) return json({ refined: 0 }, 401);

	try {
		const { tripId } = (await req.json()) as { tripId: string };
		if (!isUuid(tripId)) return json({ refined: 0, error: 'bad_request' }, 400);

		const db = createClient(
			Deno.env.get('SUPABASE_URL')!,
			Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
		);

		// Spending on a trip is for whoever may write it. A viewer holding a
		// share link reads the plan; they do not get to spend on it.
		const [{ data: member }, { data: trip }] = await Promise.all([
			db
				.from('trip_members')
				.select('role')
				.eq('trip_id', tripId)
				.eq('user_id', traveller)
				.maybeSingle(),
			db.from('trips').select('user_id').eq('id', tripId).maybeSingle()
		]);
		const mayWrite =
			trip?.user_id === traveller || member?.role === 'owner' || member?.role === 'editor';
		// Unknown trip and forbidden trip answer alike, so neither is confirmed.
		if (!mayWrite) return json({ refined: 0 }, 403);

		const { data: rows, error } = await db
			.from('plan_stops')
			.select('id,day_index,order_index,lat,lng,exit_lat,exit_lng,starts_at,ends_at,leg_mode,leg_minutes,leg_source')
			.eq('trip_id', tripId);
		if (error) throw new Error(error.message);

		const asks = estimatesIn((rows ?? []) as Row[]);
		const todo = asks.slice(0, MAX_LEGS);
		if (!todo.length) return json({ refined: 0, remaining: 0 });

		let refined = 0;
		let stopped = false;
		const lanes = Array.from({ length: Math.min(LANES, todo.length) }, async (_, lane) => {
			for (let i = lane; i < todo.length; i += LANES) {
				if (stopped) return;
				const ask = todo[i];
				const { route, error: why } = await routeLeg(db, traveller, {
					from: ask.from,
					to: ask.to,
					mode: ask.mode,
					departAt: ask.departAt
				});
				// Out of budget: stop, rather than spending the rest of the day
				// being told the same thing once per leg.
				if (why === 'budget') {
					stopped = true;
					return;
				}
				if (!route) continue;
				// Written to the row, not to the plan: where the stop sits is the
				// traveller's, and may have changed while this was in flight.
				// What is true either way is how long this journey takes.
				const { error: writeError } = await db
					.from('plan_stops')
					.update({
						leg_minutes: route.minutes,
						leg_km: route.km,
						leg_source: 'routed'
					})
					.eq('id', ask.row.id)
					.eq('leg_source', 'estimate')
					// The plan may have been saved again while this was in flight,
					// giving the stop a different journey in. Matching the estimate
					// this answer was asked for means a changed leg is left alone
					// rather than told how long a journey it no longer makes takes.
					.eq('leg_minutes', ask.row.leg_minutes);
				if (!writeError) refined += 1;
			}
		});
		await Promise.all(lanes);

		return json({ refined, remaining: Math.max(0, asks.length - refined), budget: stopped });
	} catch (error) {
		console.error('refine function failed', error);
		return json({ refined: 0, error: 'internal' }, 500);
	}
});
