<script lang="ts">
	/**
	 * The right-hand end of a search box: a spinner while a search is out,
	 * a cross to clear the box, and a lens to search now. Glyphs only: the
	 * cross is U+2715, the lens is drawn.
	 */
	type Props = {
		searching: boolean;
		/** Whether the box has anything in it: there is nothing to clear or search otherwise. */
		filled: boolean;
		onclear: () => void;
		onsearch: () => void;
	};

	let { searching, filled, onclear, onsearch }: Props = $props();
</script>

{#if searching}
	<span class="tm-spin" role="status" aria-label="Searching"></span>
{/if}
{#if filled}
	<button type="button" class="tm-search__btn" aria-label="Clear" onclick={onclear}>✕</button>
{/if}
<button type="button" class="tm-search__btn" aria-label="Search now" disabled={!filled} onclick={onsearch}>
	<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true">
		<circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" />
	</svg>
</button>
