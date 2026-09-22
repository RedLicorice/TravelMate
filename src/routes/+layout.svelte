<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import { goto, onNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import { base } from '$app/paths';
	import { session, takeNext, watchSession } from '$lib/session.svelte';
	import { redirectTarget, safeNext } from '$lib/guard';
	import { registerSW } from 'virtual:pwa-register';
	import { watchForFaults } from '$lib/telemetry';

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
		if (!document.startViewTransition) return;
		return new Promise((resolve) => {
			document.startViewTransition(async () => {
				resolve();
				await navigation.complete;
			});
		});
	});

	onMount(() => {
		// autoUpdate: a traveller should never be asked to approve a refresh of
		// a trip planner. Registered here because the static fallback page gets
		// no build-time injection.
		registerSW({ immediate: true });
		const stopWatching = watchSession();
		const stopListening = watchForFaults();
		return () => {
			stopWatching();
			stopListening();
		};
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
