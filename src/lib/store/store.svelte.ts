/**
 * The trip, as this device holds it. The only way into the data.
 *
 * Every screen reads from here, and every read is answered from memory -- the
 * device database is loaded once, before the first screen draws, so there is
 * nothing to wait for. Every change is a named edit made through `mutate`:
 * it lands in memory and in the device's queue together, or not at all, and
 * is sent to the server when there is a connection (sync.ts). Nothing else in
 * the app talks to the database.
 *
 * What the screens see is the rows the server last confirmed with the queued
 * edits laid over them, in the order they were made. An edit the server
 * accepts becomes part of the confirmed rows; one it refuses is taken off the
 * top, which returns the screen to what the server actually holds; one it
 * finds in conflict is put aside, and the screen shows upstream until the
 * traveller says which to keep.
 *
 * Two tabs of the app on one device share the queue. The rule between them:
 * an edit is made against what the acting tab is showing, and it stands --
 * edits from both tabs go up in the order they were made, and a later one
 * simply writes over an earlier one, as it would in a single tab. A tab that
 * did not make an edit is told it happened, and redraws from the device.
 */
import { supabase } from '$lib/supabase';
import { forget, req, tx } from './idb';
import {
	CHANNEL,
	SYNC_LOCK,
	SYNC_TAG,
	drain,
	eachOfTrip,
	held,
	keyOf,
	rowId,
	type Held,
	type Key,
	type Mutation,
	type Op,
	type Outcome,
	type Row,
	type Table
} from './sync';

export type { Mutation, Row, Table } from './sync';

const tab = crypto.randomUUID();

/** What the server last confirmed. */
let confirmed = new Map<string, Held>();
/** Edits not yet accepted: queued, in flight, or put aside. */
let queue = $state.raw<Mutation[]>([]);
/** The edit being written right now, visible to reads made while writing it. */
let open: Mutation | null = null;

let tick = $state(0);
const bump = () => tick++;

/** Said to the traveller: an edit made in another window. Refusals are kept in the queue. */
export const notices = $state<{ id: number; text: string }[]>([]);
let noticeId = 0;
function tell(text: string) {
	notices.push({ id: ++noticeId, text });
}
export const dismiss = (id: number) => {
	const i = notices.findIndex((n) => n.id === id);
	if (i >= 0) notices.splice(i, 1);
};

/** The confirmed rows with every queued edit laid over them. */
function lay(): Map<string, Held> {
	const view = new Map(confirmed);
	const gone = new Set<string>();
	for (const m of open ? [...queue, open] : queue) {
		if (m.state !== 'queued') continue;
		for (const op of m.ops) {
			if (op.op === 'plan') {
				for (const [id, h] of view) if (h.table === 'plan_stops' && h.trip === op.trip) view.delete(id);
				for (const r of op.rows) {
					const h = held('plan_stops', { ...r, trip_id: op.trip });
					view.set(h.id, h);
				}
				// Stamped on the trip, as the server stamps it on saving.
				const trip = view.get(rowId('trips', { id: op.trip }));
				if (trip) {
					view.set(trip.id, held('trips', { ...trip.row, plan_generated_at: op.generated_at, plan_version: op.planner_version }));
				}
				continue;
			}
			const id = rowId(op.table, op.key);
			if (op.op === 'delete') {
				view.delete(id);
				if (op.table === 'trips') gone.add(op.key.id as string);
			} else if (op.op === 'insert') {
				view.set(id, held(op.table, op.values));
			} else {
				// A row the server says is gone stays gone: the edit to it is
				// the server's to refuse, or the traveller's to reinstate.
				const was = view.get(id);
				if (was) view.set(id, held(op.table, { ...was.row, ...op.values }));
			}
		}
	}
	if (gone.size) for (const [id, h] of view) if (h.trip && gone.has(h.trip)) view.delete(id);
	return view;
}

type Index = { rows: Map<string, Held>; byTrip: Map<string, Map<Table, Row[]>>; trips: Row[] };

