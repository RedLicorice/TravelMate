<script lang="ts">
	import { base } from '$app/paths';
	import { goto } from '$app/navigation';
	import { session, setPassword } from '$lib/session.svelte';

	let password = $state('');
	let busy = $state(false);
	let error = $state<string | null>(null);

	const ok = $derived(password.length >= 8);

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		busy = true;
		error = null;
		const r = await setPassword(password);
		if (r.error) {
			error = r.error;
			busy = false;
			return;
		}
		await goto(`${base}/`, { replaceState: true });
	}
</script>

<main class="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-4 p-6">
	<h1 style="font: 700 var(--tm-text-2xl)/1.15 var(--tm-font)">Choose a new password</h1>

	{#if !session.user}
		<!-- Arriving here without a session means the link expired or was
		     already used; the recovery token is what creates the session. -->
		<p class="tm-card" style="background: var(--tm-surface-2)">
			This reset link is no longer valid. Ask for a new one from the sign-in screen.
		</p>
		<a href="{base}/login" class="tm-btn tm-btn--primary tm-btn--block" style="text-decoration:none">
			Back to sign in
		</a>
	{:else}
		<form onsubmit={submit} class="flex flex-col gap-4">
			<div class="tm-field">
				<label class="tm-label" for="pw">New password</label>
				<input
					class="tm-input"
					id="pw"
					type="password"
					required
					autocomplete="new-password"
					bind:value={password}
					placeholder="At least 8 characters"
				/>
			</div>
			{#if error}<p class="tm-hint tm-hint--error">{error}</p>{/if}
			<button class="tm-btn tm-btn--primary tm-btn--block" type="submit" disabled={busy || !ok}>
				{busy ? 'Saving…' : 'Save password'}
			</button>
		</form>
	{/if}
</main>
