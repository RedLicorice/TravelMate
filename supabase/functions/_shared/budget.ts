import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';

/**
 * What one traveller may spend in a day.
 *
 * Google bills a matrix per element, so a single 25-point matrix is 625 of
 * them. A trip's honest planning is a few hundred a day; a loop is thousands
 * an hour. The cap is generous enough that nobody planning a holiday meets
 * it, and cheap enough that meeting it costs pocket change.
 */
const DAILY = Number(Deno.env.get('DAILY_ELEMENT_BUDGET') ?? 5000);

/**
 * Charge the traveller for work about to be done, and say whether to do it.
 *
 * Charged before the call rather than after: a request that is refused after
 * the money is spent is not a budget. Fails closed -- if the meter cannot be
 * read, nothing paid happens.
 */
export async function afford(
	db: SupabaseClient,
	userId: string,
	elements: number
): Promise<boolean> {
	const { data, error } = await db.rpc('spend', {
		p_user: userId,
		p_elements: elements,
		p_cap: DAILY
	});
	if (error) {
		console.error('budget check failed', error.message);
		return false;
	}
	return data === true;
}