const view = $derived.by<Index>(() => {
	void tick;
	void queue;
	const rows = lay();
	const byTrip = new Map<string, Map<Table, Row[]>>();
	const trips: Row[] = [];
	for (const h of rows.values()) {
		if (h.table === 'trips') trips.push(h.row);
		if (!h.trip || h.table === 'trips') continue;
		let tables = byTrip.get(h.trip);
		if (!tables) byTrip.set(h.trip, (tables = new Map()));
		let list = tables.get(h.table);
		if (!list) tables.set(h.table, (list = []));
		list.push(h.row);
	}
	return { rows, byTrip, trips };
});

// --- Reads -----------------------------------------------------------------

/**
 * What has been asked of the server this session, so a screen with nothing
 * to show can tell "nothing yet" from "nothing": `listed` once the trip list
 * has been asked for, and each trip id once that trip has.
 */
export const store = $state({ ready: false, listed: false, asked: [] as string[] });

export const allTrips = <T = Row>(): T[] => view.trips as T[];
export const row = <T = Row>(table: Table, key: Key): T | null =>
	(view.rows.get(rowId(table, key))?.row as T) ?? null;
export const ofTrip = <T = Row>(table: Table, trip: string): T[] =>
	(view.byTrip.get(trip)?.get(table) as T[]) ?? [];
export const rows = <T = Row>(table: Table): T[] =>
	[...view.rows.values()].filter((h) => h.table === table).map((h) => h.row as T);

/** Edits on this device the server has not accepted yet. */
export const unsent = () => queue.filter((m) => m.state !== 'refused').length + (open ? 1 : 0);

/** Edits the server would not take, until the traveller has read why. */
export const refused = () => queue.filter((m) => m.state === 'refused');

/** Told: the refused edit is gone from the device. */
export async function seen(m: Mutation): Promise<void> {
	await tx(['queue'], 'readwrite', (t) => void t.objectStore('queue').delete(m.seq!));
	queue = queue.filter((x) => x.seq !== m.seq);
	announce('synced');
}

/** The put-aside edit a row is waiting on, if any. */
export function asideFor(table: Table, key: Key): Mutation | null {
	const id = rowId(table, key);
	return (
		queue.find(
			(m) =>
				m.state === 'aside' &&
				m.conflicts?.some((c) => {
					const op = m.ops[c.index];
					return op.op !== 'plan' && rowId(op.table, op.key) === id;
				})
		) ?? null
	);
}

/** Every put-aside edit on a trip. */
export const asideOn = (trip: string) =>
	queue.filter((m) => m.state === 'aside' && m.trip === trip);

/** What the server holds for a row, as opposed to what this device shows. */
export const upstream = <T = Row>(table: Table, key: Key): T | null =>
	(confirmed.get(rowId(table, key))?.row as T) ?? null;

// --- Writes ----------------------------------------------------------------

export type Writer = {
	/** A whole new row. Its key is the client's to choose. */
	insert(table: Table, values: Row): void;
	/** Change some columns of a row. Unchanged columns are not sent. */
	update(table: Table, key: Key, values: Row): void;
	remove(table: Table, key: Key): void;
	/** The trip's plan, as drawn, replacing the stored one whole. */
	plan(trip: string, rows: Row[], plannerVersion: number): string;
};

/** What serialises edits to a row on the server: its trip, or its person. */
const lockOf = (table: Table, values: Row): string =>
	table === 'trips'
		? (values.id as string)
		: table === 'profiles'
			? (values.user_id as string)
			: (values.trip_id as string);

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Make one edit.
 *
 * `work` runs synchronously and describes the edit through the writer; every
 * read it makes -- through this module, or through anything derived from it
 * -- already sees the writes before it, so an edit can be followed by
 * whatever follows from it (a moved card, then the day re-timed around it)
 * and the whole lands as one. If `work` throws, nothing happened.
 *
 * The screen changes at once. The returned promise settles when the edit is
 * safely in the device database; if that fails the screen is put back and
 * the promise rejects.
 */
