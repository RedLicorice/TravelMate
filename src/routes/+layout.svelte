<script lang="ts">
	import '../app.css';
	import { onMount, untrack } from 'svelte';
	import { goto, onNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import { base } from '$app/paths';
	import { session, takeNext, watchSession } from '$lib/session.svelte';
	import { redirectTarget, safeNext } from '$lib/guard';
	import { registerSW } from 'virtual:pwa-register';
	import { watchForFaults } from '$lib/telemetry';
	import { pullProfile, pullTrips, send } from '$lib/store/store.svelte';
	import { ensureMyProfile } from '$lib/profile.svelte';

	let { children } = $props();

	/**
	 * One screen giving way to the next.
	 *
	 * The browser's own view transition, which cross-fades the old page into
	 * the new one without either of them having to know about the other. Where
	 * it is not supported -- or where the traveller has asked for less motion,
	 * which the stylesheet honours -- navigation is what it always was.
	 */
	onNavigate((navigation) => {
		// Nor for a page nobody is looking at, where the browser aborts the
		// transition and says so as an error.
		if (!document.startViewTransition || document.visibilityState !== 'visible') return;
		return new Promise((resolve) => {
			document.startViewTransition(async () => {
				resolve();
				await navigation.complete;
			});
		});
	});

	onMount(() => {
		// Opening the app online gets the current version of it.
		//
		// The check takes a moment, so "opening" is a short window rather than
		// an instant -- long enough for the worker to answer on a slow
		// connection, short enough that the traveller is still looking at the
		// screen they opened rather than working in it. A new version found
		// inside that window is taken at once; one that turns up later is not
		// imposed on a page in use, and is taken the next time the app opens.
		// Registered here because the static fallback page gets no build-time
		// injection.
		const opened = Date.now();
		const OPENING_MS = 10_000;
		const update = registerSW({
			immediate: true,
			onNeedRefresh() {
				if (Date.now() - opened < OPENING_MS) void update(true);
			}
		});
		const stopWatching = watchSession();
		const stopListening = watchForFaults();
		return () => {
			stopWatching();
			stopListening();
		};
	});

	// Signed in with a connection: what the server has comes down, and what
	// this device did offline goes up. Without one, nothing waits on either.
	$effect(() => {
		const id = session.user?.id;
		if (!id) return;
		untrack(() => {
			send();
			pullTrips().catch(() => {});
			pullProfile(id)
				.then(ensureMyProfile)
				.catch(() => {});
		});
	});

	$effect(() => {
		if (!session.ready) return;
		const target = redirectTarget(page.url.pathname, !!session.user, base);
		if (!target) {
			// Back from a provider or a confirmation link, which come back to the
			// front door: the page they were heading for was kept on the device
			// rather than sent round the internet in ?next=.
			const kept = session.user ? takeNext() : null;
			if (kept && base + kept !== page.url.pathname) goto(base + kept, { replaceState: true });
			return;
		}
		// Someone already signed in who lands on /login?next=... wanted the page
		// in `next`, not the trip list.
		const intended = target === '/' ? (safeNext(page.url.searchParams.get('next')) ?? '/') : target;
		goto(base + intended, { replaceState: true });
	});
</script>

<!-- The app is drawn straight away, signed in or not.
     It used to wait behind a "Loading..." card until the session came back,
     which on a phone that has the app installed is a blank screen in front of
     a trip the device already has -- and, when anything threw while the
     session was resolving, a blank screen for good. Each page says what it is
     waiting for; the shell does not wait on their behalf. -->
{@render children()}
