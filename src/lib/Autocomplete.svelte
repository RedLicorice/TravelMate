<script lang="ts" generics="T extends { name: string; label: string }">
	import { track } from '$lib/telemetry';
	type Props = {
		label: string;
		placeholder?: string;
		hint?: string;
		disabled?: boolean;
		search: (query: string, signal: AbortSignal) => Promise<T[]>;
		onpick: (item: T) => void;
	};

	let { label, placeholder, hint, disabled = false, search, onpick }: Props = $props();

	/**
	 * This box's own id.
	 *
	 * It used to be the label, so every "From" on a multi-leg journey answered
	 * to the same name: tapping a label focused the first leg's box, whichever
	 * leg had been tapped.
	 */
	const id = $props.id();

	let query = $state('');
	let results = $state<T[]>([]);
	let status = $state<'idle' | 'searching' | 'done'>('idle');
	let error = $state<string | null>(null);
	let picked = $state(false);

	let timer: ReturnType<typeof setTimeout>;
	let inflight: AbortController | null = null;

	function onInput() {
		picked = false;
		clearTimeout(timer);
		inflight?.abort();
		error = null;

		if (query.trim().length < 2) {
			results = [];
			status = 'idle';
			return;
		}

		status = 'searching';
		// Photon is a type-ahead geocoder: it answers partial words, so results
		// should land while the traveller is still typing. 250ms plus
		// abort-on-keystroke means a fast typist issues one request, not ten.
		timer = setTimeout(async () => {
			const controller = new AbortController();
			inflight = controller;
			const asked = query.trim();
			const started = performance.now();
			try {
				results = await search(asked, controller.signal);
				status = 'done';
				track('search', {
					label,
					query: asked,
					found: results.length,
					ms: Math.round(performance.now() - started),
					first: results[0]?.name ?? null
				});
			} catch (e) {
				if ((e as Error).name === 'AbortError') return;
				error = (e as Error).message;
				status = 'done';
				track('search.failed', {
					label,
					query: asked,
					ms: Math.round(performance.now() - started),
					error: String((e as Error).message).slice(0, 200)
				});
			}
		}, 250);
	}

	function choose(item: T) {
		track('search.picked', { label, name: item.name });
		onpick(item);
		query = item.name;
		results = [];
		picked = true;
		status = 'idle';
	}
</script>

<div class="tm-field">
	<label class="tm-label" for={id}>{label}</label>
	<input
		class="tm-input"
		{id}
		{placeholder}
		{disabled}
		bind:value={query}
		oninput={onInput}
		autocomplete="off"
		spellcheck="false"
	/>

	{#if error}
		<span class="tm-hint tm-hint--error">{error}</span>
	{:else if status === 'searching'}
		<span class="tm-hint">Searching…</span>
	{:else if status === 'done' && results.length === 0}
		<span class="tm-hint">Nothing found. Try a different spelling.</span>
	{:else if picked}
		<span class="tm-hint" style="color: var(--tm-ok-ink)">Selected</span>
	{:else if hint}
		<span class="tm-hint">{hint}</span>
	{/if}

	{#if results.length}
		<ul
			style="background: var(--tm-surface); border: 1px solid var(--tm-border); border-radius: var(--tm-r-md); padding: 0 var(--tm-space-3); max-height: 260px; overflow-y: auto"
		>
			{#each results as item, i (item.name + item.label + i)}
				<li class="tm-result" style={i === results.length - 1 ? 'border-bottom: none' : ''}>
					<button
						type="button"
						onclick={() => choose(item)}
						style="text-align: left; background: none; border: none; padding: 0; cursor: pointer; color: inherit; font: inherit; width: 100%"
					>
						<span class="tm-result__name">{item.name}</span>
						<span class="tm-result__meta" style="display: block">{item.label}</span>
					</button>
				</li>
			{/each}
		</ul>
	{/if}
</div>