export async function mutate(
	name: string,
	trip: string | null,
	work: (w: Writer) => void
): Promise<void> {
	if (open) throw new Error(`“${name}” was started while “${open.name}” was being made.`);
	const m: Mutation = {
		id: crypto.randomUUID(),
		name,
		trip,
		at: new Date().toISOString(),
		ops: [],
		state: 'queued'
	};
	const push = (op: Op) => {
		m.ops.push(op);
		bump();
	};
	/**
	 * A row this same edit creates. Changing it again inside the edit changes
	 * what is created -- a separate write would be made against a version the
	 * row has never had, and the server would rightly refuse it.
	 */
	const made = (table: Table, key: Key) =>
		m.ops.findIndex((o) => o.op === 'insert' && o.table === table && rowId(table, o.key) === rowId(table, key));
	const writer: Writer = {
		insert(table, values) {
			push({ op: 'insert', table, key: keyOf(table, values), lock: lockOf(table, values), base: null, values });
		},
		update(table, key, values) {
			const was = view.rows.get(rowId(table, key))?.row;
			if (!was) throw new Error(`“${name}”: there is no such ${table} row on this device.`);
			const changed = Object.fromEntries(Object.entries(values).filter(([k, v]) => !same(was[k], v)));
			if (!Object.keys(changed).length) return;
			const created = made(table, key);
			if (created >= 0) {
				const op = m.ops[created] as Extract<Op, { op: 'insert' }>;
				op.values = { ...op.values, ...changed };
				bump();
				return;
			}
			const base = (confirmed.get(rowId(table, key))?.row.version as number | undefined) ?? null;
			push({ op: 'update', table, key, lock: lockOf(table, was), base, values: changed, before: was });
		},
		remove(table, key) {
			const was = view.rows.get(rowId(table, key))?.row;
			if (!was) return;
			// Made and unmade in one edit: nothing to send.
			const created = made(table, key);
			if (created >= 0) {
				m.ops.splice(created, 1);
				bump();
				return;
			}
			const base = (confirmed.get(rowId(table, key))?.row.version as number | undefined) ?? null;
			push({ op: 'delete', table, key, lock: lockOf(table, was), base, before: was });
		},
		plan(trip, rows, plannerVersion) {
			const generated_at = new Date().toISOString();
			push({ op: 'plan', trip, rows, planner_version: plannerVersion, generated_at });
			return generated_at;
		}
	};

	open = m;
	try {
		work(writer);
	} catch (e) {
		open = null;
		bump();
		throw e;
	}
	open = null;
	if (!m.ops.length) {
		bump();
		return;
	}
	queue = [...queue, m];
	try {
		const seq = await tx(['queue'], 'readwrite', (t) =>
			req(t.objectStore('queue').add($state.snapshot(m)) as IDBRequest<number>)
		);
		queue = queue.map((x) => (x === m ? { ...m, seq } : x));
	} catch (e) {
		queue = queue.filter((x) => x !== m);
		throw new Error(`“${name}” could not be kept on this device: ${(e as Error).message}`);
	}
	announce('changed', name);
	send();
}

// --- The device database ---------------------------------------------------

/** Read everything the device holds into memory. */
async function load(): Promise<void> {
	const [rows, kept] = await tx(['rows', 'queue'], 'readonly', (t) =>
		Promise.all([
			req(t.objectStore('rows').getAll() as IDBRequest<Held[]>),
			req(t.objectStore('queue').getAll() as IDBRequest<Mutation[]>)
		])
	);
	confirmed = new Map(rows.map((h) => [h.id, h]));
	// An edit still on its way into the database is not in `kept` yet.
	queue = [...kept, ...queue.filter((m) => m.seq === undefined)];
	bump();
}

/** Called once, before the first screen draws. */
export async function openStore(): Promise<void> {
	if (store.ready) return;
	try {
		await load();
	} finally {
		store.ready = true;
	}
	channel?.addEventListener('message', (e: MessageEvent<{ from: string; kind: string; name?: string }>) => {
		if (e.data.from === tab) return;
		void load();
		if (e.data.kind === 'changed' && e.data.name) tell(`Changed in another window: ${e.data.name}.`);
	});
	addEventListener('online', send);
}

