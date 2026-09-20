<script lang="ts">
	import { page } from '$app/state';
	import { signIn } from '$lib/session.svelte';
	import { safeNext } from '$lib/guard';

	let email = $state('');
	/** Where to land after the link is clicked, when they arrived from one. */
	const next = $derived(safeNext(page.url.searchParams.get('next')));
	let status = $state<'idle' | 'sending' | 'sent'>('idle');
	let error = $state<string | null>(null);

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		status = 'sending';
		error = null;
		const result = await signIn(email, next);
		if (result.error) {
			error = result.error;
			status = 'idle';
		} else {
			status = 'sent';
		}
	}
</script>

<main class="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-4 p-6">
	<h1 style="font: 700 var(--tm-text-3xl)/1.1 var(--tm-font); letter-spacing: -0.03em">
		TravelMate
	</h1>
	<p style="font: 400 var(--tm-text-base)/1.5 var(--tm-font); color: var(--tm-text-muted)">
		Tell it your hotel and your dates. It works out the days.
	</p>

	{#if status === 'sent'}
		<!-- Naming the address matters: a typo is otherwise invisible until the
		     traveller goes looking for a mail that was never sent. -->
		<p
			class="tm-card"
			style="background: var(--tm-ok-soft); color: var(--tm-ok-ink); border-color: transparent"
		>
			Check <strong>{email}</strong> for a sign-in link.
		</p>
	{:else}
		<form onsubmit={submit} class="flex flex-col gap-4">
			<div class="tm-field">
				<label class="tm-label" for="email">Email</label>
				<input
					class="tm-input"
					id="email"
					type="email"
					required
					autocomplete="email"
					bind:value={email}
					placeholder="you@example.com"
					aria-invalid={error ? 'true' : undefined}
				/>
				{#if error}<span class="tm-hint tm-hint--error">{error}</span>{/if}
			</div>
			<button class="tm-btn tm-btn--primary tm-btn--block" type="submit" disabled={status === 'sending'}>
				{status === 'sending' ? 'Sending…' : 'Send me a link'}
			</button>
		</form>
		<p
			style="font: 400 var(--tm-text-sm)/1.45 var(--tm-font); color: var(--tm-text-faint); text-align: center"
		>
			No password. We email you a link.{#if next} You'll come straight back here.{/if}
		</p>
	{/if}
</main>
