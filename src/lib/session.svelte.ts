import type { User } from '@supabase/supabase-js';
import { base } from '$app/paths';
import { PUBLIC_SUPABASE_PUBLISHABLE_KEY, PUBLIC_SUPABASE_URL } from '$env/static/public';
import { supabase } from './supabase';
import { safeNext } from './guard';

export const session = $state<{ user: User | null; ready: boolean }>({
	user: null,
	ready: false
});

/**
 * Everything this device kept for an account that is leaving it.
 *
 * The service worker caches trip reads so the plan opens on a dead connection,
 * and it keys them by URL -- a URL that says nothing about whose rows came
 * back. On a shared phone the next person to sign in would be handed the
 * previous account's trips out of that cache before the network answered at
 * all: row-level security stepped around by a cache, with neither of them
 * doing anything wrong.
 *
 * So the cache belongs to whoever is signed in, and it goes when they do.
 */
async function forgetCachedTrips(): Promise<void> {
	if (typeof caches === 'undefined') return;
	try {
		// The name Workbox was given in vite.config.ts. It is recreated empty
		// the next time anything is read.
		await caches.delete('trip-data');
	} catch {
		// A browser with storage blocked has nothing cached to hand over.
	}
	try {
		// Workbox keeps its own index of what it cached, and the entries name
		// the rows: trip_id=eq.<uuid>, user_id=in.(...). Deleting the cache
		// leaves that index behind, so the previous account's trips are still
		// written down after their contents are gone.
		indexedDB.deleteDatabase('workbox-expiration');
	} catch {
		// Same as above: nothing kept, nothing to forget.
	}
}

/** Whose the cache on this device is. */
const CACHE_OWNER = 'tm:cached-for';

async function ownedBy(id: string | null): Promise<void> {
	try {
		if (localStorage.getItem(CACHE_OWNER) === id) return;
		// Someone else's rows, or nobody's. Either way, not this account's.
		await forgetCachedTrips();
		if (id) localStorage.setItem(CACHE_OWNER, id);
		else localStorage.removeItem(CACHE_OWNER);
	} catch {
		// No localStorage to remember an owner with: clear rather than guess.
		await forgetCachedTrips();
	}
}

/**
 * Where the traveller was heading before they were asked to sign in.
 *
 * Kept on the device rather than carried in ?next=, because that parameter
 * ends up inside the URL handed to Google or Apple and inside a confirmation
 * e-mail -- and the page they were heading for is often /shared/<token>, where
 * the token is the capability to join the trip.
 */
const INTENDED = 'tm:next';

function rememberNext(next?: string | null): void {
	try {
		const safe = safeNext(next);
		if (safe) sessionStorage.setItem(INTENDED, safe);
		else sessionStorage.removeItem(INTENDED);
	} catch {
		// Without sessionStorage they land on the trip list. A lost redirect is
		// not worth leaking the token to avoid.
	}
}

/** Read once: a destination already gone to is not a destination. */
export function takeNext(): string | null {
	try {
		const kept = sessionStorage.getItem(INTENDED);
		sessionStorage.removeItem(INTENDED);
		return safeNext(kept);
	} catch {
		return null;
	}
}

export function watchSession(): () => void {
	// The cache is cleared before anything is declared ready, not alongside it:
	// the layout reads the moment it is ready, and a read that beats the
	// eviction is served the previous account's trips out of the cache.
	supabase.auth.getSession().then(async ({ data }) => {
		const user = data.session?.user ?? null;
		await ownedBy(user?.id ?? null);
		session.user = user;
		session.ready = true;
	});
	const { data } = supabase.auth.onAuthStateChange((_event, s) => {
		const user = s?.user ?? null;
		// Not awaited here: this callback holds the auth lock. Clearing a cache
		// has nothing to say back to it, so readiness waits on the eviction
		// rather than the lock doing.
		void ownedBy(user?.id ?? null).then(() => {
			session.user = user;
			session.ready = true;
		});
	});
	return () => data.subscription.unsubscribe();
}

export async function signOut(): Promise<void> {
	await supabase.auth.signOut();
	// After, not before: a read still in flight would otherwise refill the
	// cache on its way out. Signed out, those reads are refused, and a refusal
	// is not cached.
	await ownedBy(null);
	await forgetCachedTrips();
}

/*
 * There is no magic-link sign-in. A magic link opens in the browser, so from a
 * home-screen PWA it signs you in somewhere other than the app you were
 * standing in. The only emailed link left is the password reset below, which
 * is a magic link used to set a password rather than to stand in for one.
 */

/**
 * Where a provider or an e-mailed link comes back to.
 *
 * Always the app's own front door. Where the traveller was actually heading is
 * remembered on the device by rememberNext, so it is never written into a URL
 * that leaves us.
 */
const dest = () => window.location.origin + base + '/';

export async function signInWithPassword(
	email: string,
	password: string
): Promise<{ error: string | null }> {
	const { error } = await supabase.auth.signInWithPassword({ email, password });
	return { error: error?.message ?? null };
}

export async function signUpWithPassword(
	email: string,
	password: string,
	next?: string | null
): Promise<{ error: string | null; needsConfirmation: boolean }> {
	rememberNext(next);
	const { data, error } = await supabase.auth.signUp({
		email,
		password,
		options: { emailRedirectTo: dest() }
	});
	if (error) return { error: error.message, needsConfirmation: false };
	// With confirmations on, Supabase returns a user but no session until the
	// address is verified. Saying so beats a screen that silently does nothing.
	return { error: null, needsConfirmation: !data.session };
}

export async function sendPasswordReset(
	email: string
): Promise<{ error: string | null }> {
	const { error } = await supabase.auth.resetPasswordForEmail(email, {
		redirectTo: window.location.origin + base + '/reset'
	});
	return { error: error?.message ?? null };
}

export async function setPassword(password: string): Promise<{ error: string | null }> {
	const { error } = await supabase.auth.updateUser({ password });
	return { error: error?.message ?? null };
}

export type OAuthProvider = 'google' | 'apple';

export async function signInWithProvider(
	provider: OAuthProvider,
	next?: string | null
): Promise<{ error: string | null }> {
	rememberNext(next);
	const { error } = await supabase.auth.signInWithOAuth({
		provider,
		options: { redirectTo: dest() }
	});
	return { error: error?.message ?? null };
}

/**
 * Which providers this project actually has configured.
 *
 * Read at runtime rather than hardcoded: a button for a provider nobody set up
 * is a button that throws. Configure Google or Apple in the Supabase dashboard
 * and it appears here on the next load, with no deploy.
 */
export async function enabledProviders(): Promise<OAuthProvider[]> {
	try {
		const res = await fetch(`${PUBLIC_SUPABASE_URL}/auth/v1/settings`, {
			headers: { apikey: PUBLIC_SUPABASE_PUBLISHABLE_KEY }
		});
		if (!res.ok) return [];
		const body = (await res.json()) as { external?: Record<string, boolean> };
		return (['google', 'apple'] as const).filter((p) => body.external?.[p]);
	} catch {
		// Offline, or the settings endpoint is having a day. Password sign-in
		// still works, so this must not take the login screen down with it.
		return [];
	}
}