const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL);
const announce = (kind: 'changed' | 'synced', name?: string) =>
	channel?.postMessage({ from: tab, kind, name });

/** Everything this device held for the account that is leaving it. */
export async function forgetAll(): Promise<void> {
	// Under the lock a send or a pull holds, so one already on its way lands
	// before the clearing and not after it, which would put the leaving
	// account's rows back on the device.
	await navigator.locks.request(SYNC_LOCK, forget);
	confirmed = new Map();
	queue = [];
	bump();
	announce('synced');
}

// --- Sending ---------------------------------------------------------------

let sending: Promise<void> | null = null;
let again = false;

/**
 * Send the queue now, if there is a connection; and ask for Background Sync
 * in case the tab is closed first. Where the browser has no Background Sync
 * (Safari, Firefox) the page is what sends: now, when the connection comes
 * back, and when the app is next opened.
 */
export function send(): void {
	void navigator.serviceWorker?.ready
		.then((r) => (r as ServiceWorkerRegistration & { sync?: { register(tag: string): Promise<void> } }).sync?.register(SYNC_TAG))
		.catch(() => {});
	if (sending) {
		again = true;
		return;
	}
	sending = (async () => {
		do {
			again = false;
			const touched = new Set<string>();
			try {
				await drain(supabase, (o: Outcome) => {
					if (o.kind === 'refused' && o.mutation.trip) touched.add(o.mutation.trip);
				});
			} catch {
				// No locks API, or the database went away mid-send. What is queued
				// stays queued; the next edit or reconnection tries again.
			}
			await load();
			announce('synced');
			// A refusal leaves this device's copy exactly as the server has it:
			// the edit is gone from the top, and the rows it touched are read
			// again rather than trusted.
			for (const trip of touched) await pullTrip(trip).catch(() => {});
		} while (again);
		sending = null;
	})();
}

// --- Receiving -------------------------------------------------------------

/** Realtime events held while a pull is replacing the rows they would change. */
let pulling = 0;
let held_: Parameters<typeof received>[] = [];

/** Rows from the server replace what the device held for them, in one write. */
async function replace(scope: (t: IDBTransaction) => Promise<void>, rows: Held[]) {
	await tx(['rows'], 'readwrite', async (t) => {
		await scope(t);
		const s = t.objectStore('rows');
		for (const h of rows) s.put(h);
	});
}

async function pull(work: () => Promise<void>) {
	pulling++;
	try {
		await navigator.locks.request(SYNC_LOCK, work);
	} finally {
		pulling--;
		if (!pulling) {
			const later = held_;
			held_ = [];
			for (const args of later) await received(...args);
		}
		await load();
		announce('synced');
	}
}

const must = <T>(r: { data: T | null; error: { message: string } | null }): T => {
	if (r.error) throw new Error(r.error.message);
	return r.data as T;
};

/** The trips this account can see, for the list. */
export function pullTrips(): Promise<void> {
	return pull(async () => {
		// Asked, whether or not an answer comes: offline, the list is what
		// the device holds.
		store.listed = true;
		const trips = must(await supabase.from('trips').select('*')) as Row[];
		const seen = new Set(trips.map((t) => t.id as string));
		await replace(async (t) => {
			const s = t.objectStore('rows');
			const all = (await req(s.getAll() as IDBRequest<Held[]>)).filter((h) => h.table === 'trips');
			for (const h of all) {
				if (seen.has(h.trip!)) continue;
				// Deleted, or this account is no longer on it.
				await eachOfTrip(t, h.trip!, (c) => c.delete());
			}
		}, trips.map((r) => held('trips', r)));
	});
}

