/**
 * The device's own database.
 *
 * Read by the page and by the service worker, which is why nothing here may
 * reach for the page: no window, no localStorage (except to move a session
 * out of it), no Svelte state.
 *
 *   rows   every row this device holds, as the server last confirmed it
 *   queue  edits not yet accepted by the server, oldest first
 *   auth   the signed-in session, where the worker can read it too
 */
const NAME = 'travelmate';
/** 2: rows are indexed by table too, so the trip list is read without every trip. */
const VERSION = 2;

let opened: Promise<IDBDatabase> | null = null;

export function db(): Promise<IDBDatabase> {
	opened ??= new Promise((resolve, reject) => {
		const req = indexedDB.open(NAME, VERSION);
		req.onupgradeneeded = (e) => {
			const d = req.result;
			if (e.oldVersion < 1) {
				d.createObjectStore('rows', { keyPath: 'id' }).createIndex('trip', 'trip');
				d.createObjectStore('queue', { keyPath: 'seq', autoIncrement: true });
				d.createObjectStore('auth');
			}
			if (e.oldVersion < 2) req.transaction!.objectStore('rows').createIndex('table', 'table');
		};
		req.onsuccess = () => {
			// Another tab opening a newer version of the app needs this one to
			// let go, or its upgrade waits for ever.
			req.result.onversionchange = () => {
				req.result.close();
				opened = null;
			};
			resolve(req.result);
		};
		req.onerror = () => {
			opened = null;
			reject(req.error);
		};
	});
	return opened;
}

type Store = 'rows' | 'queue' | 'auth';

/**
 * One transaction: everything `work` does lands together or not at all.
 *
 * `work` must only issue requests on the stores it was given -- awaiting
 * anything else in between lets IndexedDB commit early.
 */
export async function tx<T>(
	stores: Store[],
	mode: IDBTransactionMode,
	work: (t: IDBTransaction) => T | Promise<T>
): Promise<T> {
	const t = (await db()).transaction(stores, mode);
	const done = new Promise<void>((resolve, reject) => {
		t.oncomplete = () => resolve();
		t.onerror = () => reject(t.error);
		t.onabort = () => reject(t.error ?? new Error('The device database refused the write.'));
	});
	let result: T;
	try {
		result = await work(t);
	} catch (e) {
		try {
			t.abort();
		} catch {
			// Already finished on its own; the error below is the one to report.
		}
		throw e;
	}
	await done;
	return result;
}

/** A request as a promise. */
export const req = <T>(r: IDBRequest<T>): Promise<T> =>
	new Promise((resolve, reject) => {
		r.onsuccess = () => resolve(r.result);
		r.onerror = () => reject(r.error);
	});

/**
 * Wipe the trips this device holds, for an account that is leaving it. Not
 * the session: that belongs to whoever is signing in, and supabase-js
 * removes its own on sign-out.
 */
export const forget = () =>
	tx(['rows', 'queue'], 'readwrite', (t) => {
		t.objectStore('rows').clear();
		t.objectStore('queue').clear();
	});

/**
 * Where supabase-js keeps the session.
 *
 * In IndexedDB rather than localStorage because the worker has no
 * localStorage, and the worker is what sends queued edits once the tab is
 * gone. A session found in localStorage -- signed in before this -- is moved
 * across on first read, so updating the app does not sign anybody out.
 */
export const authStorage = {
	async getItem(key: string): Promise<string | null> {
		const kept = await tx(['auth'], 'readonly', (t) =>
			req(t.objectStore('auth').get(key) as IDBRequest<string | undefined>)
		);
		if (kept !== undefined) return kept;
		const legacy = typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
		if (legacy === null) return null;
		await authStorage.setItem(key, legacy);
		localStorage.removeItem(key);
		return legacy;
	},
	setItem: (key: string, value: string) =>
		tx(['auth'], 'readwrite', (t) => void t.objectStore('auth').put(value, key)),
	removeItem: (key: string) =>
		tx(['auth'], 'readwrite', (t) => void t.objectStore('auth').delete(key))
};
