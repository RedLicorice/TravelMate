import { createClient } from 'jsr:@supabase/supabase-js@2';
import { bearer, claimsSignedIn } from './claims.ts';

/**
 * Who is calling a function that spends money.
 *
 * The gateway does verify a token's signature before a function runs, so the
 * claims in ./claims.ts are, today, already proven. This does not lean on
 * that. The gateway's check is switched on by configuration living in another
 * file, and an authorisation check that quietly becomes a formality when
 * somebody edits `config.toml` is not a check -- it is a comment. So the token
 * is put to the auth server, which verifies the signature itself and answers
 * with the user it belongs to.
 *
 * Asked of the auth server rather than verified here against
 * SUPABASE_JWT_SECRET: that secret only verifies the legacy HS256 tokens, and
 * a project moved to asymmetric signing keys would have every real traveller
 * refused by a check that looks correct.
 *
 * Without any of this, anybody holding the publishable key -- which ships
 * inside the browser bundle, as it is meant to -- could call the routing
 * functions in a loop and spend the whole Google budget.
 *
 * Fails closed: if the auth server cannot be reached, nothing paid happens.
 */
export async function signedIn(req: Request): Promise<boolean> {
	const token = bearer(req);
	if (!token || !claimsSignedIn(req)) return false;

	try {
		const auth = createClient(
			Deno.env.get('SUPABASE_URL')!,
			Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
			{ auth: { persistSession: false, autoRefreshToken: false } }
		);
		const { data, error } = await auth.auth.getUser(token);
		return !error && !!data.user;
	} catch {
		return false;
	}
}