/** Everything about one trip, as the server holds it now. */
export function pullTrip(id: string): Promise<void> {
	return pull(async () => {
		if (!store.asked.includes(id)) store.asked.push(id);
		const [trip, pois, placements, meals, plan, members] = await Promise.all([
			supabase.from('trips').select('*').eq('id', id).maybeSingle(),
			supabase.from('pois').select('*').eq('trip_id', id),
			supabase.from('placements').select('*').eq('trip_id', id),
			supabase.from('trip_meals').select('*').eq('trip_id', id),
			supabase.from('plan_stops').select('*').eq('trip_id', id),
			supabase.from('trip_members').select('*').eq('trip_id', id)
		]);
		const people = (must(members) as Row[]).map((m) => m.user_id as string);
		const profiles = people.length
			? (must(await supabase.from('profiles').select('*').in('user_id', people)) as Row[])
			: [];
		const found = must(trip) as Row | null;
		const rows = found
			? [
					held('trips', found),
					...(must(pois) as Row[]).map((r) => held('pois', r)),
					...(must(placements) as Row[]).map((r) => held('placements', r)),
					...(must(meals) as Row[]).map((r) => held('trip_meals', r)),
					...(must(plan) as Row[]).map((r) => held('plan_stops', r)),
					...(must(members) as Row[]).map((r) => held('trip_members', r)),
					...profiles.map((r) => held('profiles', r))
				]
			: [];
		await replace((t) => eachOfTrip(t, id, (c) => c.delete()), rows);
	});
}

/** The signed-in traveller's own profile. */
export function pullProfile(userId: string): Promise<void> {
	return pull(async () => {
		const mine = must(
			await supabase.from('profiles').select('*').eq('user_id', userId).maybeSingle()
		) as Row | null;
		await replace(async () => {}, mine ? [held('profiles', mine)] : []);
	});
}

/**
 * Redraw once for a burst of changes, not once per row.
 *
 * A move re-times the day, and the server's copy of it comes back over
 * realtime as a row per card -- twenty in a second. Redrawing the trip for
 * each of them froze a phone for seconds after every drop.
 */
let redrawing: ReturnType<typeof setTimeout> | null = null;
function redrawSoon() {
	redrawing ??= setTimeout(() => {
		redrawing = null;
		bump();
		announce('synced');
	}, 100);
}

/**
 * A row another traveller -- or the refiner, or this device's own edit coming
 * back -- changed on the server. Laid into the confirmed rows like any other
 * write, in memory and on the device together; the device is not read back.
 *
 * News already had is dropped: a version no newer than the one held is this
 * device's own edit coming back, or older than it. The trip's row is the
 * exception at an equal version -- saving the plan stamps it without counting
 * as a change -- and the plan's rows carry no version, so they always land.
 */
async function received(table: Table, event: string, fresh: Row | null, old: Row | null) {
	if (pulling) {
		held_.push([table, event, fresh, old]);
		return;
	}
	if (event === 'DELETE') {
		// A deleted row arrives as its primary key only. Meals are known by
		// their day and sitting here, so they are found by id.
		const id =
			table === 'trip_meals'
				? [...confirmed.values()].find((h) => h.table === table && h.row.id === old?.id)?.id
				: old && rowId(table, keyOf(table, old));
		if (!id || !confirmed.has(id)) return;
		await tx(['rows'], 'readwrite', (t) => void t.objectStore('rows').delete(id));
		confirmed.delete(id);
		redrawSoon();
		return;
	}
	if (!fresh) return;
	const h = held(table, fresh);
	const had = confirmed.get(h.id)?.row.version as number | undefined;
	if (had !== undefined && fresh.version !== undefined) {
		const version = fresh.version as number;
		if (version < had || (version === had && table !== 'trips')) return;
	}
	await tx(['rows'], 'readwrite', (t) => void t.objectStore('rows').put(h));
	confirmed.set(h.id, h);
	redrawSoon();
}

const LIVE: Table[] = ['trips', 'pois', 'placements', 'trip_meals', 'plan_stops', 'trip_members', 'profiles'];

/**
 * Keep one trip current while it is open: read it once, then take every
 * change to it as it happens. Returns the way to stop.
 */
export function watchTrip(id: string): () => void {
	const ch = supabase.channel(`trip:${id}`);
	for (const table of LIVE) {
		ch.on(
			'postgres_changes',
			{
				event: '*',
				schema: 'public',
				table,
				...(table === 'profiles' ? {} : { filter: table === 'trips' ? `id=eq.${id}` : `trip_id=eq.${id}` })
			},
			(p) => void received(table, p.eventType, (p.new as Row) ?? null, (p.old as Row) ?? null)
		);
	}
	// Subscribed, or subscribed again after the connection came back: what
	// happened while nobody was listening is read in one go.
	ch.subscribe((status) => {
		if (status === 'SUBSCRIBED') {
			void pullTrip(id).catch(() => {});
			send();
		}
	});
	return () => void supabase.removeChannel(ch);
}

