<script lang="ts">
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { createTrip } from '$lib/trip/repo';

	let step = $state(1);
	let city = $state('');
	let hotelName = $state('');
	let arrivalAt = $state('');
	let departureAt = $state('');
	let saving = $state(false);
	let error = $state<string | null>(null);

	// Phase 2 replaces this with a real geocode through the POI seam. Until then
	// the hotel has a name but no position, so no map can centre on it.
	// ponytail: hardcoded 0,0 -- replace with poi.search() in phase 2.
	const PLACEHOLDER = { lat: 0, lng: 0 };

	// The browser's zone is the best guess available without geocoding. Shown,
	// not hidden, so someone planning from home can correct it.
	let timezone = $state(Intl.DateTimeFormat().resolvedOptions().timeZone);

	const titles = ['Where are you going?', 'When?', 'Check and save'];

	const canAdvance = $derived(
		step === 1
			? city.trim() !== '' && hotelName.trim() !== ''
			: step === 2
				? arrivalAt !== '' && departureAt !== '' && departureAt > arrivalAt
				: true
	);

	async function save() {
		saving = true;
		error = null;
		try {
			const id = await createTrip({
				name: city,
				city,
				timezone,
				hotelName,
				hotelLat: PLACEHOLDER.lat,
				hotelLng: PLACEHOLDER.lng,
				// datetime-local has no zone. The traveller entered local time in
				// the destination city, which is what the planner assumes too.
				arrivalAt: new Date(arrivalAt).toISOString(),
				departureAt: new Date(departureAt).toISOString()
			});
			await goto(`${base}/trip/${id}`);
		} catch (e) {
			error = (e as Error).message;
			saving = false;
		}
	}
</script>

<main class="mx-auto flex min-h-dvh max-w-lg flex-col p-6 pb-28">
	<p style="font: 400 var(--tm-text-sm)/1 var(--tm-font); color: var(--tm-text-faint)">
		Step {step} of 3
	</p>
	<h1
		class="mt-1 mb-6"
		style="font: 700 var(--tm-text-2xl)/1.15 var(--tm-font); letter-spacing: -0.02em"
	>
		{titles[step - 1]}
	</h1>

	{#if step === 1}
		<div class="tm-field mb-5">
			<label class="tm-label" for="city">City</label>
			<input class="tm-input" id="city" bind:value={city} placeholder="Rome" />
		</div>
		<div class="tm-field">
			<label class="tm-label" for="hotel">Hotel</label>
			<input class="tm-input" id="hotel" bind:value={hotelName} placeholder="Hotel Artemide" />
		</div>
	{:else if step === 2}
		<div class="tm-field mb-5">
			<label class="tm-label" for="arr">Arrival</label>
			<input class="tm-input" id="arr" type="datetime-local" bind:value={arrivalAt} />
		</div>
		<div class="tm-field mb-5">
			<label class="tm-label" for="dep">Departure</label>
			<input class="tm-input" id="dep" type="datetime-local" bind:value={departureAt} />
		</div>
		<div class="tm-field">
			<label class="tm-label" for="tz">Timezone</label>
			<input class="tm-input" id="tz" bind:value={timezone} />
			<span class="tm-hint">Times are local to the city you're visiting.</span>
		</div>
	{:else}
		<dl class="flex flex-col gap-3">
			{#each [['City', city], ['Hotel', hotelName], ['Arrival', arrivalAt], ['Departure', departureAt], ['Timezone', timezone]] as [label, value]}
				<div>
					<dt style="font: 400 var(--tm-text-sm)/1 var(--tm-font); color: var(--tm-text-faint)">
						{label}
					</dt>
					<dd style="font: 500 var(--tm-text-base)/1.4 var(--tm-font)">{value}</dd>
				</div>
			{/each}
		</dl>
		{#if error}<p class="tm-hint tm-hint--error mt-4">{error}</p>{/if}
	{/if}

	<div class="fixed inset-x-0 bottom-0 p-6">
		<div class="mx-auto flex max-w-lg gap-3">
			<button class="tm-btn tm-btn--secondary" onclick={() => (step > 1 ? step-- : goto(`${base}/`))}>
				Back
			</button>
			{#if step < 3}
				<button class="tm-btn tm-btn--primary flex-1" disabled={!canAdvance} onclick={() => step++}>
					Next
				</button>
			{:else}
				<button class="tm-btn tm-btn--primary flex-1" disabled={saving} onclick={save}>
					{saving ? 'Saving…' : 'Save trip'}
				</button>
			{/if}
		</div>
	</div>
</main>
