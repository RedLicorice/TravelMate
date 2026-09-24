<script lang="ts" generics="T extends { name: string; label: string }">
	import { track } from '$lib/telemetry';
	import { SEARCH_DEBOUNCE_MS } from '$lib/search';
	import SearchTrail from '$lib/SearchTrail.svelte';
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
		// Asked after a pause in the typing, not at every letter (see
		// SEARCH_DEBOUNCE_MS); a keystroke also cancels a search still out.
		timer = setTimeout(run, SEARCH_DEBOUNCE_MS);
	}

	/** Search now, without waiting for the pause: the lens, or Enter. */
	function searchNow() {
		clearTimeout(timer);
		inflight?.abort();
		if (query.trim().length < 2) return;
		error = null;
		status = 'searching';
		void run();
	}

	/** Empty the box: the text, what it found, and any search still out. */
	function clear() {
		clearTimeout(timer);
		inflight?.abort();
		query = '';
		results = [];
		error = null;
		picked = false;
		status = 'idle';
	}

	async function run() {
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
	<div class="tm-search">
		<input
			{id}
			{placeholder}
			{disabled}
			bind:value={query}
			oninput={onInput}
			onkeydown={(e) => {
				if (e.key === 'Enter') {
					e.preventDefault();
					searchNow();
				}
			}}
			autocomplete="off"
			spellcheck="false"
		/>
		<SearchTrail
			searching={status === 'searching'}
			filled={query.trim().length > 0}
			onclear={clear}
			onsearch={searchNow}
		/>
	</div>

	{#if error}
		<span class="tm-hint tm-hint--error">{error}</span>
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
