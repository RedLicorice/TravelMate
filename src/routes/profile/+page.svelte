<script lang="ts">
	import { onMount } from 'svelte';
	import { base } from '$app/paths';
	import { supabase } from '$lib/supabase';
	import { session, signOut } from '$lib/session.svelte';
	import { avatarDataUri, newSeed } from '$lib/avatar';
	import { displayName, loadMyProfile, saveMyProfile, type Profile } from '$lib/profile.svelte';
	import { MEAL_NAMES, toHours, type MealWindows } from '$lib/plan/meals';

	let profile = $state<Profile | null>(null);
	let loading = $state(true);
	let status = $state<'idle' | 'saving' | 'saved'>('idle');
	let error = $state<string | null>(null);
	let uploading = $state(false);

	onMount(async () => {
		try {
			profile = await loadMyProfile();
		} catch (e) {
			error = (e as Error).message;
		} finally {
			loading = false;
		}
	});

	const src = $derived(
		profile ? (profile.avatarUrl ?? avatarDataUri(profile.avatarSeed)) : ''
	);

	/** A window with the end before the start would silently never match. */
	const badWindow = (w: MealWindows, name: (typeof MEAL_NAMES)[number]) =>
		toHours(w[name].to) <= toHours(w[name].from);

	async function persist(patch: Parameters<typeof saveMyProfile>[0]) {
		status = 'saving';
		error = null;
		try {
			profile = await saveMyProfile(patch);
			status = 'saved';
			setTimeout(() => (status = 'idle'), 1500);
		} catch (e) {
			error = (e as Error).message;
			status = 'idle';
		}
	}

	async function setMeal(name: (typeof MEAL_NAMES)[number], edge: 'from' | 'to', value: string) {
		if (!profile) return;
		const next: MealWindows = {
			...profile.mealWindows,
			[name]: { ...profile.mealWindows[name], [edge]: value }
		};
		profile = { ...profile, mealWindows: next };
		if (!badWindow(next, name)) await persist({ meal_windows: next });
	}

	async function upload(event: Event) {
		const file = (event.target as HTMLInputElement).files?.[0];
		if (!file || !session.user) return;
		uploading = true;
		error = null;
		try {
			const ext = file.name.split('.').pop()?.toLowerCase() ?? 'png';
			// Keyed by user id so the storage policy can check ownership, with a
			// fresh name each time so a cached old picture cannot linger.
			const path = `${session.user.id}/${newSeed()}.${ext}`;
			const { error: upErr } = await supabase.storage
				.from('avatars')
				.upload(path, file, { upsert: true, contentType: file.type });
			if (upErr) throw new Error(upErr.message);
			const { data } = supabase.storage.from('avatars').getPublicUrl(path);
			await persist({ avatar_url: data.publicUrl });
		} catch (e) {
			error = (e as Error).message;
		} finally {
			uploading = false;
		}
	}
</script>

<main class="mx-auto max-w-lg px-6 pb-16">
	<header class="tm-safe-top mb-6 flex items-baseline justify-between">
		<a href="{base}/" class="tm-attrib" style="text-decoration: none">← Trips</a>
		<h1 style="font: 700 var(--tm-text-xl)/1.15 var(--tm-font)">Profile</h1>
	</header>

	{#if loading}
		<p style="color: var(--tm-text-faint)">Loading…</p>
	{:else if profile}
		<div class="flex flex-col items-center gap-4">
			<img
				{src}
				alt=""
				width="96"
				height="96"
				style="width:96px;height:96px;border-radius:50%;background:var(--tm-surface-2);border:1px solid var(--tm-border);object-fit:cover"
			/>
			<p style="font: 600 var(--tm-text-lg)/1.2 var(--tm-font)">
				{displayName(profile, session.user?.email)}
			</p>
			<p class="tm-attrib">{session.user?.email ?? ''}</p>

			<div class="flex gap-2">
				<button
					class="tm-btn tm-btn--secondary"
					onclick={() => persist({ avatar_seed: newSeed(), avatar_url: null })}
					disabled={status === 'saving'}
				>
					New face
				</button>
				<label class="tm-btn tm-btn--secondary" style="cursor: pointer">
					{uploading ? 'Uploading…' : 'Upload'}
					<input type="file" accept="image/*" hidden onchange={upload} disabled={uploading} />
				</label>
			</div>
			{#if profile.avatarUrl}
				<button
					class="tm-btn tm-btn--ghost"
					style="min-height:auto;padding:0"
					onclick={() => persist({ avatar_url: null })}
				>
					Use a generated picture instead
				</button>
			{/if}
		</div>

		<div class="tm-field mt-8">
			<label class="tm-label" for="name">Name</label>
			<input
				class="tm-input"
				id="name"
				value={profile.name}
				placeholder="What should we call you?"
				onblur={(e) => persist({ display_name: e.currentTarget.value })}
			/>
		</div>

		<h2 class="tm-label mt-8 mb-1">When you eat</h2>
		<p class="tm-hint mb-3">
			The planner puts restaurants inside these hours and waits rather than seating you at the
			wrong time. On a shared trip it uses the overlap between everyone.
		</p>

		{#each MEAL_NAMES as name}
			<div class="mb-4">
				<p class="tm-label" style="text-transform: capitalize">{name}</p>
				<div class="mt-2 flex items-center gap-2">
					<input
						class="tm-input"
						type="time"
						aria-label="{name} from"
						value={profile.mealWindows[name].from}
						onchange={(e) => setMeal(name, 'from', e.currentTarget.value)}
					/>
					<span style="color: var(--tm-text-faint)">to</span>
					<input
						class="tm-input"
						type="time"
						aria-label="{name} to"
						value={profile.mealWindows[name].to}
						onchange={(e) => setMeal(name, 'to', e.currentTarget.value)}
					/>
				</div>
				{#if badWindow(profile.mealWindows, name)}
					<span class="tm-hint tm-hint--error">
						The end has to be after the start, so this is not saved yet.
					</span>
				{/if}
			</div>
		{/each}

		<p class="tm-hint">
			{#if error}
				<span class="tm-hint--error">{error}</span>
			{:else if status === 'saving'}
				Saving…
			{:else if status === 'saved'}
				Saved
			{:else}
				Saved automatically.
			{/if}
		</p>

		<button class="tm-btn tm-btn--secondary tm-btn--block mt-8" onclick={signOut}>Sign out</button>
	{:else if error}
		<p class="tm-hint tm-hint--error">{error}</p>
	{/if}
</main>
