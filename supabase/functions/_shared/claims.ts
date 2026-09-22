/**
 * What a token says about itself, before anything has proven it.
 *
 * Anybody can write these claims, so nothing here decides anything. It exists
 * so the common refusals -- no token, the publishable key, something long
 * expired -- cost nothing, and so the shape of a caller can be tested without
 * an auth server. `signedIn` in ./caller.ts is what actually decides.
 */
export function bearer(req: Request): string | null {
	const raw = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '').trim();
	return raw ? raw : null;
}

export function claimsSignedIn(req: Request): boolean {
	const token = bearer(req);
	if (!token) return false;

	// A publishable key in the newer `sb_publishable_...` shape is not a JWT at
	// all, so it fails here rather than parsing to some default role.
	const body = token.split('.')[1];
	if (!body) return false;

	try {
		const base64 = body.replace(/-/g, '+').replace(/_/g, '/');
		const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
		const claims = JSON.parse(atob(padded)) as { role?: string; exp?: number };
		if (typeof claims.exp === 'number' && claims.exp * 1000 <= Date.now()) return false;
		return claims.role === 'authenticated';
	} catch {
		return false;
	}
}
