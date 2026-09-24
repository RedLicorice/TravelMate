/**
 * Sending the queue.
 *
 * Shared by the page and the service worker -- the page sends when it can,
 * Background Sync sends when the page is gone -- so, like idb.ts, nothing here
 * may reach for the page.
 *
 * Edits go up one at a time, in the order they were made, each as a whole:
 * the server applies every row write in it or none. An edit comes back one of
 * three ways:
 *
 *   applied   its rows are now what the server holds; later edits to the same
 *             rows are re-based onto the versions it produced
 *   aside     a row it touches has moved on since the edit was made. Not
 *             applied, not retried, not thrown away: it waits on the device
 *             for the traveller to accept or reject it
 *   refused   the server will not take it (a viewer's edit, say). Never
 *             sent again and never drawn, but kept -- with the reason --
 *             until the traveller has been told, even when it was the
 *             worker that sent it and no screen was open
 *
 * Anything else -- no signal, a server having a moment, a session to refresh
 * -- stops the drain with the queue as it was, to be tried again.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { req, tx } from './idb';

export const SYNC_TAG = 'tm-sync';
/** Held while sending or pulling, by whichever tab or worker is doing it. */
export const SYNC_LOCK = 'tm-sync';
/** Where the page and the worker tell each other the device database moved. */
export const CHANNEL = 'tm-store';

export type Table =
	| 'trips'
	| 'pois'
	| 'placements'
	| 'trip_members'
	| 'profiles'
	| 'plan_stops';

export type Row = Record<string, unknown>;
export type Key = Record<string, unknown>;

export type RowOp =
	| { op: 'insert'; table: Table; key: Key; lock: string; base: null; values: Row }
	| {
			op: 'update';
			table: Table;
			key: Key;
			lock: string;
			base: number | null;
			values: Row;
			/** The row as it read when the edit was made. Shown in a conflict. */
			before: Row;
	  }
	| { op: 'delete'; table: Table; key: Key; lock: string; base: number | null; before: Row };

export type PlanOp = {
	op: 'plan';
	trip: string;
	rows: Row[];
	planner_version: number;
	generated_at: string;
	/** The days this plan is for; the other days' stops are left as they are. Absent: every day. */
	days?: number[];
};

export type Op = RowOp | PlanOp;

export type Mutation = {
	/** Queue position. Assigned by the device database. */
	seq?: number;
	/** The edit's own id, which is what makes sending it twice harmless. */
	id: string;
	/** What the traveller did, in their words. */
	name: string;
	trip: string | null;
	at: string;
	ops: Op[];
	state: 'queued' | 'aside' | 'refused';
	/** Set when put aside: which ops met a row that had moved on, and what it is now. */
	conflicts?: { index: number; upstream: Row | null }[];
	/** Set when refused: why, in the traveller's terms. */
	reason?: string;
};

/** What a stored row is called in the rows store. */
export const keyOf = (table: Table, row: Row): Key =>
	table === 'trip_members'
		? { trip_id: row.trip_id, user_id: row.user_id }
		: table === 'profiles'
			? { user_id: row.user_id }
			: { id: row.id };

export const rowId = (table: Table, key: Key) => `${table}:${Object.values(key).join(':')}`;

/** Which trip a row belongs to. A profile belongs to a person, not a trip. */
export const tripOf = (table: Table, row: Row): string | null =>
	table === 'trips' ? (row.id as string) : table === 'profiles' ? null : (row.trip_id as string);

export type Held = { id: string; table: Table; trip: string | null; row: Row };

export const held = (table: Table, row: Row): Held => ({
	id: rowId(table, keyOf(table, row)),
	table,
	trip: tripOf(table, row),
	row
});

export type Outcome =
	| { kind: 'applied'; mutation: Mutation }
	| { kind: 'aside'; mutation: Mutation }
	| { kind: 'refused'; mutation: Mutation; message: string };

/** Every row the device holds for a trip, by cursor, inside a transaction. */
export function eachOfTrip(t: IDBTransaction, trip: string, visit: (c: IDBCursorWithValue) => void) {
	return new Promise<void>((resolve, reject) => {
		const r = t.objectStore('rows').index('trip').openCursor(IDBKeyRange.only(trip));
		r.onsuccess = () => {
			const c = r.result;
			if (!c) return resolve();
			visit(c);
			c.continue();
		};
		r.onerror = () => reject(r.error);
	});
}

const wire = (op: Op) =>
	op.op === 'plan'
		? op
		: { table: op.table, op: op.op, key: op.key, base: op.base, lock: op.lock, ...('values' in op ? { values: op.values } : {}) };

/** No signal, or a server that will be back: try again later, queue untouched. */
const retryable = (status: number, code?: string) =>
	!status || status >= 500 || status === 401 || status === 408 || status === 429 || code?.startsWith('PGRST3');

const sameKey = (a: Op, b: Op) =>
	a.op !== 'plan' && b.op !== 'plan' && a.table === b.table && rowId(a.table, a.key) === rowId(b.table, b.key);

/**
 * How long one request to the server may take while the sync lock is held.
 * A request that hangs -- a signal that is there and carries nothing -- would
 * otherwise hold the lock, and everything waiting on it, for as long as it
 * hangs. Past this it is given up, the queue stays as it was, and it is tried
 * again later.
 */
export const REQUEST_MS = 15_000;

