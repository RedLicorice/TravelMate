<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { mutate, pullTrip, store } from '$lib/store/store.svelte';
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
		type Terminals
	} from '$lib/trip/repo';
	import JourneySide from '$lib/JourneySide.svelte';
	import CheckIn from '$lib/CheckIn.svelte';
	import { fromLocalInput, toLocalInput } from '$lib/trip/days';
	import { poi as provider, type City } from '$lib/poi';
	import Autocomplete from '$lib/Autocomplete.svelte';

	const tripId = page.params.id!;
	const MODES = ['walk', 'bike', 'transit', 'car', 'carshare'] as const;

	const row = $derived(getTrip(tripId));
	/** Not on this device, and the server not yet asked. */
	const loading = $derived(!row && !store.asked.includes(tripId));
	let saving = $state(false);
	let error = $state<string | null>(null);
	let confirmDelete = $state(false);
	/** Which of the three the traveller is looking at. */
	let tab = $state<'city' | 'in' | 'out'>('city');

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

	// The form is filled once, from the trip as it first reads. After that it
	// is the traveller's draft, and an edit arriving from someone else does
	// not overwrite what they are typing.
	let filled = false;
	$effect(() => {
		if (filled || !row) return;
		filled = true;
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
	});

	onMount(() => {
		if (!row) pullTrip(tripId).catch((e) => (error = (e as Error).message));
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

	/**
	 * Which days this edit changes, for the trip page to re-time when it
	 * opens: the journey in shapes the first day, the journey out the last,
	 * and the city, hotel, dates, hours and ways of getting about every day.
	 * Nothing, when nothing changed.
	 */
	function touched(): string | null {
		if (!row) return null;
		const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
		const was = terminalsOf(row);
		const whole =
			cityName !== row.city ||
			timezone !== row.timezone ||
			hotelName !== row.hotel_name ||
			hotelLat !== row.hotel_lat ||
			hotelLng !== row.hotel_lng ||
			Date.parse(fromLocalInput(arrival, timezone)) !== Date.parse(row.arrival_at) ||
			Date.parse(fromLocalInput(departure, timezone)) !== Date.parse(row.departure_at) ||
			!same(modes, row.allowed_modes ?? []) ||
			dayStart !== row.day_start.slice(0, 5) ||
			dayEnd !== row.day_end.slice(0, 5);
		if (whole) return 'all';
		const side = (prefix: 'arrival' | 'departure') =>
			(Object.keys(was) as (keyof Terminals)[])
				.filter((k) => k.startsWith(prefix))
				.some((k) => !same(was[k], terminals[k]));
		const days = [side('arrival') ? 'first' : null, side('departure') ? 'last' : null].filter(Boolean);
		return days.length ? days.join(',') : null;
	}

	async function save() {
		saving = true;
		error = null;
		const changed = touched();
		try {
			await mutate('Edited the trip', tripId, (w) => {
				updateTrip(w, tripId, {
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
				if (bbox) updateCityBBox(w, tripId, bbox);
			});
			await goto(`${base}/trip/${tripId}${changed ? `?retime=${changed}` : ''}`, { replaceState: true });
		} catch (e) {
			error = (e as Error).message;
			saving = false;
		}
	}

	async function destroy() {
		try {
			await mutate('Deleted the trip', tripId, (w) => deleteTrip(w, tripId));
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
		<div class="tm-field" style="opacity:0.4"><span class="tm-label">&nbsp;</span></div>
	{:else if !row}
		<p class="tm-hint tm-hint--error">Trip not found.</p>
	{:else}
		<!-- Three things, kept apart. The city and the hotel are what the trip
		     is; the two journeys are each planned at their own time, for their
		     own reasons, and neither belongs in a list with the other. -->
		<div class="tm-seg mb-5" role="tablist" aria-label="What to edit">
			<button role="tab" aria-selected={tab === 'city'} onclick={() => (tab = 'city')}>
				City &amp; hotel
			</button>
			<button role="tab" aria-selected={tab === 'in'} onclick={() => (tab = 'in')}>
				Arrival
			</button>
			<button role="tab" aria-selected={tab === 'out'} onclick={() => (tab = 'out')}>
				Departure
			</button>
		</div>

		{#if tab === 'city'}
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

		{:else if tab === 'in'}
			<JourneySide direction="arrival" bind:terminals {city} />
		{:else}
			<JourneySide direction="departure" bind:terminals {city} />
		{/if}

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
