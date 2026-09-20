<script lang="ts">
	import { base } from '$app/paths';
	import { supabase } from '$lib/supabase';
	import { session, signOut } from '$lib/session.svelte';
	import { avatarDataUri, newSeed } from '$lib/avatar';
	import { displayName, readProfile, saveProfile } from '$lib/profile.svelte';

	let profile = $state(readProfile());
	let status = $state<'idle' | 'saving' | 'saved'>('idle');
	let error = $state<string | null>(null);
	let uploading = $state(false);

	const src = $derived(profile.avatarUrl ?? avatarDataUri(profile.avatarSeed));

	async function persist(patch: Parameters<typeof saveProfile>[0]) {
		status = 'saving';
		error = null;
		try {
			await saveProfile(patch);
			profile = readProfile();
			status = 'saved';
			setTimeout(() => (status = 'idle'), 1500);
		} catch (e) {
			error = (e as Error).message;
			status = 'idle';
		}
	}

	async function reroll() {
		// Dropping avatarUrl as well, or the new face would generate invisibly
		// behind an uploaded picture that is still winning.
		await persist({ avatarSeed: newSeed(), avatarUrl: null });
	}

	async function upload(event: Event) {
		const file = (event.target as HTMLInputElement).files?.[0];
		if (!file || !session.user) return;
		uploading = true;
		error = null;
		try {
			// Keyed by user id so the storage policy can check ownership, and
			// with a fresh name each time so a cached old picture cannot linger.
			const ext = file.name.split('.').pop()?.toLowerCase() ?? 'png';
			const path = `${session.user.id}/${newSeed()}.${ext}`;
			const { error: upErr } = await supabase.storage
				.from('avatars')
				.upload(path, file, { upsert: true, contentType: file.type });
			if (upErr) throw new Error(upErr.message);
			const { data } = supabase.storage.from('avatars').getPublicUrl(path);
			await persist({ avatarUrl: data.publicUrl });
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
			<button class="tm-btn tm-btn--secondary" onclick={reroll} disabled={status === 'saving'}>
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
				onclick={() => persist({ avatarUrl: null })}
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
			bind:value={profile.name}
			placeholder="What should we call you?"
			onblur={() => persist({ name: profile.name })}
		/>
		<span class="tm-hint">
			{#if error}
				<span class="tm-hint--error">{error}</span>
			{:else if status === 'saving'}
				Saving…
			{:else if status === 'saved'}
				Saved
			{:else}
				Saved automatically.
			{/if}
		</span>
	</div>

	<button class="tm-btn tm-btn--secondary tm-btn--block mt-8" onclick={signOut}>Sign out</button>
</main>
