/**
 * Where a visitor should be sent, or null to leave them alone.
 *
 * Pure and dependency-free so it can be tested without a browser, a session,
 * or the Supabase client. Returns a base-less route; the caller prefixes it.
 */
export function redirectTarget(pathname: string, hasUser: boolean, base = ''): string | null {
	// Under GitHub Pages every path carries the repo subpath. Matching the raw
	// pathname would never equal '/login' and the guard would bounce forever.
	const route = base && pathname.startsWith(base) ? pathname.slice(base.length) || '/' : pathname;

	if (route.startsWith('/shared/')) return null; // public by design
	if (!hasUser) return route === '/login' ? null : '/login';
	return route === '/login' ? '/' : null;
}
