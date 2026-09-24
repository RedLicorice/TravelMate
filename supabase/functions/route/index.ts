import { createClient } from 'jsr:@supabase/supabase-js@2';
import { cors } from '../_shared/cors.ts';
import { signedIn } from '../_shared/caller.ts';
import { routeLeg } from '../_shared/leg.ts';
import { isMode, isPoint, isWhen, type LatLng, type Mode } from '../_shared/input.ts';

/**
 * One leg, routed for a client that is drawing it.
 *
 * The routing itself lives in ../_shared/leg.ts, because the refiner works
 * through a whole plan of them and must spend money the same way.
 */

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { ...cors, 'Content-Type': 'application/json' }
	});

Deno.serve(async (req) => {
	if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

	// Paid work, so it is done for a traveller and nobody else.
	const traveller = await signedIn(req);
	if (!traveller) return json({ route: null }, 401);

	try {
		const { from, to, mode, departAt, prefer } = (await req.json()) as {
			from: LatLng;
			to: LatLng;
			mode: Mode;
			departAt: string | null;
			prefer?: 'rail' | null;
		};
		if (!from || !to) return json({ route: null });
		// Everything below this line is spent: a coordinate goes into a billed
		// request, and a mode Google does not know is a drive nobody asked for.
		if (!isMode(mode) || !isPoint(from) || !isPoint(to) || !isWhen(departAt)) {
			return json({ route: null, error: 'bad_request' }, 400);
		}
		if (prefer !== undefined && prefer !== null && prefer !== 'rail') {
			return json({ route: null, error: 'bad_request' }, 400);
		}

		const db = createClient(
			Deno.env.get('SUPABASE_URL')!,
			Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
		);
		// The journey sheet draws the path, so it is always asked for.
		const answer = await routeLeg(db, traveller, { from, to, mode, departAt, prefer, withPath: true });
		return json(answer, answer.error === 'budget' ? 429 : 200);
	} catch (error) {
		console.error('route function failed', error);
		// The caller gets no exception text: it names internal types and
		// constraints, and it is read by whoever asked, not by us.
		return json({ route: null, error: 'internal' }, 500);
	}
});
