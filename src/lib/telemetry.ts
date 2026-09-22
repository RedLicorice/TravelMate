import { supabase } from './supabase';

/**
 * What the app did, written down as it happens.
 *
 * Exists so a fault can be read out of the database instead of reconstructed
 * from a description. Nothing here may get in the way of what the traveller
 * is doing: events are queued, flushed on a timer, and every failure is
 * swallowed -- a broken trail is a nuisance, a broken trip is not.
 */
type Event = { name: string; detail: Record<string, unknown>; trip_id: string | null; at: string };

const queue: Event[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
/** The trip being looked at, so every event does not have to say. */
let current: string | null = null;

export function watching(tripId: string | null) {
	current = tripId;
}

/** How long a batch waits for company. Long enough to gather a burst. */
const FLUSH_MS = 2000;

async function flush() {
	timer = null;
	const batch = queue.splice(0, queue.length);
	if (!batch.length) return;
	try {
		await supabase.from('events').insert(batch);
	} catch {
		// The trail is not worth a retry storm. What is lost is lost.
	}
}

export function track(name: string, detail: Record<string, unknown> = {}) {
	queue.push({ name, detail, trip_id: current, at: new Date().toISOString() });
	// A burst -- a search, a drag, a replan -- goes as one insert.
	if (!timer) timer = setTimeout(flush, FLUSH_MS);
	// Never let the queue grow without bound if the tab is offline for hours.
	if (queue.length > 200) queue.splice(0, queue.length - 200);
}

/** How long something took, without every caller keeping its own clock. */
export function timed<T>(name: string, run: () => Promise<T>, detail: Record<string, unknown> = {}) {
	const started = performance.now();
	return run().then(
		(value) => {
			track(name, { ...detail, ms: Math.round(performance.now() - started), ok: true });
			return value;
		},
		(error: unknown) => {
			track(name, {
				...detail,
				ms: Math.round(performance.now() - started),
				ok: false,
				error: String((error as Error)?.message ?? error).slice(0, 300)
			});
			throw error;
		}
	);
}

/**
 * Anything that threw where nobody caught it.
 *
 * A blank screen with a stack in a console nobody is looking at is the fault
 * that takes longest to find; this is that stack, in the database.
 */
export function watchForFaults() {
	if (typeof window === 'undefined') return () => {};
	const onError = (e: ErrorEvent) =>
		track('error', {
			message: String(e.message).slice(0, 300),
			at: `${e.filename}:${e.lineno}`,
			stack: String(e.error?.stack ?? '').slice(0, 900)
		});
	const onRejection = (e: PromiseRejectionEvent) =>
		track('error.unhandled', {
			message: String((e.reason as Error)?.message ?? e.reason).slice(0, 300),
			stack: String((e.reason as Error)?.stack ?? '').slice(0, 900)
		});
	window.addEventListener('error', onError);
	window.addEventListener('unhandledrejection', onRejection);
	// A tab being closed is the commonest way a trail ends mid-thought.
	const onHide = () => {
		if (document.visibilityState === 'hidden') void flush();
	};
	document.addEventListener('visibilitychange', onHide);
	return () => {
		window.removeEventListener('error', onError);
		window.removeEventListener('unhandledrejection', onRejection);
		document.removeEventListener('visibilitychange', onHide);
	};
}
