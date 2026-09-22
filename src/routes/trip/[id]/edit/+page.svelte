<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { base } from '$app/paths';
	import { goto } from '$app/navigation';
	import {
		cityBBox,
		deleteTrip,
		getTrip,
		noTerminals,
		terminalsOf,
		updateCityBBox,
		updateTrip,
		type Terminals,
		type TripRow
	} from '$lib/trip/repo';
	import TerminalFields from '$lib/TerminalFields.svelte';
	import CheckIn from '$lib/CheckIn.svelte';
	import { fromLocalInput, toLocalInput } from '$lib/trip/days';
	import { poi as provider, type City } from '$lib/poi';
	import Autocomplete from '$lib/Autocomplete.svelte';

	const tripId = page.params.id!;
	const MODES = ['walk', 'bike', 'transit', 'car', 'carshare'] as const;

	let row = $state<TripRow | null>(null);
	let loading = $state(true);
	let saving = $state(false);
	let error = $state<string | null>(null);
	let confirmDelete = $state(false);

	let cityName = $state('');
	let timezone = $state('');
	let hotelName = $state('');
	let hotelLat = $state(0);
	let hotelLng = $state(0);
	let arrival = $state('');
	let departure = $state('');
	let modes = $state<string[]>([]);
	let dayStart = $state('09:00');
	let dayEnd = $state('19:00');
	let bbox = $state<ReturnType<typeof cityBBox>>(null);
	let terminals = $state<Terminals>(noTerminals());

	onMount(async () => {
		try {
			row = await getTrip(tripId);
			if (!row) return;
			cityName = row.city;
			timezone = row.timezone;
			hotelName = row.hotel_name;
			hotelLat = row.hotel_lat;
			hotelLng = row.hotel_lng;
			arrival = toLocalInput(row.arrival_at, row.timezone);
			departure = toLocalInput(row.departure_at, row.timezone);
			modes = [...(row.allowed_modes ?? [])];
			dayStart = row.day_start.slice(0, 5);
			dayEnd = row.day_end.slice(0, 5);
			bbox = cityBBox(row);
			terminals = terminalsOf(row);
		} catch (e) {
			error = (e as Error).message;
		} finally {
			loading = false;
		}
	});

	const city = $derived<City | null>(
		row ? { name: cityName, label: cityName, lat: 0, lng: 0, countryCode: null, bbox } : null
	);

	const valid = $derived(
		cityName.trim() !== '' &&
			hotelName.trim() !== '' &&
			arrival !== '' &&
			departure !== '' &&
			departure > arrival &&
			modes.length > 0
	);

	function toggleMode(m: string) {
		modes = modes.includes(m) ? modes.filter((x) => x !== m) : [...modes, m];
	}

	async function save() {
		saving = true;
		error = null;
		try {
			await updateTrip(tripId, {
				city: cityName,
				timezone,
				hotelName,
				hotelLat,
				hotelLng,
				// Read in the trip's own zone, so editing from another country does
				// not silently shift the flights.
				arrivalAt: fromLocalInput(arrival, timezone),
				departureAt: fromLocalInput(departure, timezone),
				allowedModes: modes,
				dayStart,
				dayEnd,
				terminals
			});
			if (bbox) await updateCityBBox(tripId, bbox);
			await goto(`${base}/trip/${tripId}`, { replaceState: true });
		} catch (e) {
			error = (e as Error).message;
			saving = false;
		}
	}

	async function destroy() {
		try {
			await deleteTrip(tripId);
			await goto(`${base}/`, { replaceState: true });
		} catch (e) {
			error = (e as Error).message;
		}
	}
</script>

