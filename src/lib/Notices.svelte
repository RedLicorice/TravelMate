<script lang="ts">
	import { dismiss, notices, refused, seen } from '$lib/store/store.svelte';

	/** Only what concerns this trip, on a trip's screen. Everything, elsewhere. */
	let { trip = undefined }: { trip?: string } = $props();

	const mine = $derived(refused().filter((m) => trip === undefined || m.trip === trip || m.trip === null));
</script>

<!-- What the server would not take, and what another window did. Said until
     the traveller has read it: a refusal is never swallowed. -->
{#each mine as m (m.seq)}
	<p class="tm-hint tm-hint--error" style="display:flex;gap:8px;align-items:flex-start">
		<span style="flex:1">{m.reason}</span>
		<button class="tm-btn tm-btn--ghost" style="min-height:auto;padding:0 4px" aria-label="Dismiss" onclick={() => seen(m)}>✕</button>
	</p>
{/each}
{#each notices as n (n.id)}
	<p class="tm-hint" style="display:flex;gap:8px;align-items:flex-start">
		<span style="flex:1">{n.text}</span>
		<button class="tm-btn tm-btn--ghost" style="min-height:auto;padding:0 4px" aria-label="Dismiss" onclick={() => dismiss(n.id)}>✕</button>
	</p>
{/each}
