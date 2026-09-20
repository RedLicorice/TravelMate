<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { base } from '$app/paths';
	import { cityBBox, getTrip, updateCityBBox, type TripRow } from '$lib/trip/repo';
	import { addPoi, listPois, removePoi, type PoiRow } from '$lib/trip/pois';
	import { poi as provider, type City, type Poi } from '$lib/poi';
	import { haversineKm } from '$lib/plan/geo';
	import LeafletMap from '$lib/Map.svelte';

	const tripId = page.params.id!;

	let trip = $state<TripRow | null>(null);
	let saved = $state<PoiRow[]>([]);
	let results = $state<Poi[]>([]);
	let query = $state('');
	let view = $state<'list' | 'map'>('list');
	let status = $state<'idle' | 'searching' | 'done'>('idle');
	let error = $state<string | null>(null);
	let selectedId = $state<string | null>(null);

	let timer: ReturnType<typeof setTimeout>;
	let inflight: AbortController | null = null;

	let bbox = $state<ReturnType<typeof cityBBox>>(null);

	onMount(async () => {
		try {
			[trip, saved] = await Promise.all([getTrip(tripId), listPois(tripId)]);
			if (!trip) return;
			bbox = cityBBox(trip);
			if (!bbox) {
				// Trip saved before the city box was captured. Geocode the city
				// name once and store it, rather than re-resolving on every visit.
				const [match] = await provider.searchCities(trip.city);
				if (match?.bbox) {
					bbox = match.bbox;
					await updateCityBBox(tripId, match.bbox);
				}
			}
		} catch (e) {
			error = (e as Error).message;
		}
	});

	// Bounded by the city's own box, not a guess drawn around the hotel: a wrong
	// hotel coordinate would otherwise send the search to the wrong ocean.
	const city = $derived<City | null>(
		trip
			? {
					name: trip.city,
					label: trip.city,
					lat: trip.hotel_lat,
					lng: trip.hotel_lng,
					countryCode: null,
					bbox
				}
			: null
	);

	// Centre on the hotel unless it is Null Island, in which case use the city.
	const centre = $derived(
		trip && (trip.hotel_lat !== 0 || trip.hotel_lng !== 0)
			? { lat: trip.hotel_lat, lng: trip.hotel_lng }
			: bbox
				? { lat: (bbox.south + bbox.north) / 2, lng: (bbox.west + bbox.east) / 2 }
				: { lat: 51.5074, lng: -0.1278 }
	);

	const isSaved = (p: Poi) =>
		saved.some((s) => Math.abs(s.lat - p.lat) < 1e-6 && Math.abs(s.lng - p.lng) < 1e-6);

	const kmFromHotel = (p: { lat: number; lng: number }) =>
		trip ? haversineKm({ lat: trip.hotel_lat, lng: trip.hotel_lng }, p).toFixed(1) : '?';

	function onInput() {
		clearTimeout(timer);
		inflight?.abort();
		error = null;
		if (query.trim().length < 2 || !city) {
			results = [];
			status = 'idle';
			return;
		}
		status = 'searching';
		timer = setTimeout(async () => {
			const controller = new AbortController();
			inflight = controller;
			try {
				results = await provider.searchPlaces(query.trim(), city, controller.signal);
				status = 'done';
			} catch (e) {
				if ((e as Error).name === 'AbortError') return;
				error = (e as Error).message;
				status = 'done';
			}
		}, 250);
	}

	async function add(p: Poi) {
		try {
			saved = [...saved, await addPoi(tripId, p)];
		} catch (e) {
			error = (e as Error).message;
		}
	}

	async function drop(row: PoiRow) {
		try {
			await removePoi(row.id);
			saved = saved.filter((s) => s.id !== row.id);
		} catch (e) {
			error = (e as Error).message;
		}
	}

	const markers = $derived([
		...(trip && (trip.hotel_lat !== 0 || trip.hotel_lng !== 0)
			? [{ id: 'hotel', lat: trip.hotel_lat, lng: trip.hotel_lng, color: 'var(--tm-text)', glyph: 'H' }]
			: []),
		...saved.map((s) => ({
			id: `saved:${s.id}`,
			lat: s.lat,
			lng: s.lng,
			color: 'var(--tm-ok)',
			glyph: '✓'
		})),
		...results
			.filter((r) => !isSaved(r))
			.map((r, i) => ({
				id: `result:${i}`,
				lat: r.lat,
				lng: r.lng,
				color: 'var(--tm-primary)',
				glyph: '★',
				selected: selectedId === `result:${i}`
			}))
	]);

	const selected = $derived(
		selectedId?.startsWith('result:') ? results.filter((r) => !isSaved(r))[Number(selectedId.split(':')[1])] : null
	);
