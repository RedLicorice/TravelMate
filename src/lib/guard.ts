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
	// The recovery token in the URL is what creates the session, so this page
	// must render before one exists.
	if (route === '/reset') return null;
	// The notices are read before signing up, so they are open to anybody.
	if (route === '/terms' || route === '/privacy') return null;
	if (!hasUser) return route === '/login' ? null : '/login';
	return route === '/login' ? '/' : null;
}

/**
 * A post-login destination taken from the URL, or null when it is not safe.
 *
 * Only same-origin absolute paths. Anything protocol-relative ("//evil.com"),
 * absolute ("https://evil.com") or backslash-smuggled would otherwise turn the
 * login screen into an open redirect: send someone a link to our own domain
 * and land them on yours, still trusting the address bar they started from.
 */
export function safeNext(raw: string | null | undefined): string | null {
	if (!raw) return null;
	const value = raw.trim();
	if (!value.startsWith('/')) return null;
	// '//host' and '/\host' are both protocol-relative to a browser.
	if (value.startsWith('//') || value.startsWith('/\\')) return null;
	if (value.includes('://')) return null;
	return value;
}
