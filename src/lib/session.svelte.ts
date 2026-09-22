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
}

/** Whose the cache on this device is. */
const CACHE_OWNER = 'tm:cached-for';

function ownedBy(id: string | null): void {
	try {
		if (localStorage.getItem(CACHE_OWNER) === id) return;
		// Someone else's rows, or nobody's. Either way, not this account's.
		void forgetCachedTrips();
		if (id) localStorage.setItem(CACHE_OWNER, id);
		else localStorage.removeItem(CACHE_OWNER);
	} catch {
		// No localStorage to remember an owner with: clear rather than guess.
		void forgetCachedTrips();
	}
}

export function watchSession(): () => void {
	supabase.auth.getSession().then(({ data }) => {
		session.user = data.session?.user ?? null;
		session.ready = true;
		ownedBy(session.user?.id ?? null);
	});
	const { data } = supabase.auth.onAuthStateChange((_event, s) => {
		session.user = s?.user ?? null;
		session.ready = true;
		// Not awaited: this callback holds the auth lock, and clearing a cache
		// has nothing to say back to it.
		ownedBy(session.user?.id ?? null);
	});
	return () => data.subscription.unsubscribe();
}

export async function signOut(): Promise<void> {
	await supabase.auth.signOut();
	// After, not before: a read still in flight would otherwise refill the
	// cache on its way out. Signed out, those reads are refused, and a refusal
	// is not cached.
	ownedBy(null);
	await forgetCachedTrips();
}

/*
 * There is no magic-link sign-in. A magic link opens in the browser, so from a
 * home-screen PWA it signs you in somewhere other than the app you were
 * standing in. The only emailed link left is the password reset below, which
 * is a magic link used to set a password rather than to stand in for one.
 */

const dest = (next?: string | null) => window.location.origin + base + (safeNext(next) ?? '/');

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
	const { data, error } = await supabase.auth.signUp({
		email,
		password,
		options: { emailRedirectTo: dest(next) }
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
	const { error } = await supabase.auth.signInWithOAuth({
		provider,
		options: { redirectTo: dest(next) }
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
