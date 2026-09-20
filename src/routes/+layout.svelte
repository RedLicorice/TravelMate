<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { base } from '$app/paths';
	import { session, watchSession } from '$lib/session.svelte';
	import { redirectTarget } from '$lib/guard';
	import { registerSW } from 'virtual:pwa-register';

	let { children } = $props();

	onMount(() => {
		// autoUpdate: a traveller should never be asked to approve a refresh of
		// a trip planner. Registered here because the static fallback page gets
		// no build-time injection.
		registerSW({ immediate: true });
		return watchSession();
	});

	$effect(() => {
		if (!session.ready) return;
		const target = redirectTarget(page.url.pathname, !!session.user, base);
		if (target) goto(base + target, { replaceState: true });
	});
</script>

{#if session.ready}
	{@render children()}
{:else}
	<div class="grid min-h-dvh place-items-center" style="color: var(--tm-text-faint)">Loading…</div>
{/if}