/**
 * Send everything queued. Resolves 'done' when nothing queued is left, or
 * 'stopped' when the rest cannot be sent now -- no signal, a server having a
 * moment -- and has to be tried again later.
 */
export async function drain(
	server: SupabaseClient,
	told: (o: Outcome) => void
): Promise<'done' | 'stopped'> {
	return navigator.locks.request(SYNC_LOCK, async (): Promise<'done' | 'stopped'> => {
		for (;;) {
			const queue = await tx(['queue'], 'readonly', (t) =>
				req(t.objectStore('queue').getAll() as IDBRequest<Mutation[]>)
			);
			const next = queue.find((m) => m.state === 'queued');
			if (!next) return 'done';

			// An edit to a row that never reached the server: the edit that
			// created it was refused, or is waiting on the traveller.
			const orphan = next.ops.find((o) => o.op !== 'plan' && o.op !== 'insert' && o.base === null);
			if (orphan) {
				const waiting = queue.some(
					(m) => m.state === 'aside' && m.ops.some((o) => o.op === 'insert' && sameKey(o, orphan))
				);
				if (waiting) {
					await putAside(next, [{ index: next.ops.indexOf(orphan), upstream: null }]);
					told({ kind: 'aside', mutation: next });
				} else {
					const reason = `“${next.name}” was about something the trip never received.`;
					await refuse(next, reason);
					told({ kind: 'refused', mutation: next, message: reason });
				}
				continue;
			}

			const { data, error, status } = await server
				.rpc('apply_mutation', { mutation: next.id, ops: next.ops.map(wire) })
				.abortSignal(AbortSignal.timeout(REQUEST_MS));
			if (error) {
				// Given up, or cut short: the edit id makes sending it again
				// harmless even if the server did apply it.
				if (retryable(status, error.code)) return 'stopped';
				const reason = refusal(next, error.message);
				await refuse(next, reason);
				told({ kind: 'refused', mutation: next, message: reason });
				continue;
			}
			const answer = data as
				| { status: 'applied'; rows: (Row | null)[] }
				| { status: 'conflict'; conflicts: { index: number; upstream: Row | null }[] };
			if (answer.status === 'applied') {
				await applied(next, answer.rows);
				told({ kind: 'applied', mutation: next });
				// The plan's journeys are guesses until the server has routed
				// them; it writes the answers onto the stops, and they come back
				// over realtime. Not waited on.
				const plan = next.ops.find((o): o is PlanOp => o.op === 'plan');
				// Journeys are turned off for now: nothing to route.
				// if (plan) void server.functions.invoke('refine', { body: { tripId: plan.trip } }).catch(() => {});
				void plan;
			} else {
				await putAside(next, answer.conflicts);
				told({ kind: 'aside', mutation: { ...next, conflicts: answer.conflicts } });
			}
		}
	});
}

/** A refusal in the traveller's terms. The server's own words follow. */
const refusal = (m: Mutation, message: string) =>
	/row-level security|may not be|permission/i.test(message)
		? `“${m.name}” was not saved: you can look at this trip but not change it.`
		: `“${m.name}” was not saved: ${message}`;

async function refuse(m: Mutation, reason: string) {
	await tx(['queue'], 'readwrite', (t) => void t.objectStore('queue').put({ ...m, state: 'refused', reason }));
}

/** Upstream goes into the rows; the edit waits beside them, unsent. */
async function putAside(m: Mutation, conflicts: Mutation['conflicts'] & {}) {
	await tx(['rows', 'queue'], 'readwrite', (t) => {
		const rows = t.objectStore('rows');
		for (const c of conflicts) {
			const op = m.ops[c.index];
			if (op.op === 'plan') continue;
			if (c.upstream) rows.put(held(op.table, c.upstream));
			else rows.delete(rowId(op.table, op.key));
		}
		t.objectStore('queue').put({ ...m, state: 'aside', conflicts });
	});
}

/**
 * The server holds these rows now. Written as it answered, and every later
 * edit to the same rows is moved onto the version this one produced -- they
 * were made on top of it, on this device, and are not in conflict with it.
 */
async function applied(m: Mutation, written: (Row | null)[]) {
	await tx(['rows', 'queue'], 'readwrite', async (t) => {
		const rows = t.objectStore('rows');
		const queue = t.objectStore('queue');
		const later = (await req(queue.getAll() as IDBRequest<Mutation[]>)).filter(
			(x) => x.seq! > m.seq!
		);

		for (const [i, op] of m.ops.entries()) {
			if (op.op === 'plan') {
				await eachOfTrip(t, op.trip, (c) => {
					const h = c.value as Held;
					if (h.table === 'plan_stops' && (!op.days || op.days.includes(h.row.day_index as number))) c.delete();
				});
				for (const r of op.rows) rows.put(held('plan_stops', { ...r, trip_id: op.trip }));
				continue;
			}
			const row = written[i];
			if (op.op === 'delete') {
				rows.delete(rowId(op.table, op.key));
				if (op.table === 'trips') await eachOfTrip(t, op.key.id as string, (c) => c.delete());
			} else if (row) {
				rows.put(held(op.table, row));
			}
			const version = row ? (row.version as number) : null;
			for (const x of later) {
				for (const o of x.ops) {
					if (o.op !== 'plan' && o.op !== 'insert' && sameKey(o, op) && o.base === op.base) {
						o.base = version;
					}
				}
			}
		}
		queue.delete(m.seq!);
		for (const x of later) queue.put(x);
	});
}
