<script lang="ts">
	type Props = {
		value: number;
		/** Read-only in lists; tappable on the detail page. */
		onchange?: (value: number) => void;
		size?: number;
		label?: string;
	};

	let { value, onchange, size = 13, label = 'How much you want to visit' }: Props = $props();

	const LEVELS = [1, 2, 3, 4, 5];
	const WORDS = ['', 'if there is time', 'would be nice', 'want to', 'really want to', 'must see'];
</script>

{#if onchange}
	<div role="radiogroup" aria-label={label} class="flex items-center gap-1">
		{#each LEVELS as level}
			<button
				type="button"
				role="radio"
				aria-checked={value === level}
				aria-label="{level} of 5 — {WORDS[level]}"
				onclick={() => onchange(level)}
				style="background:none;border:none;padding:4px 2px;cursor:pointer;line-height:0"
			>
				<span
					style="display:block;width:{size}px;height:{size}px;border-radius:50%;
					background:{level <= value ? 'var(--tm-primary)' : 'transparent'};
					border:1.5px solid {level <= value ? 'var(--tm-primary)' : 'var(--tm-border-strong)'}"
				></span>
			</button>
		{/each}
		<span class="ml-2" style="font: 400 var(--tm-text-sm)/1 var(--tm-font); color: var(--tm-text-muted)">
			{WORDS[value] ?? ''}
		</span>
	</div>
{:else}
	<!-- Read-only: one element with a text alternative, rather than five
	     decorative dots a screen reader would read out one at a time. -->
	<span class="flex items-center gap-0.5" role="img" aria-label="{label}: {value} of 5">
		{#each LEVELS as level}
			<span
				style="display:block;width:{size}px;height:{size}px;border-radius:50%;
				background:{level <= value ? 'var(--tm-primary)' : 'transparent'};
				border:1.5px solid {level <= value ? 'var(--tm-primary)' : 'var(--tm-border)'}"
			></span>
		{/each}
	</span>
{/if}