<main class="mx-auto max-w-lg px-6 pb-28">
	<header class="tm-safe-top mb-6 flex items-baseline justify-between">
		<a href="{base}/trip/{tripId}" class="tm-attrib" style="text-decoration: none">← Trip</a>
		<h1 style="font: 700 var(--tm-text-xl)/1.15 var(--tm-font)">Edit trip</h1>
	</header>

	{#if loading}
		<p style="color: var(--tm-text-faint)">Loading…</p>
	{:else if !row}
		<p class="tm-hint tm-hint--error">Trip not found.</p>
	{:else}
		<div class="mb-5">
			<Autocomplete
				label="City"
				placeholder={cityName}
				hint="Currently {cityName}. Leave alone to keep it."
				search={(q, signal) => provider.searchCities(q, signal)}
				onpick={(c) => {
					cityName = c.name;
					bbox = c.bbox;
					// A hotel from the old city is meaningless in the new one.
					hotelName = '';
					hotelLat = 0;
					hotelLng = 0;
				}}
			/>
		</div>

		<div class="mb-5">
			<Autocomplete
				label="Hotel"
				placeholder={hotelName || 'Search hotels'}
				hint={hotelName ? `Currently ${hotelName}.` : 'Pick a hotel.'}
				search={(q, signal) => provider.searchHotels(q, city!, signal)}
				onpick={(h) => {
					hotelName = h.name;
					hotelLat = h.lat;
					hotelLng = h.lng;
				}}
			/>
		</div>

		<div class="mb-5"><CheckIn bind:terminals /></div>

		<div class="mb-5 flex gap-3">
			<div class="tm-field flex-1">
				<label class="tm-label" for="ds">Day starts</label>
				<input class="tm-input" id="ds" type="time" bind:value={dayStart} />
			</div>
			<div class="tm-field flex-1">
				<label class="tm-label" for="de">Day ends</label>
				<input class="tm-input" id="de" type="time" bind:value={dayEnd} />
			</div>
		</div>

		<div class="tm-field mb-5">
			<label class="tm-label" for="arr">Arrival</label>
			<input class="tm-input" id="arr" type="datetime-local" bind:value={arrival} />
		</div>
		<div class="tm-field mb-5">
			<label class="tm-label" for="dep">Departure</label>
			<input class="tm-input" id="dep" type="datetime-local" bind:value={departure} />
			<span class="tm-hint">Times are local to {timezone}.</span>
		</div>

		<div class="tm-field mb-5">
			<label class="tm-label" for="tz">Timezone</label>
			<input class="tm-input" id="tz" bind:value={timezone} />
		</div>

		<p class="tm-label mb-2">Getting around</p>
		<div class="mb-5 flex flex-wrap gap-2">
			{#each MODES as m}
				<button
					class="tm-chip"
					aria-pressed={modes.includes(m)}
					style={modes.includes(m)
						? 'background: var(--tm-peach-soft); color: var(--tm-peach-ink)'
						: 'opacity: 0.6'}
					onclick={() => toggleMode(m)}
				>
					{m}
				</button>
			{/each}
		</div>

		<div class="mb-5" style="border-top: 1px solid var(--tm-border); padding-top: 1rem">
			<TerminalFields bind:terminals {city} />
		</div>

		{#if error}<p class="tm-hint tm-hint--error mb-3">{error}</p>{/if}

		<button class="tm-btn tm-btn--primary tm-btn--block" disabled={!valid || saving} onclick={save}>
			{saving ? 'Saving…' : 'Save changes'}
		</button>

		<div class="mt-10" style="border-top: 1px solid var(--tm-border); padding-top: 1rem">
			{#if confirmDelete}
				<p class="tm-hint mb-2">
					This removes the trip and every place in it. It cannot be undone.
				</p>
				<div class="flex gap-2">
					<button class="tm-btn tm-btn--secondary flex-1" onclick={() => (confirmDelete = false)}>
						Keep it
					</button>
					<button
						class="tm-btn flex-1"
						style="background: var(--tm-danger-ink); color: var(--tm-surface)"
						onclick={destroy}
					>
						Delete trip
					</button>
				</div>
			{:else}
				<button class="tm-btn tm-btn--ghost" style="color: var(--tm-danger-ink)" onclick={() => (confirmDelete = true)}>
					Delete this trip
				</button>
			{/if}
		</div>
	{/if}
</main>
