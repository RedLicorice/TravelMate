<script lang="ts">
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { createTrip, noTerminals, type Terminals } from '$lib/trip/repo';
	import TerminalFields from '$lib/TerminalFields.svelte';
	import { fromLocalInput } from '$lib/trip/days';
	import Autocomplete from '$lib/Autocomplete.svelte';
	import { poi } from '$lib/poi';
	import type { City, Place } from '$lib/poi';

	let step = $state(1);
	let city = $state<City | null>(null);
	let hotel = $state<Place | null>(null);
	let arrivalAt = $state('');
	let departureAt = $state('');
	let saving = $state(false);
	let error = $state<string | null>(null);

	// The browser's zone is the best guess available without geocoding. Shown,
	// not hidden, so someone planning from home can correct it.
	let timezone = $state(Intl.DateTimeFormat().resolvedOptions().timeZone);
	let terminals = $state<Terminals>(noTerminals());

	const titles = ['Where are you going?', 'When?', 'Check and save'];

	const canAdvance = $derived(
		step === 1
			? city !== null && hotel !== null
			: step === 2
				? arrivalAt !== '' && departureAt !== '' && departureAt > arrivalAt
				: true
	);

	async function save() {
		saving = true;
		error = null;
		try {
			const id = await createTrip({
				name: city!.name,
				city: city!.name,
				timezone,
				hotelName: hotel!.name,
				hotelLat: hotel!.lat,
				hotelLng: hotel!.lng,
				// datetime-local carries no zone. Read it as wall-clock time in the
				// destination, not in the browser: planning a Tokyo trip from Rome
				// would otherwise store the arrival eight hours out.
				arrivalAt: fromLocalInput(arrivalAt, timezone),
				departureAt: fromLocalInput(departureAt, timezone),
				cityBBox: city!.bbox,
				terminals
			});
			// replaceState so the finished wizard is not left in history: a
			// swipe-back from the new trip would otherwise reopen step 3.
			await goto(`${base}/trip/${id}`, { replaceState: true });
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
		<div class="mb-5">
			<Autocomplete
				label="City"
				placeholder="London"
				hint="Start typing — results appear as you go."
				search={(q, signal) => poi.searchCities(q, signal)}
				onpick={(c) => {
					city = c;
					hotel = null; // a hotel from the previous city is meaningless here
				}}
			/>
		</div>
		<Autocomplete
			label="Hotel"
			placeholder={city ? `Hotels in ${city.name}` : 'Pick a city first'}
			hint={city ? 'Searched inside the city you picked.' : 'Pick a city first.'}
			disabled={!city}
			search={(q, signal) => poi.searchHotels(q, city!, signal)}
			onpick={(h) => (hotel = h)}
		/>
		<p class="tm-attrib mt-4">{poi.attribution}</p>
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

		<div class="mt-6" style="border-top: 1px solid var(--tm-border); padding-top: 1rem">
			<TerminalFields bind:terminals {city} />
		</div>
	{:else}
		<dl class="flex flex-col gap-3">
			{#each [['City', city?.name ?? ''], ['Hotel', hotel?.name ?? ''], ['Arrival', arrivalAt], ['Departure', departureAt], ['Timezone', timezone], ['Arriving at', terminals.arrivalName ?? 'no terminal'], ['Leaving from', terminals.departureName ?? 'no terminal']] as [label, value]}
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
