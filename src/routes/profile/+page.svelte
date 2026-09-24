<script lang="ts">
	import { base } from '$app/paths';
	import { session, signOut } from '$lib/session.svelte';
	import { avatarDataUri, newSeed } from '$lib/avatar';
	import { displayName, myProfile, saveMyProfile } from '$lib/profile.svelte';
	import { MEAL_NAMES, readyAt, toHours, type MealWindows } from '$lib/plan/meals';
	import { mutate, upload as store } from '$lib/store/store.svelte';
	import { supabase } from '$lib/supabase';
	import { choose } from '$lib/consent.svelte';
	import { forgetPending } from '$lib/telemetry';
	import { DIAGNOSTICS_DAYS } from '$lib/legal';
	import { version } from '$app/environment';

	/** Which build this is: when it was made, so two phones can be compared. */
	const built = Number.isFinite(Number(version))
		? new Date(Number(version)).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
		: version;

	/**
	 * Send diagnostics, or stop. Stopping takes back what was sent: the trail
	 * already on the server is deleted, and what was waiting is dropped.
	 */
	async function setDiagnostics(on: boolean) {
		choose(on);
		error = null;
		try {
			await mutate(on ? 'Sending diagnostics' : 'Stopped sending diagnostics', null, (w) =>
				saveMyProfile(w, { telemetry: on })
			);
			if (!on && session.user) {
				forgetPending();
				const { error: gone } = await supabase.from('events').delete().eq('user_id', session.user.id);
				if (gone) error = 'Diagnostics are off, but what was already sent could not be deleted yet. Try again with a connection.';
			}
		} catch (e) {
			error = (e as Error).message;
		}
	}

	const profile = $derived(myProfile());
	/** Meal hours being typed that do not make a window yet, so are not saved yet. */
	let draft = $state<MealWindows | null>(null);
	const windows = $derived(draft ?? profile?.mealWindows);
	let status = $state<'idle' | 'saved'>('idle');
	let error = $state<string | null>(null);
	let uploading = $state(false);

	const src = $derived(
		profile ? (profile.avatarUrl ?? avatarDataUri(profile.avatarSeed)) : ''
	);

	/** A window with the end before the start would silently never match. */
	const badWindow = (w: MealWindows, name: (typeof MEAL_NAMES)[number]) =>
		toHours(w[name].to) <= toHours(w[name].from);

	async function persist(patch: Parameters<typeof saveMyProfile>[1]) {
		error = null;
		try {
			await mutate('Changed your profile', null, (w) => saveMyProfile(w, patch));
			status = 'saved';
			setTimeout(() => (status = 'idle'), 1500);
		} catch (e) {
			error = (e as Error).message;
		}
	}

	async function setMeal(name: (typeof MEAL_NAMES)[number], edge: 'from' | 'to', value: string) {
		if (!windows) return;
		const next: MealWindows = { ...windows, [name]: { ...windows[name], [edge]: value } };
		if (badWindow(next, name)) {
			draft = next;
			return;
		}
		draft = null;
		await persist({ meal_windows: next });
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
			// A picture has to reach the server before anyone can see it, so
			// this one thing waits for a connection and says so if there is none.
			if (!navigator.onLine) throw new Error('Uploading a picture needs a connection.');
			await persist({ avatar_url: await store('avatars', path, file) });
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

	{#if !profile || !windows}
		<!-- A profile is made on first sign-in; until the server has answered
		     there is nothing to draw but its shape. -->
		<div class="flex flex-col gap-3">
			<div class="tm-skel" style="height:96px"></div>
			<div class="tm-skel" style="height:96px"></div>
		</div>
	{:else}
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

		<h2 class="tm-label mt-8 mb-1">Your mornings</h2>
		<p class="tm-hint mb-3">
			Nothing is planned before you are out of the door. On a shared trip the plan waits for
			whoever is ready last.
		</p>

		<div class="flex gap-3">
			<div class="tm-field flex-1">
				<label class="tm-label" for="wake">Wake up</label>
				<input
					class="tm-input"
					id="wake"
					type="time"
					value={profile.wakeAt}
					onchange={(e) => persist({ wake_at: e.currentTarget.value })}
				/>
			</div>
			<div class="tm-field flex-1">
				<label class="tm-label" for="prep">Getting ready</label>
				<select
					class="tm-input"
					id="prep"
					value={String(profile.prepMin)}
					onchange={(e) => persist({ prep_min: Number(e.currentTarget.value) })}
				>
					{#each [0, 15, 30, 45, 60, 90, 120] as m}
						<option value={String(m)}>{m === 0 ? 'straight out' : `${m} min`}</option>
					{/each}
				</select>
			</div>
		</div>
		<p class="tm-hint mt-1">
			Out of the door by {readyAt(profile.wakeAt, profile.prepMin)}.
		</p>

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
						value={windows[name].from}
						onchange={(e) => setMeal(name, 'from', e.currentTarget.value)}
					/>
					<span style="color: var(--tm-text-faint)">to</span>
					<input
						class="tm-input"
						type="time"
						aria-label="{name} to"
						value={windows[name].to}
						onchange={(e) => setMeal(name, 'to', e.currentTarget.value)}
					/>
				</div>
				{#if badWindow(windows, name)}
					<span class="tm-hint tm-hint--error">
						The end has to be after the start, so this is not saved yet.
					</span>
				{/if}
			</div>
		{/each}

		<p class="tm-hint">
			{#if error}
				<span class="tm-hint--error">{error}</span>
			{:else if status === 'saved'}
				Saved
			{:else}
				Saved automatically.
			{/if}
		</p>

		<h2 class="tm-label mt-8 mb-1">Diagnostics</h2>
		<label class="flex items-center gap-3" style="cursor:pointer">
			<input
				type="checkbox"
				checked={profile.telemetry === true}
				onchange={(e) => setDiagnostics(e.currentTarget.checked)}
			/>
			<span>Send diagnostics</span>
		</label>
		<p class="tm-hint mt-1">
			What went wrong, and what you did just before, so faults can be fixed. Kept {DIAGNOSTICS_DAYS} days.
			Turning it off deletes what was sent. <a href="{base}/privacy">Privacy notice</a> ·
			<a href="{base}/terms">Terms of service</a>
		</p>

		<button class="tm-btn tm-btn--secondary tm-btn--block mt-8" onclick={signOut}>Sign out</button>
		<p class="tm-attrib mt-3" style="text-align:center">Version {built}</p>
	{/if}
</main>
