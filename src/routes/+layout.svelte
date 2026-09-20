<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { base } from '$app/paths';
	import { session, watchSession } from '$lib/session.svelte';
	import { redirectTarget } from '$lib/guard';

	let { children } = $props();

	onMount(() => watchSession());

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
