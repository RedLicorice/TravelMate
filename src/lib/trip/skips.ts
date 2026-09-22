import { supabase } from '$lib/supabase';
import type { DayAnchor } from './days';

/**
 * The pieces of furniture the traveller has taken out of a day.
 *
 * Every day is drawn starting at the hotel, getting ready, and ending back at
 * the hotel, because that is what most days are. It is still a guess, and this
 * is how somebody says otherwise -- a night out that does not end in bed, a
 * morning that needs no getting ready, an arrival that checks in later.
 */
export const skipKey = (dayIndex: number, anchor: DayAnchor) => `${dayIndex}:${anchor}`;

export async function loadSkips(tripId: string): Promise<Set<string>> {
	const { data, error } = await supabase
		.from('day_skips')
		.select('day_index,anchor')
		.eq('trip_id', tripId);
	if (error) throw new Error(error.message);
	return new Set((data ?? []).map((r) => `${r.day_index}:${r.anchor}`));
}

export async function skipAnchor(
	tripId: string,
	dayIndex: number,
	anchor: DayAnchor
): Promise<void> {
	const { error } = await supabase
		.from('day_skips')
		.upsert({ trip_id: tripId, day_index: dayIndex, anchor }, { onConflict: 'trip_id,day_index,anchor' });
	if (error) throw new Error(error.message);
}

export async function keepAnchor(
	tripId: string,
	dayIndex: number,
	anchor: DayAnchor
): Promise<void> {
	const { error } = await supabase
		.from('day_skips')
		.delete()
		.eq('trip_id', tripId)
		.eq('day_index', dayIndex)
		.eq('anchor', anchor);
	if (error) throw new Error(error.message);
}
