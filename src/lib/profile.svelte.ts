import { supabase } from './supabase';
import { session } from './session.svelte';
import { newSeed } from './avatar';
import { DEFAULT_WINDOWS, type MealWindows } from './plan/meals';

export type ProfileRow = {
	user_id: string;
	display_name: string | null;
	avatar_url: string | null;
	avatar_seed: string | null;
	meal_windows: MealWindows;
	updated_at: string;
};

export type Profile = {
	userId: string;
	name: string;
	avatarSeed: string;
	avatarUrl: string | null;
	mealWindows: MealWindows;
};

export const toProfile = (row: ProfileRow): Profile => ({
	userId: row.user_id,
	name: row.display_name ?? '',
	// Seeded from the user id when unset, so the same person keeps the same
	// face across devices until they deliberately re-roll it.
	avatarSeed: row.avatar_seed ?? row.user_id,
	avatarUrl: row.avatar_url,
	mealWindows: row.meal_windows ?? DEFAULT_WINDOWS
});

/** The signed-in user's own row, created on first read. */
export async function loadMyProfile(): Promise<Profile> {
	const id = session.user?.id;
	if (!id) throw new Error('Not signed in');

	const { data, error } = await supabase.from('profiles').select('*').eq('user_id', id).maybeSingle();
	if (error) throw new Error(error.message);
	if (data) return toProfile(data as ProfileRow);

	// First sign-in: write the row rather than carrying a "maybe missing"
	// profile through every screen that reads one.
	const seed = { user_id: id, avatar_seed: newSeed(), meal_windows: DEFAULT_WINDOWS };
	const { data: created, error: insertError } = await supabase
		.from('profiles')
		.insert(seed)
		.select('*')
		.single();
	if (insertError) throw new Error(insertError.message);
	return toProfile(created as ProfileRow);
}

export async function saveMyProfile(patch: {
	display_name?: string | null;
	avatar_url?: string | null;
	avatar_seed?: string | null;
	meal_windows?: MealWindows;
}): Promise<Profile> {
	const id = session.user?.id;
	if (!id) throw new Error('Not signed in');
	const { data, error } = await supabase
		.from('profiles')
		.update({ ...patch, updated_at: new Date().toISOString() })
		.eq('user_id', id)
		.select('*')
		.single();
	if (error) throw new Error(error.message);
	return toProfile(data as ProfileRow);
}

/**
 * Everyone on a trip, with their preferences.
 *
 * Readable because of the profiles policy: a profile is visible to people you
 * share a trip with. This is the whole reason preferences moved out of
 * auth user_metadata, which only its owner can read.
 */
export async function loadTripProfiles(tripId: string): Promise<Profile[]> {
	const { data: members, error } = await supabase
		.from('trip_members')
		.select('user_id')
		.eq('trip_id', tripId);
	if (error) throw new Error(error.message);
	const ids = (members ?? []).map((m) => m.user_id);
	if (!ids.length) return [];

	const { data, error: profileError } = await supabase
		.from('profiles')
		.select('*')
		.in('user_id', ids);
	if (profileError) throw new Error(profileError.message);
	return (data ?? []).map((r) => toProfile(r as ProfileRow));
}

/** Display name, falling back to the local part of the email. */
export const displayName = (p: { name: string }, email?: string | null) =>
	p.name.trim() || email?.split('@')[0] || 'Traveller';
