import type { User } from '@supabase/supabase-js';
import { base } from '$app/paths';
import { PUBLIC_SUPABASE_PUBLISHABLE_KEY, PUBLIC_SUPABASE_URL } from '$env/static/public';
import { supabase } from './supabase';
import { safeNext } from './guard';
import { forgetAll, unsent } from './store/store.svelte';

export const session = $state<{ user: User | null; ready: boolean }>({
	user: null,
	ready: false
});

/** Whose the trips on this device are. */
const OWNER = 'tm:cached-for';

/**
 * The trips on this device belong to whoever is signed in, and go when they
 * do. On a shared phone the next person to sign in would otherwise be drawn
 * the previous account's trips before the server had said a word -- row-level
 * security stepped around by the device, with nobody doing anything wrong.
 */
async function ownedBy(id: string | null): Promise<void> {
	let owner: string | null = null;
	try {
		owner = localStorage.getItem(OWNER);
	} catch {
		// No localStorage to remember an owner with: clear rather than guess.
	}
	if (owner === id && owner !== null) return;
	await forgetAll();
	try {
		if (id) localStorage.setItem(OWNER, id);
		else localStorage.removeItem(OWNER);
	} catch {
		// As above.
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
	// The device is cleared before anything is declared ready, not alongside
	// it: the layout reads the moment it is ready, and a read that beats the
	// clearing is drawn the previous account's trips.
	supabase.auth.getSession().then(async ({ data }) => {
		const user = data.session?.user ?? null;
		await ownedBy(user?.id ?? null);
		session.user = user;
		session.ready = true;
	});
	const { data } = supabase.auth.onAuthStateChange((_event, s) => {
		const user = s?.user ?? null;
		// Not awaited here: nothing in the clearing has anything to say back
		// to auth, so readiness waits on it rather than auth doing.
		void ownedBy(user?.id ?? null).then(() => {
			session.user = user;
			session.ready = true;
		});
	});
	return () => data.subscription.unsubscribe();
}

/**
 * Sign out, and take this account's trips off the device.
 *
 * Edits made here that the server has not accepted yet would go with them,
 * and nothing else has a copy: so the traveller is asked first. Returns
 * whether they went ahead.
 */
export async function signOut(): Promise<boolean> {
	const waiting = unsent();
	if (
		waiting &&
		!confirm(
			`${waiting} change${waiting === 1 ? ' has' : 's have'} not reached the trip yet. Signing out now throws ${waiting === 1 ? 'it' : 'them'} away.`
		)
	) {
		return false;
	}
	await supabase.auth.signOut();
	await ownedBy(null);
	return true;
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