// --- Conflicts ---------------------------------------------------------------

/**
 * Keep the put-aside edit: it is made again, against the rows as they are
 * upstream now, and overwrites what it touches -- through the writer, like
 * any other edit, so it is versioned and lands whole in the same way.
 *
 * Not the plan it carried: that was drawn from the trip as it was when the
 * edit was made, and the trip has moved on since -- a card it names may be
 * gone. `follow` is what follows from keeping it (the screen passes its
 * re-time), written into the same edit, so the change and the day re-timed
 * around it land together or not at all.
 *
 * The put-aside edit is taken off the device only once the new one is safely
 * on it: a failure in between leaves the choice still waiting, not lost.
 */
export async function accept(m: Mutation, follow?: (w: Writer) => void): Promise<void> {
	await mutate(m.name, m.trip, (w) => {
		for (const op of m.ops) {
			if (op.op === 'plan') continue;
			const now = confirmed.get(rowId(op.table, op.key))?.row;
			if (op.op === 'insert') {
				if (!now) w.insert(op.table, op.values);
				else {
					const { id: _i, created_at: _c, ...values } = op.values;
					w.update(op.table, op.key, values);
				}
			} else if (op.op === 'update') {
				if (now) w.update(op.table, op.key, op.values);
				else w.insert(op.table, { ...op.before, ...op.values });
			} else if (now) {
				w.remove(op.table, op.key);
			}
		}
		follow?.(w);
	});
	await tx(['queue'], 'readwrite', (t) => void t.objectStore('queue').delete(m.seq!));
	queue = queue.filter((x) => x.seq !== m.seq);
}

/** Keep upstream: the put-aside edit is dropped, and the row is what the trip says. */
export async function reject(m: Mutation): Promise<void> {
	await tx(['queue'], 'readwrite', (t) => void t.objectStore('queue').delete(m.seq!));
	queue = queue.filter((x) => x.seq !== m.seq);
	announce('synced');
}

// --- Online only -------------------------------------------------------------

/**
 * A shared trip, read through the RPC rather than the table: whoever holds a
 * link may look at it without being on it, so it is not this account's to
 * keep on the device.
 */
export async function sharedTrip(token: string) {
	const { data, error } = await supabase.rpc('get_shared_trip', { token });
	if (error) throw new Error(error.message);
	return data as { trip: Row; pois: Row[]; plan: Row[] } | null;
}

/**
 * Join a trip using a share link. Returns the trip id, or null when the token
 * is unknown or revoked. Membership is granted by the function rather than
 * by an insert, because a client that could insert its own membership would
 * not need a token.
 */
export async function joinTrip(token: string): Promise<string | null> {
	const { data, error } = await supabase.rpc('join_trip', { token });
	if (error) throw new Error(error.message);
	const id = (data as string | null) ?? null;
	if (id) await pullTrip(id);
	return id;
}

/**
 * The development trail (telemetry.ts): written straight to the server, not
 * queued. It is not the traveller's data, and a trail that waited for a
 * connection would only be a longer trail nobody asked for. A failure is
 * dropped -- the trail is not worth a retry storm.
 */
export async function sendEvents(batch: object[]): Promise<void> {
	try {
		await supabase.from('events').insert(batch);
	} catch {
		// What is lost is lost.
	}
}

/** A picture, uploaded; returns where it can be read from. Needs a connection. */
export async function upload(bucket: 'trip-images' | 'avatars', path: string, file: File): Promise<string> {
	const { error } = await supabase.storage.from(bucket).upload(path, file, { upsert: true, contentType: file.type });
	if (error) throw new Error(error.message);
	return supabase.storage.from(bucket).getPublicUrl(path).data.publicUrl;
}
