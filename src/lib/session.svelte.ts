import type { User } from '@supabase/supabase-js';
import { base } from '$app/paths';
import { supabase } from './supabase';

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

export async function signIn(email: string): Promise<{ error: string | null }> {
	const { error } = await supabase.auth.signInWithOtp({
		email,
		// The Pages subpath has to survive the round trip through the email link,
		// or the magic link lands on a 404 at the domain root.
		options: { emailRedirectTo: window.location.origin + base + '/' }
	});
	return { error: error?.message ?? null };
}

export async function signOut(): Promise<void> {
	await supabase.auth.signOut();
}
