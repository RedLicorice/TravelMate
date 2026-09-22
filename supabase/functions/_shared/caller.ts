/**
 * Who is calling a function that spends money.
 *
 * The gateway verifies a token's signature before a function runs, so by the
 * time this reads the claims they are already proven. What it never decided is
 * which role they carry -- and it accepts the project's publishable key, which
 * ships inside the browser bundle and is meant to. Without this check anybody
 * holding that key can call the routing functions in a loop and spend the
 * whole Google budget.
 *
 * A signed-in traveller is the only caller either function has. Everything
 * else is turned away before a paid request is made.
 */
export function signedIn(req: Request): boolean {
	const token = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '').trim();
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
