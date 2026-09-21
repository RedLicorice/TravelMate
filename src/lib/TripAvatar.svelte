<script lang="ts">
	import { flagLabel } from '$lib/flag';

	type Props = {
		imageUrl?: string | null;
		countryCode?: string | null;
		city: string;
		size?: number;
	};
	let { imageUrl = null, countryCode = null, city, size = 44 }: Props = $props();

	/** An upload that 404s falls back to the flag rather than a broken image. */
	let broken = $state(false);
	const label = $derived(flagLabel(countryCode, city));
</script>

<span
	class="tm-trip-avatar"
	aria-hidden="true"
	style="width:{size}px;height:{size}px;font-size:{Math.round(size * 0.52)}px"
>
	{#if imageUrl && !broken}
		<img src={imageUrl} alt="" onerror={() => (broken = true)} />
	{:else}
		{label}
	{/if}
</span>

<style>
	.tm-trip-avatar {
		display: grid;
		place-items: center;
		flex: none;
		border-radius: var(--tm-r-md);
		overflow: hidden;
		background: var(--tm-surface-2);
		border: 1px solid var(--tm-border);
		/* Initials, when there is no flag glyph and no picture. */
		font-weight: 700;
		line-height: 1;
		color: var(--tm-text-faint);
	}

	.tm-trip-avatar img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
</style>
