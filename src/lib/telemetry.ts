import { sendEvents } from './store/store.svelte';

/**
 * What the app did, written down as it happens.
 *
 * Exists so a fault can be read out of the database instead of reconstructed
 * from a description. Nothing here may get in the way of what the traveller
 * is doing: events are queued, flushed on a timer, and every failure is
 * swallowed -- a broken trail is a nuisance, a broken trip is not.
 */
type Event = { name: string; detail: Record<string, unknown>; trip_id: string | null; at: string };

/**
 * Whether this copy of the app is one whose trail anyone will read.
 *
 * The trail is a development aid, not a product feature: it exists for the
 * owner debugging on the tailnet or a laptop. The public site on GitHub
 * Pages must not spend a traveller's bandwidth or the events table on it, so
 * everything below is inert unless the page was served from one of those.
 * During prerendering there is no location at all, and no trail.
 */
export function servedForDebugging(): boolean {
	if (typeof location === 'undefined') return false;
	const host = location.hostname;
	return host.endsWith('.ts.net') || host === 'localhost' || host === '127.0.0.1';
}
const on = servedForDebugging();

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
	await sendEvents(batch);
}

export function track(name: string, detail: Record<string, unknown> = {}) {
	if (!on) return;
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
	if (!on || typeof window === 'undefined') return () => {};
	const restoreConsole = recordConsole();
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
		restoreConsole();
	};
}

/** A console argument as one readable line, however it was passed. */
function describe(arg: unknown): string {
	if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
	if (typeof arg === 'string') return arg;
	try {
		return JSON.stringify(arg) ?? String(arg);
	} catch {
		return String(arg);
	}
}

/**
 * The first line of the stack that names code. V8 puts "Name: message" on the
 * first line and frames after; Firefox starts straight in on the frames.
 */
function firstFrame(args: unknown[]): string | undefined {
	const error = args.find((a): a is Error => a instanceof Error);
	const lines = (error?.stack ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
	if (!lines.length) return undefined;
	return lines[lines[0].includes(error!.message) ? 1 : 0];
}

/**
 * Everything the app says to the console, said to the trail as well.
 *
 * Most of what goes wrong on a phone is a warning nobody had the devtools
 * open to see. The original console is always called first, so nothing is
 * ever lost to the wrapper; and the recorder never itself logs, so a fault
 * in it cannot loop back through the console it is wrapping.
 */
function recordConsole() {
	const levels = ['error', 'warn', 'log'] as const;
	const originals = { error: console.error, warn: console.warn, log: console.log };
	let recording = false;
	for (const level of levels) {
		console[level] = (...args: unknown[]) => {
			originals[level].apply(console, args);
			if (recording) return;
			recording = true;
			try {
				track('console', {
					level,
					message: args.map(describe).join(' ').slice(0, 500),
					frame: firstFrame(args)
				});
			} catch {
				// A trail that cannot be written is not worth a word in the console.
			} finally {
				recording = false;
			}
		};
	}
	return () => {
		for (const level of levels) console[level] = originals[level];
	};
}
