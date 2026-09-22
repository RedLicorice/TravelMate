<script lang="ts">
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { createTrip, noTerminals, type Terminals } from '$lib/trip/repo';
	import JourneySide from '$lib/JourneySide.svelte';
	import CheckIn from '$lib/CheckIn.svelte';
	import { localZone, zoneAt } from '$lib/trip/timezone';
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
	/**
	 * The destination's zone, not the traveller's. A ticket quotes every time
	 * in the local time of the place it happens, so a London trip booked from
	 * Rome runs on Europe/London -- and used to run an hour out because this
	 * defaulted to whatever zone the phone was in.
	 */
	let timezone = $state(localZone());
	let timezoneTouched = $state(false);
	let terminals = $state<Terminals>(noTerminals());

	const titles = ['Where are you going?', 'Getting in', 'Getting out'];

	const canAdvance = $derived(
		step === 1
			? city !== null && hotel !== null
			: step === 2
				? arrivalAt !== ''
				: true
	);

	/** The trip is only a trip once it has both ends. */
	const canSave = $derived(
		city !== null && hotel !== null && arrivalAt !== '' && departureAt !== '' && departureAt > arrivalAt
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
				countryCode: city!.countryCode,
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
					// Unless they have set one by hand, in which case they know
					// something the map does not.
					if (!timezoneTouched) timezone = zoneAt(c.lat, c.lng) ?? timezone;
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
		<!-- The way in, and when it gets there. A journey and the moment it
		     lands are one thing, and asking for them in two places is how a
		     trip ends up with a flight at one time and a day starting at
		     another. -->
		<div class="tm-field mb-5">
			<label class="tm-label" for="arr">You arrive</label>
			<input class="tm-input" id="arr" type="datetime-local" bind:value={arrivalAt} />
			<span class="tm-hint">Local to {timezone}. The first day starts here.</span>
		</div>

		<div class="mb-5"><CheckIn bind:terminals /></div>

		<div style="border-top: 1px solid var(--tm-border); padding-top: 1rem">
			<JourneySide direction="arrival" bind:terminals {city} />
		</div>
	{:else}
		<div class="tm-field mb-5">
			<label class="tm-label" for="dep">You leave</label>
			<input class="tm-input" id="dep" type="datetime-local" bind:value={departureAt} />
			<span class="tm-hint">The last day ends in time for it.</span>
		</div>

		<div class="tm-field mb-5">
			<label class="tm-label" for="tz">Timezone</label>
			<input
				class="tm-input"
				id="tz"
				bind:value={timezone}
				oninput={() => (timezoneTouched = true)}
			/>
			<span class="tm-hint">Times are local to the city you're visiting.</span>
		</div>

		<div style="border-top: 1px solid var(--tm-border); padding-top: 1rem">
			<JourneySide direction="departure" bind:terminals {city} />
		</div>

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
				<button class="tm-btn tm-btn--primary flex-1" disabled={saving || !canSave} onclick={save}>
					{saving ? 'Saving…' : 'Save trip'}
				</button>
			{/if}
		</div>
	</div>
</main>
