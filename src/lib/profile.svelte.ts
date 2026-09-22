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
	wake_at: string;
	prep_min: number;
	updated_at: string;
};

/** Owner and editor may write the trip; a viewer holds a link, and reads. */
export type TripRole = 'owner' | 'editor' | 'viewer';

export type Profile = {
	userId: string;
	/** What they may do here. Absent outside a trip. */
	role?: TripRole;
	name: string;
	avatarSeed: string;
	avatarUrl: string | null;
	mealWindows: MealWindows;
	/** Local wall-clock 'HH:MM'. */
	wakeAt: string;
	prepMin: number;
};

export const toProfile = (row: ProfileRow): Profile => ({
	userId: row.user_id,
	name: row.display_name ?? '',
	// Seeded from the user id when unset, so the same person keeps the same
	// face across devices until they deliberately re-roll it.
	avatarSeed: row.avatar_seed ?? row.user_id,
	avatarUrl: row.avatar_url,
	// Merged rather than replaced: a row written before breakfast existed still
	// has its own lunch and dinner, and should keep them.
	mealWindows: { ...DEFAULT_WINDOWS, ...(row.meal_windows ?? {}) },
	wakeAt: (row.wake_at ?? '08:00').slice(0, 5),
	prepMin: row.prep_min ?? 30
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
	wake_at?: string;
	prep_min?: number;
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
		.select('user_id,role')
		.eq('trip_id', tripId);
	if (error) throw new Error(error.message);
	const ids = (members ?? []).map((m) => m.user_id);
	if (!ids.length) return [];

	const { data, error: profileError } = await supabase
		.from('profiles')
		.select('*')
		.in('user_id', ids);
	if (profileError) throw new Error(profileError.message);
	const roles = new Map((members ?? []).map((m) => [m.user_id, m.role as TripRole]));
	return (data ?? []).map((r) => ({
		...toProfile(r as ProfileRow),
		role: roles.get((r as ProfileRow).user_id)
	}));
}

/**
 * Hand someone the pen, or take it back.
 *
 * Only the owner may: the policy says so, and a write it refuses answers with
 * no rows rather than an error, so the row is asked for back.
 */
export async function setMemberRole(
	tripId: string,
	userId: string,
	role: 'editor' | 'viewer'
): Promise<void> {
	const { data, error } = await supabase
		.from('trip_members')
		.update({ role })
		.eq('trip_id', tripId)
		.eq('user_id', userId)
		.select('user_id');
	if (error) throw new Error(error.message);
	if (!data?.length) throw new Error('Only the traveller who made the trip can change who edits it.');
}

/** Put someone off the trip. Revoking the link never did this. */
export async function removeMember(tripId: string, userId: string): Promise<void> {
	const { data, error } = await supabase
		.from('trip_members')
		.delete()
		.eq('trip_id', tripId)
		.eq('user_id', userId)
		.select('user_id');
	if (error) throw new Error(error.message);
	if (!data?.length) throw new Error('Only the traveller who made the trip can remove a traveller.');
}

/** Display name, falling back to the local part of the email. */
export const displayName = (p: { name: string }, email?: string | null) =>
	p.name.trim() || email?.split('@')[0] || 'Traveller';
