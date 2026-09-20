<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { safeNext } from '$lib/guard';
	import {
		enabledProviders,
		sendPasswordReset,
		signInWithPassword,
		signInWithProvider,
		signUpWithPassword,
		type OAuthProvider
	} from '$lib/session.svelte';

	type Mode = 'signin' | 'signup' | 'forgot';

	let mode = $state<Mode>('signin');
	let email = $state('');
	let password = $state('');
	let busy = $state(false);
	let error = $state<string | null>(null);
	let notice = $state<string | null>(null);
	let providers = $state<OAuthProvider[]>([]);

	const next = $derived(safeNext(page.url.searchParams.get('next')));

	onMount(async () => {
		providers = await enabledProviders();
	});

	const TITLES: Record<Mode, string> = {
		signin: 'Welcome back',
		signup: 'Create an account',
		forgot: 'Reset your password'
	};

	// Supabase's own floor is 6; 8 is the more conventional minimum and the
	// server will reject anything shorter anyway.
	const passwordOk = $derived(password.length >= 8);
	const emailOk = $derived(/^\S+@\S+\.\S+$/.test(email));

	const canSubmit = $derived(
		mode === 'forgot' ? emailOk : emailOk && passwordOk
	);

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		busy = true;
		error = null;
		notice = null;
		try {
			if (mode === 'signin') {
				const r = await signInWithPassword(email, password);
				error = r.error;
				// On success the session listener redirects; nothing to do here.
			} else if (mode === 'signup') {
				const r = await signUpWithPassword(email, password, next);
				error = r.error;
				if (!r.error && r.needsConfirmation) {
					notice = `Account created. Check ${email} for a confirmation link before signing in.`;
				}
			} else {
				const r = await sendPasswordReset(email);
				error = r.error;
				if (!r.error) notice = `If ${email} has an account, a reset link is on its way.`;
			}
		} finally {
			busy = false;
		}
	}

	async function oauth(provider: OAuthProvider) {
		busy = true;
		error = null;
		const r = await signInWithProvider(provider, next);
		if (r.error) {
			error = r.error;
			busy = false;
		}
		// Success navigates away to the provider.
	}

</script>

<main class="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-4 p-6">
	<h1 style="font: 700 var(--tm-text-3xl)/1.1 var(--tm-font); letter-spacing: -0.03em">
		TravelMate
	</h1>
	<p style="font: 400 var(--tm-text-base)/1.5 var(--tm-font); color: var(--tm-text-muted)">
		{#if mode === 'signin'}
			Tell it your hotel and your dates. It works out the days.
		{:else}
			{TITLES[mode]}
		{/if}
	</p>

	{#if notice}
		<p class="tm-card" style="background: var(--tm-ok-soft); color: var(--tm-ok-ink); border-color: transparent">
			{notice}
		</p>
	{/if}

	{#if providers.length}
		<div class="flex flex-col gap-2">
			{#each providers as provider}
				<button class="tm-btn tm-btn--secondary tm-btn--block" disabled={busy} onclick={() => oauth(provider)}>
					Continue with {provider === 'google' ? 'Google' : 'Apple'}
				</button>
			{/each}
		</div>
		<div class="flex items-center gap-3" style="color: var(--tm-text-faint)">
			<span style="flex:1;height:1px;background:var(--tm-border)"></span>
			<span style="font: 400 var(--tm-text-sm)/1 var(--tm-font)">or</span>
			<span style="flex:1;height:1px;background:var(--tm-border)"></span>
		</div>
	{/if}

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
			/>
		</div>

		{#if mode !== 'forgot'}
			<div class="tm-field">
				<label class="tm-label" for="password">Password</label>
				<input
					class="tm-input"
					id="password"
					type="password"
					required
					autocomplete={mode === 'signup' ? 'new-password' : 'current-password'}
					bind:value={password}
					placeholder="At least 8 characters"
				/>
				{#if password && !passwordOk}
					<span class="tm-hint">At least 8 characters.</span>
				{/if}
			</div>
		{/if}

		{#if error}<p class="tm-hint tm-hint--error">{error}</p>{/if}

		<button class="tm-btn tm-btn--primary tm-btn--block" type="submit" disabled={busy || !canSubmit}>
			{#if busy}
				Working…
			{:else if mode === 'signin'}
				Sign in
			{:else if mode === 'signup'}
				Create account
			{:else}
				Email me a reset link
			{/if}
		</button>
	</form>

	<div class="flex flex-col items-center gap-2">
		{#if mode === 'signin'}
			<button class="tm-btn tm-btn--ghost" style="min-height:auto;padding:0" onclick={() => (mode = 'signup')}>
				No account? Create one
			</button>
			<button class="tm-btn tm-btn--ghost" style="min-height:auto;padding:0" onclick={() => (mode = 'forgot')}>
				Forgot your password?
			</button>
		{:else}
			<button class="tm-btn tm-btn--ghost" style="min-height:auto;padding:0" onclick={() => (mode = 'signin')}>
				Back to sign in
			</button>
		{/if}
	</div>

	{#if next}
		<p style="font: 400 var(--tm-text-sm)/1.45 var(--tm-font); color: var(--tm-text-faint); text-align: center">
			You'll come straight back to the trip you were invited to.
		</p>
	{/if}
</main>
