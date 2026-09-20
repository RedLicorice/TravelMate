import { supabase } from './supabase';
import { session } from './session.svelte';
import { newSeed } from './avatar';

export type Profile = {
	name: string;
	/** Seed for the generated avatar. Ignored when avatarUrl is set. */
	avatarSeed: string;
	/** An uploaded picture, which wins over the generated one. */
	avatarUrl: string | null;
};

/**
 * Stored in the auth user's own metadata rather than a profiles table.
 * There is exactly one row per user, it is only ever read by that user, and
 * Supabase already scopes and returns it with the session -- a table would add
 * a migration, an RLS policy and a round trip to hold the same two fields.
 */
export function readProfile(): Profile {
	const meta = (session.user?.user_metadata ?? {}) as Partial<Profile>;
	return {
		name: meta.name ?? '',
		// Seeded from the user id so the same person keeps the same face across
		// devices until they deliberately re-roll it.
		avatarSeed: meta.avatarSeed ?? session.user?.id ?? newSeed(),
		avatarUrl: meta.avatarUrl ?? null
	};
}

export async function saveProfile(patch: Partial<Profile>): Promise<void> {
	const { data, error } = await supabase.auth.updateUser({ data: patch });
	if (error) throw new Error(error.message);
	// updateUser returns the new user; push it into the rune so every avatar on
	// screen updates without a reload.
	if (data.user) session.user = data.user;
}

/** Display name, falling back to the local part of the email. */
export function displayName(p: Profile, email?: string | null): string {
	return p.name.trim() || email?.split('@')[0] || 'Traveller';
}
