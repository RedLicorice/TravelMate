import { upstream, type Mutation, type Row, type Table } from '$lib/store/store.svelte';
import { MEAL_LABEL, type MealName } from '$lib/plan/meals';

/** What a put-aside edit would do, row by row, in the traveller's words. */
export type Explained = { what: string; changes: { field: string; now: string; yours: string }[] }[];

/** What the screen knows that the rows do not: names, days, the trip's clock. */
export type Context = {
	timezone: string;
	dayName: (index: number) => string;
	placeName: (poiId: string) => string | null;
	personName: (userId: string) => string;
};

const FIELDS: Partial<Record<string, string>> = {
	at: 'When',
	day_index: 'Day',
	minutes: 'How long',
	duration_min: 'How long',
	pinned: 'Held where it is',
	priority: 'How much it is wanted',
	notes: 'Notes',
	name: 'Name',
	poi_id: 'Place',
	skipped: 'Skipped',
	role: 'Can edit',
	hotel_name: 'Hotel',
	arrival_at: 'Arrival',
	departure_at: 'Departure',
	image_url: 'Picture',
	share_token: 'Link',
	bag_drop_min: 'Checking in and out',
	arrival_buffer_min: 'Getting out of the airport',
	departure_buffer_min: 'At the terminal before leaving',
	prep_min: 'Getting ready',
	wake_at: 'Wake up',
	display_name: 'Name',
	exit_lat: 'Where it lets you out'
};

/** Bookkeeping the traveller never set and would not recognise. */
const QUIET = new Set(['id', 'trip_id', 'user_id', 'created_at', 'updated_at', 'version', 'exit_lng', 'hotel_lat', 'hotel_lng', 'city_south', 'city_north', 'city_west', 'city_east', 'added_by']);

function label(table: Table, row: Row, ctx: Context): string {
	switch (table) {
		case 'placements':
			return (
				(row.poi_id ? ctx.placeName(row.poi_id as string) : null) ??
				(row.meal ? MEAL_LABEL[row.meal as MealName] : null) ??
				(row.name as string | null) ??
				(row.kind === 'hotel' ? 'The hotel' : 'A card')
			) + ` · ${ctx.dayName(row.day_index as number)}`;
		case 'pois':
			return row.name as string;
		case 'trip_meals':
			return `${MEAL_LABEL[row.meal as MealName]} · ${ctx.dayName(row.day_index as number)}`;
		case 'trip_members':
			return ctx.personName(row.user_id as string);
		case 'profiles':
			return 'Your profile';
		default:
			return 'The trip';
	}
}

function shown(field: string, value: unknown, ctx: Context): string {
	if (value === null || value === undefined || value === '') return 'nothing';
	if (typeof value === 'boolean') return value ? 'yes' : 'no';
	if (field === 'day_index') return ctx.dayName(value as number);
	if (field === 'poi_id') return ctx.placeName(value as string) ?? 'a place';
	if (field === 'role') return value === 'editor' ? 'yes' : 'no';
	if (field.endsWith('_min') || field === 'minutes') return `${value} min`;
	if (typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value)) {
		return new Intl.DateTimeFormat(undefined, {
			timeZone: ctx.timezone,
			weekday: 'short',
			hour: '2-digit',
			minute: '2-digit',
			hour12: false
		}).format(new Date(value));
	}
	if (typeof value === 'object') return 'changed';
	return String(value);
}

const humane = (field: string) => FIELDS[field] ?? field.replace(/_/g, ' ');

/**
 * Each row the edit touches: what the trip says now, and what the edit would
 * make it say. Now is upstream -- the server's row -- because that is what
 * the card is drawing.
 */
export function explain(m: Mutation, ctx: Context): Explained {
	const out: Explained = [];
	for (const op of m.ops) {
		if (op.op === 'plan') continue;
		const now = upstream(op.table, op.key);
		const what = label(op.table, now ?? (op.op === 'insert' ? op.values : op.before), ctx);
		if (op.op === 'delete') {
			out.push({ what, changes: [{ field: 'On the trip', now: now ? 'yes' : 'already gone', yours: 'taken off' }] });
			continue;
		}
		if (op.op === 'update' && !now) {
			out.push({ what, changes: [{ field: 'On the trip', now: 'taken off by someone else', yours: 'put back, changed' }] });
			continue;
		}
		const changes = Object.entries(op.values)
			.filter(([field, value]) => !QUIET.has(field) && (!now || JSON.stringify(now[field]) !== JSON.stringify(value)))
			.map(([field, value]) => ({
				field: humane(field),
				now: now ? shown(field, now[field], ctx) : 'not there',
				yours: shown(field, value, ctx)
			}));
		if (op.op === 'insert' && !now) {
			out.push({ what, changes: [{ field: 'On the trip', now: 'not there', yours: 'added' }] });
		} else if (changes.length) {
			out.push({ what, changes });
		}
	}
	return out;
}
