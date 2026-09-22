<script lang="ts">
	import { base } from '$app/paths';
	import { avatarDataUri } from '$lib/avatar';
	import { displayName, myProfile } from '$lib/profile.svelte';
	import { session } from '$lib/session.svelte';

	const profile = $derived(myProfile());

	const name = $derived(profile ? displayName(profile, session.user?.email) : 'Profile');
	/** Shown until the avatar arrives, so the button never starts empty. */
	const initial = $derived(name.trim().charAt(0).toUpperCase() || '?');
</script>

<a class="tm-avatar-btn" href="{base}/profile" aria-label="Profile — {name}" title={name}>
	{#if profile}
		<img src={profile.avatarUrl ?? avatarDataUri(profile.avatarSeed)} alt="" width="40" height="40" />
	{:else}
		<span aria-hidden="true">{initial}</span>
	{/if}
</a>

<style>
	.tm-avatar-btn {
		display: grid;
		place-items: center;
		/* 44px is the smallest target a thumb reliably hits. */
		width: 44px;
		height: 44px;
		flex: none;
		border-radius: 50%;
		background: var(--tm-surface-2);
		border: 1px solid var(--tm-border);
		color: var(--tm-text-muted);
		font: 600 var(--tm-text-sm) / 1 var(--tm-font);
		text-decoration: none;
		overflow: hidden;
		transition: border-color 120ms ease, transform 120ms ease;
	}

	.tm-avatar-btn:hover {
		border-color: var(--tm-border-strong);
	}

	.tm-avatar-btn:active {
		transform: scale(0.95);
	}

	.tm-avatar-btn:focus-visible {
		outline: 2px solid var(--tm-primary);
		outline-offset: 2px;
	}

	.tm-avatar-btn img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	@media (prefers-reduced-motion: reduce) {
		.tm-avatar-btn {
			transition: none;
		}
		.tm-avatar-btn:active {
			transform: none;
		}
	}
</style>