</script>

<main class="flex h-dvh flex-col">
	<div class="flex flex-col gap-3 p-4" style="border-bottom: 1px solid var(--tm-border)">
		<div class="flex items-center justify-between">
			<h1 style="font: 700 var(--tm-text-xl)/1.15 var(--tm-font)">Add places</h1>
			<a href="{base}/trip/{tripId}" class="tm-btn tm-btn--ghost" style="min-height:auto;padding:0">
				Done
			</a>
		</div>

		<div class="tm-seg" role="tablist" aria-label="View">
			<button role="tab" aria-selected={view === 'list'} onclick={() => (view = 'list')}>List</button>
			<button role="tab" aria-selected={view === 'map'} onclick={() => (view = 'map')}>Map</button>
		</div>

		<div class="tm-search">
			<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
				<circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" />
			</svg>
			<input bind:value={query} oninput={onInput} placeholder="Museums, parks, a name…" aria-label="Search places" />
		</div>

		{#if error}<p class="tm-hint tm-hint--error">{error}</p>{/if}
	</div>

	{#if view === 'list'}
		<div class="flex-1 overflow-y-auto px-4">
			{#if status === 'searching'}
				<p class="tm-hint py-3">Searching…</p>
			{:else if status === 'done' && results.length === 0}
				<p class="tm-hint py-3">Nothing found near {trip?.city}.</p>
			{/if}

			{#each results as r (r.name + r.lat + r.lng)}
				<div class="tm-result">
					<div>
						<p class="tm-result__name">{r.name}</p>
						<p class="tm-result__meta">
							{r.category ?? 'place'} · {kmFromHotel(r)} km · {r.durationMin} min
						</p>
					</div>
					{#if isSaved(r)}
						<button class="tm-add" aria-pressed="true" aria-label="Added" disabled>✓</button>
					{:else}
						<button class="tm-add" aria-label="Add {r.name}" onclick={() => add(r)}>+</button>
					{/if}
				</div>
			{/each}

			{#if saved.length}
				<p class="sec mt-5 mb-1" style="font: 600 var(--tm-text-xs)/1 var(--tm-font); letter-spacing:.1em; text-transform:uppercase; color: var(--tm-text-faint)">
					In this trip
				</p>
				{#each saved as s (s.id)}
					<div class="tm-result">
						<div>
							<p class="tm-result__name">{s.name}</p>
							<p class="tm-result__meta">{s.category ?? 'place'} · {s.duration_min} min</p>
						</div>
						<button class="tm-add" aria-label="Remove {s.name}" onclick={() => drop(s)}>−</button>
					</div>
				{/each}
			{/if}
		</div>
	{:else if trip}
		<div class="relative flex-1">
			<LeafletMap
				{markers}
				center={centre}
				onselect={(id) => (selectedId = id)}
			/>
			{#if selected}
				<div class="tm-sheet">
					<div class="tm-sheet__grip"></div>
					<p style="font: 700 var(--tm-text-lg)/1.2 var(--tm-font)">{selected.name}</p>
					<p class="tm-result__meta">{selected.category ?? 'place'} · {kmFromHotel(selected)} km from hotel</p>
					<div class="my-3 flex gap-2">
						<span class="tm-chip tm-chip--peach">{selected.durationMin} min</span>
						{#if selected.openingHours}<span class="tm-chip">{selected.openingHours}</span>{/if}
					</div>
					<button class="tm-btn tm-btn--primary tm-btn--block" onclick={() => { add(selected!); selectedId = null; }}>
						Add to trip
					</button>
				</div>
			{/if}
		</div>
	{/if}

	<div class="flex items-center justify-between px-4 py-3" style="border-top: 1px solid var(--tm-border)">
		<span class="tm-chip tm-chip--peach">{saved.length} in wishlist</span>
		<span class="tm-attrib">{provider.attribution}</span>
	</div>
</main>
