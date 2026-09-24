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
	import { mutate, pullProfile, pullTrips, send } from '$lib/store/store.svelte';
	import { ensureMyProfile, myProfile, saveMyProfile } from '$lib/profile.svelte';
	import { choose, consent } from '$lib/consent.svelte';

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
		// The current version, whenever the app is opened or comes back.
		//
		// A new version takes over as soon as it is installed (sw.ts). This
		// page then moves onto it at a moment that interrupts nothing: at once
		// while the app is still opening or out of sight, otherwise the next
		// time it goes out of sight or comes back -- never under a finger
		// halfway through something. What was done offline is in the device
		// database, and survives the reload.
		const opened = Date.now();
		const OPENING_MS = 10_000;
		let registration: ServiceWorkerRegistration | undefined;
		registerSW({
			immediate: true,
			onRegisteredSW: (_url, r) => (registration = r)
		});
		const sw = 'serviceWorker' in navigator ? navigator.serviceWorker : null;
		// The first install takes the page too, but that is not a new version.
		const hadVersion = !!sw?.controller;
		let reloadWhenQuiet = false;
		const onNewVersion = () => {
			if (!hadVersion) return;
			if (document.visibilityState === 'hidden' || Date.now() - opened < OPENING_MS) location.reload();
			else reloadWhenQuiet = true;
		};
		const onVisibility = () => {
			if (reloadWhenQuiet) location.reload();
			else if (document.visibilityState === 'visible') void registration?.update().catch(() => {});
		};
		// A page still on the old version asking for a piece of code the new
		// deploy no longer has: reload onto the version that has it.
		const onStale = () => location.reload();
		sw?.addEventListener('controllerchange', onNewVersion);
		document.addEventListener('visibilitychange', onVisibility);
		window.addEventListener('vite:preloadError', onStale);
		const stopWatching = watchSession();
		const stopListening = watchForFaults();
		return () => {
			stopWatching();
			stopListening();
			sw?.removeEventListener('controllerchange', onNewVersion);
			document.removeEventListener('visibilitychange', onVisibility);
			window.removeEventListener('vite:preloadError', onStale);
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

	// The diagnostics choice lives on the profile once there is one. A choice
	// made on this device before signing in is written to it; after that the
	// device follows the profile, so a choice made on the laptop holds on the
	// phone too.
	$effect(() => {
		const mine = myProfile();
		if (!session.user || !mine) return;
		const here = consent.choice?.telemetry;
		untrack(() => {
			if (mine.telemetry !== null) {
				if (here !== mine.telemetry) choose(mine.telemetry);
			} else if (here !== undefined) {
				void mutate('Said whether to send diagnostics', null, (w) => saveMyProfile(w, { telemetry: here })).catch(() => {});
			}
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
