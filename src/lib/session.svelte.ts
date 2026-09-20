import type { User } from '@supabase/supabase-js';
import { base } from '$app/paths';
import { PUBLIC_SUPABASE_PUBLISHABLE_KEY, PUBLIC_SUPABASE_URL } from '$env/static/public';
import { supabase } from './supabase';
import { safeNext } from './guard';

export const session = $state<{ user: User | null; ready: boolean }>({
	user: null,
	ready: false
});

export function watchSession(): () => void {
	supabase.auth.getSession().then(({ data }) => {
		session.user = data.session?.user ?? null;
		session.ready = true;
	});
	const { data } = supabase.auth.onAuthStateChange((_event, s) => {
		session.user = s?.user ?? null;
		session.ready = true;
	});
	return () => data.subscription.unsubscribe();
}

export async function signIn(email: string, next?: string | null): Promise<{ error: string | null }> {
	// The Pages subpath has to survive the round trip through the email link,
	// or the magic link lands on a 404 at the domain root. `next` carries the
	// page they were trying to reach -- usually a share link, which is useless
	// if signing in dumps them on their own trip list instead.
	const destination = safeNext(next) ?? '/';
	const { error } = await supabase.auth.signInWithOtp({
		email,
		options: { emailRedirectTo: window.location.origin + base + destination }
	});
	return { error: error?.message ?? null };
}

export async function signOut(): Promise<void> {
	await supabase.auth.signOut();
}

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
