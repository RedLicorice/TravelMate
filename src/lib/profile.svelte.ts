import { mutate, ofTrip, row, type Writer } from './store/store.svelte';
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
	version: number;
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

/** The signed-in traveller's own profile, as this device holds it. */
export function myProfile(): Profile | null {
	const id = session.user?.id;
	const mine = id ? row<ProfileRow>('profiles', { user_id: id }) : null;
	return mine ? toProfile(mine) : null;
}

/**
 * First sign-in: the row is written rather than carrying a "maybe missing"
 * profile through every screen that reads one. Called once the server has
 * said there is none.
 */
export function ensureMyProfile(): Promise<void> {
	const id = session.user?.id;
	if (!id || row('profiles', { user_id: id })) return Promise.resolve();
	return mutate('Set up your profile', null, (w) =>
		w.insert('profiles', {
			user_id: id,
			display_name: null,
			avatar_url: null,
			avatar_seed: newSeed(),
			meal_windows: DEFAULT_WINDOWS,
			wake_at: '08:00:00',
			prep_min: 30,
			updated_at: new Date().toISOString(),
			version: 1
		})
	);
}

export function saveMyProfile(
	w: Writer,
	patch: {
		display_name?: string | null;
		avatar_url?: string | null;
		avatar_seed?: string | null;
		meal_windows?: MealWindows;
		wake_at?: string;
		prep_min?: number;
	}
): void {
	const id = session.user?.id;
	if (!id) throw new Error('Not signed in');
	w.update('profiles', { user_id: id }, { ...patch, updated_at: new Date().toISOString() });
}

/**
 * Everyone on a trip, with their preferences.
 *
 * Readable because of the profiles policy: a profile is visible to people you
 * share a trip with. This is the whole reason preferences moved out of
 * auth user_metadata, which only its owner can read.
 */
export function tripProfiles(tripId: string): Profile[] {
	return ofTrip<{ user_id: string; role: TripRole }>('trip_members', tripId).flatMap((m) => {
		const p = row<ProfileRow>('profiles', { user_id: m.user_id });
		return p ? [{ ...toProfile(p), role: m.role }] : [];
	});
}

/** Hand someone the pen, or take it back. Only the owner may. */
export const setMemberRole = (w: Writer, tripId: string, userId: string, role: 'editor' | 'viewer') =>
	w.update('trip_members', { trip_id: tripId, user_id: userId }, { role });

/** Put someone off the trip. Revoking the link never did this. Only the owner may. */
export const removeMember = (w: Writer, tripId: string, userId: string) =>
	w.remove('trip_members', { trip_id: tripId, user_id: userId });

/** Display name, falling back to the local part of the email. */
export const displayName = (p: { name: string }, email?: string | null) =>
	p.name.trim() || email?.split('@')[0] || 'Traveller';
