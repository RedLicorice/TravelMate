<script lang="ts" generics="T extends { name: string; label: string }">
	type Props = {
		label: string;
		placeholder?: string;
		hint?: string;
		disabled?: boolean;
		search: (query: string, signal: AbortSignal) => Promise<T[]>;
		onpick: (item: T) => void;
	};

	let { label, placeholder, hint, disabled = false, search, onpick }: Props = $props();

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

		if (query.trim().length < 3) {
			results = [];
			status = 'idle';
			return;
		}

		status = 'searching';
		// Nominatim's usage policy caps traffic at roughly one request a second.
		// 600ms plus abort-on-keystroke keeps a fast typist to one real request.
		timer = setTimeout(async () => {
			const controller = new AbortController();
			inflight = controller;
			try {
				results = await search(query.trim(), controller.signal);
				status = 'done';
			} catch (e) {
				if ((e as Error).name === 'AbortError') return;
				error = (e as Error).message;
				status = 'done';
			}
		}, 600);
	}

	function choose(item: T) {
		onpick(item);
		query = item.name;
		results = [];
		picked = true;
		status = 'idle';
	}
</script>

<div class="tm-field">
	<label class="tm-label" for={label}>{label}</label>
	<input
		class="tm-input"
		id={label}
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
