<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { base } from '$app/paths';
	import { cityBBox, getTrip, updateCityBBox, type TripRow } from '$lib/trip/repo';
	import { addPoi, DuplicatePoiError, listPois, type PoiRow } from '$lib/trip/pois';
	import { listPlacements, place, savePlacements, type PlacementRow } from '$lib/trip/placements';
	import { insertInto } from '$lib/dnd.svelte';
	import { goto } from '$app/navigation';
	import { poi as provider, type City, type Poi } from '$lib/poi';
	import { durationFor } from '$lib/poi/photon';
	import { isShortMapLink, parseLatLng } from '$lib/poi/manual';
	import { branchesOf } from '$lib/poi/branches';
	import Autocomplete from '$lib/Autocomplete.svelte';
	import { haversineKm } from '$lib/plan/geo';
	import TripMap from '$lib/GoogleMap.svelte';

	const tripId = page.params.id!;

	/**
	 * Reached from a slot in the plan rather than from the Add places button.
	 * `day` is the day to land on; `before` is the placement to land above,
	 * absent meaning the end of that day.
	 *
	 * A slot is a single choice, so this adds one place and goes straight back
	 * -- the multi-add flow is for filling a wishlist, which is a different job.
	 */
	const slot = $derived.by(() => {
		const day = Number(page.url.searchParams.get('day'));
		if (!page.url.searchParams.has('day') || !Number.isInteger(day) || day < 0) return null;
		return { day, before: page.url.searchParams.get('before') };
	});

	let trip = $state<TripRow | null>(null);
	let saved = $state<PoiRow[]>([]);
	let placements = $state<PlacementRow[]>([]);
	let results = $state<Poi[]>([]);
	let query = $state('');
	let view = $state<'list' | 'map' | 'custom'>('list');
	let status = $state<'idle' | 'searching' | 'done'>('idle');
	let error = $state<string | null>(null);
	let selectedId = $state<string | null>(null);
	let justAdded = $state<string | null>(null);

	let timer: ReturnType<typeof setTimeout>;
	let inflight: AbortController | null = null;

	let bbox = $state<ReturnType<typeof cityBBox>>(null);

	onMount(async () => {
		try {
			[trip, saved, placements] = await Promise.all([
				getTrip(tripId),
				listPois(tripId),
				listPlacements(tripId)
			]);
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
		// Carried from the slot sheet. Run it once the city box is known, or
		// the search would be unbounded and answer with another country.
		if (query.trim()) onInput();
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

	/**
	 * Already on the wishlist? Matched on OSM id when both have one, since the
	 * same place can come back with slightly different coordinates from a
	 * different query. Coordinates are the fallback for hand-added stops.
	 */
	const matches = (p: Poi) => (s: PoiRow) =>
		s.osm_id && p.osmId
			? s.osm_id === p.osmId
			: Math.abs(s.lat - p.lat) < 1e-6 && Math.abs(s.lng - p.lng) < 1e-6;

	const onWishlist = (p: Poi) => saved.find(matches(p)) ?? null;

	/** How many days this place is already on. */
	const timesPlanned = (p: Poi) => {
		const row = onWishlist(p);
		return row ? placements.filter((x) => x.poi_id === row.id).length : 0;
	};

	/**
	 * A wishlist has each place once, so from the Add places button a place
	 * already on it has nothing left to do. From a slot there is always more to
	 * do: the same cafe on Tuesday and Thursday is two visits, not a double tap.
	 */
	const canAdd = (p: Poi) => slot !== null || !onWishlist(p);

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

	// ---- adding a place the provider has never heard of ----
	const CATEGORIES = [
		['activity', 'Activity'],
		['attraction', 'Attraction'],
		['museum', 'Museum'],
		['gallery', 'Gallery'],
		['viewpoint', 'Viewpoint'],
		['park', 'Park'],
		['restaurant', 'Restaurant'],
		['cafe', 'Cafe'],
		['bar', 'Bar'],
		['marketplace', 'Market'],
		['theatre', 'Theatre']
	] as const;

	let customName = $state('');
	let customCategory = $state<string>('attraction');
	let customPoint = $state<{ lat: number; lng: number } | null>(null);
	let customContext = $state<string | null>(null);
	let pasted = $state('');
	let pasteError = $state<string | null>(null);

	const customDuration = $derived(durationFor(customCategory));

	async function locate(point: { lat: number; lng: number }, fallbackName?: string) {
		customPoint = point;
		customContext = null;
		try {
			// Reverse geocode purely for context: it tells the traveller which
			// street the pin landed on, which is how they know it is the right
			// one. The name stays theirs.
			const nearby = await provider.reverse(point.lat, point.lng);
			customContext = nearby?.label ?? null;
			if (!customName && fallbackName) customName = fallbackName;
		} catch {
			// Context is a nicety; a pin with no address is still a pin.
		}
	}

	function usePasted() {
		pasteError = null;
		const point = parseLatLng(pasted);
		if (point) {
			locate(point);
			return;
		}
		pasteError = isShortMapLink(pasted)
			? 'Short map links cannot be opened from here. Open it once, then paste the full address bar, or paste the coordinates.'
			: 'No coordinates in that. Paste a full map link, or something like 51.5109, -0.1395.';
	}

	async function addCustom() {
		if (!customPoint || !customName.trim()) return;
		await add({
			name: customName.trim(),
			label: customContext ?? '',
			lat: customPoint.lat,
			lng: customPoint.lng,
			category: customCategory,
			durationMin: customDuration,
			openingHours: null,
			website: null,
			phone: null,
			// No osm_id: this is not an OSM place, and the per-trip uniqueness
			// index only covers rows that have one.
			osmId: null
		});
		customName = '';
		customPoint = null;
		customContext = null;
		pasted = '';
		view = 'list';
	}

	function clearSearch() {
		clearTimeout(timer);
		inflight?.abort();
		query = '';
		results = [];
		selectedId = null;
		status = 'idle';
	}

	/**
	 * A place the search found more than one of. Asked about once, because only
	 * the traveller knows whether they meant the chain or that shop: "a Pret"
	 * and "the Tate Modern" look identical from here.
	 */
	let chain = $state<{ pick: Poi; branches: { lat: number; lng: number }[] } | null>(null);

	function offer(p: Poi) {
		if (!canAdd(p)) return;
		const branches = branchesOf(p, results);
		if (branches.length > 1) chain = { pick: p, branches };
		else void add(p);
	}

	/**
	 * Read the choice out before clearing it. Clearing first and reading after
	 * leaves the template evaluating `chain.pick` on a null, because a {@const}
	 * is a derived and re-runs before the block that holds it is torn down.
	 */
	function chose(everyBranch: boolean) {
		const chosen = chain;
		if (!chosen) return;
		chain = null;
		void add(everyBranch ? { ...chosen.pick, branches: chosen.branches } : chosen.pick);
	}

	/**
	 * The wishlist row for this place, made if it is not there yet. The index
	 * catches what the UI check missed -- two taps in quick succession, or a
	 * teammate adding the same place a moment ago -- and that is not an error
	 * here, it is the row we wanted: refresh and use it.
	 */
	async function wishlistRow(p: Poi): Promise<PoiRow> {
		const existing = onWishlist(p);
		if (existing) return existing;
		try {
			const row = await addPoi(tripId, p);
			saved = [...saved, row];
			return row;
		} catch (e) {
			if (!(e instanceof DuplicatePoiError)) throw e;
			saved = await listPois(tripId);
			const row = onWishlist(p);
			if (!row) throw e;
			return row;
		}
	}

	async function add(p: Poi) {
		if (!canAdd(p)) return;
		try {
			const row = await wishlistRow(p);

			if (slot) {
				// Put it in the slot it was asked for, then hand the trip page
				// back the day it landed on so it opens there. The new visit is
				// slotted among the day's existing ones with the same arithmetic
				// a drop uses, so the two cannot disagree about where "above"
				// is; `before` still names a place on the trip page for now, so
				// a placement of that place is accepted too.
				const NEW = 'new';
				const before =
					placements.find((x) => x.id === slot.before || x.poi_id === slot.before)?.id ?? null;
				const rows = insertInto(
					[
						...placements.map((x) => ({ id: x.id, dayIndex: x.day_index, orderIndex: x.order_index })),
						{ id: NEW, dayIndex: null, orderIndex: null }
					],
					NEW,
					slot.day,
					before
				);
				const poiOf = new Map(placements.map((x) => [x.id, x.poi_id]));
				// Back to the day at once. The visit is written on the way out
				// -- the trip page reads the placements when it opens, and by
				// then this has landed; a failure surfaces there rather than
				// holding a screen the traveller has finished with.
				const writing = place(
					tripId,
					row.id,
					slot.day,
					rows.find((r) => r.id === NEW)!.orderIndex
				).then(() =>
					savePlacements(
						tripId,
						rows.filter((r) => r.id !== NEW).map((r) => ({ ...r, poiId: poiOf.get(r.id)! }))
					)
				);
				await goto(`${base}/trip/${tripId}?day=${slot.day}`, { replaceState: true });
				await writing;
				return;
			}

			justAdded = p.name;
			setTimeout(() => (justAdded = null), 1600);
			// Clear after adding: the next place is a new search, and leaving the
			// old query up invites adding its neighbours by accident.
			clearSearch();
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
			.filter(canAdd)
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
		selectedId?.startsWith('result:') ? results.filter(canAdd)[Number(selectedId.split(':')[1])] : null
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
			<button role="tab" aria-selected={view === 'list'} onclick={() => (view = 'list')}>Search</button>
			<button role="tab" aria-selected={view === 'map'} onclick={() => (view = 'map')}>Map</button>
			<button role="tab" aria-selected={view === 'custom'} onclick={() => (view = 'custom')}>Custom</button>
		</div>

		<div class="tm-search">
			<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
				<circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" />
			</svg>
			<input bind:value={query} oninput={onInput} placeholder="Museums, parks, a name…" aria-label="Search places" />
			{#if query}
				<button
					onclick={clearSearch}
					aria-label="Clear search"
					style="background:none;border:none;cursor:pointer;color:var(--tm-text-faint);font-size:18px;line-height:1;padding:0 2px"
				>
					×
				</button>
			{/if}
		</div>

		{#if error}
			<p class="tm-hint tm-hint--error">{error}</p>
		{:else if justAdded}
			<p class="tm-hint" style="color: var(--tm-ok-ink)">Added {justAdded} to the wishlist.</p>
		{/if}
	</div>

	{#if view === 'list'}
		<div class="flex-1 overflow-y-auto px-4">
			{#if status === 'searching'}
				<p class="tm-hint py-3">Searching…</p>
			{:else if status === 'done' && results.length === 0}
				<p class="tm-hint py-3">Nothing found near {trip?.city}.</p>
			{/if}

			{#each results as r (r.name + r.lat + r.lng)}
				{@const times = timesPlanned(r)}
				<div class="tm-result">
					<div>
						<p class="tm-result__name">
							{r.name}{#if times > 1}<span class="tm-count">&times;{times}</span>{/if}
						</p>
						<p class="tm-result__meta">
							{r.category ?? 'place'} · {kmFromHotel(r)} km · {r.durationMin} min
							{#if onWishlist(r)} · on the wishlist{/if}
						</p>
					</div>
					{#if !canAdd(r)}
						<!-- Shown rather than hidden: a place vanishing from results reads
						     as a search bug, not as "you already have this". -->
						<button class="tm-add" aria-pressed="true" aria-label="Already on the wishlist" disabled>
							✓
						</button>
					{:else}
						<button
							class="tm-add"
							aria-label={slot ? `Add ${r.name} to this day${times ? ' again' : ''}` : `Add ${r.name}`}
							onclick={() => offer(r)}>+</button
						>
					{/if}
				</div>
			{/each}

		</div>
	{:else if view === 'map' && trip}
		<div class="relative flex-1">
			<TripMap
				{markers}
				center={centre}
				onselect={(id) => (selectedId = id)}
				onlongpress={(point) => {
					locate(point);
					view = 'custom';
				}}
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
					{#if !canAdd(selected)}
						<button class="tm-btn tm-btn--secondary tm-btn--block" disabled>Already on the wishlist</button>
					{:else}
						<button
							class="tm-btn tm-btn--primary tm-btn--block"
							onclick={() => {
								offer(selected!);
								selectedId = null;
							}}
						>
							{slot ? (timesPlanned(selected) ? 'Add to this day again' : 'Add to this day') : 'Add to wishlist'}
						</button>
					{/if}
				</div>
			{/if}
		</div>
	{/if}

	{#if view === 'custom'}
		<div class="flex-1 overflow-y-auto px-4 pb-4">
			<p class="tm-hint mb-4">
				Some places are not in OpenStreetMap, or are still listed under the name of whoever had
				the building last. Put those in by hand.
			</p>

			<div class="tm-field mb-4">
				<label class="tm-label" for="cname">What is it called?</label>
				<input class="tm-input" id="cname" bind:value={customName} placeholder="The Starman" />
			</div>

			<p class="tm-label mb-2">Where is it?</p>

			{#if city}
				<Autocomplete
					label="By address"
					placeholder="15 Heddon Street, London"
					hint="Street and number, not just the name."
					search={(q, signal) => provider.searchAddresses(q, city!, signal)}
					onpick={(hit) => locate({ lat: hit.lat, lng: hit.lng }, customName || hit.name)}
				/>
			{/if}

			<div class="tm-field mt-4">
				<label class="tm-label" for="paste">Or paste a map link</label>
				<input
					class="tm-input"
					id="paste"
					bind:value={pasted}
					oninput={() => (pasteError = null)}
					placeholder="Map link, or 51.5109, -0.1395"
				/>
				{#if pasteError}<span class="tm-hint tm-hint--error">{pasteError}</span>{/if}
				<button class="tm-btn tm-btn--secondary mt-2" disabled={!pasted.trim()} onclick={usePasted}>
					Use this location
				</button>
			</div>

			<p class="tm-hint mt-3">Or switch to the map and hold your finger on the spot.</p>

			{#if customPoint}
				<div class="tm-card mt-4" style="background: var(--tm-ok-soft); border-color: transparent">
					<p class="tm-card__title" style="color: var(--tm-ok-ink)">Location set</p>
					<p class="tm-card__meta" style="color: var(--tm-ok-ink)">
						{customContext ?? `${customPoint.lat.toFixed(5)}, ${customPoint.lng.toFixed(5)}`}
					</p>
				</div>
			{/if}

			<p class="tm-label mt-5 mb-2">What kind of place?</p>
			<div class="flex flex-wrap gap-2">
				{#each CATEGORIES as [value, label]}
					<button
						class="tm-chip"
						aria-pressed={customCategory === value}
						style={customCategory === value
							? 'background: var(--tm-peach-soft); color: var(--tm-peach-ink)'
							: 'opacity: 0.6'}
						onclick={() => (customCategory = value)}
					>
						{label}
					</button>
				{/each}
			</div>
			<p class="tm-hint mt-2">
				Sets how long to allow ({customDuration} min) and when it is usually busy. Both editable
				later.
			</p>

			<button
				class="tm-btn tm-btn--primary tm-btn--block mt-5"
				disabled={!customPoint || !customName.trim()}
				onclick={addCustom}
			>
				{slot ? 'Add to this day' : 'Add to wishlist'}
			</button>
		</div>
	{/if}

	{#if chain}
		<div
			role="presentation"
			style="position:fixed;inset:0;z-index:60;background:rgba(0,0,0,0.35)"
			onclick={() => (chain = null)}
		></div>
		<div class="tm-sheet" style="position:fixed;z-index:61">
			<div class="tm-sheet__grip"></div>
			<p class="tm-card__title">{chain.pick.name}</p>
			<p class="tm-card__meta">
				There are {chain.branches.length} of these in {trip?.city ?? 'the city'}. Which did you
				mean?
			</p>
			<button class="tm-btn tm-btn--primary tm-btn--block mt-3" onclick={() => chose(true)}>
				Any {chain.pick.name}
			</button>
			<p class="tm-hint mt-1">Whichever is nearest to wherever the day has you.</p>
			<button class="tm-btn tm-btn--secondary tm-btn--block mt-3" onclick={() => chose(false)}>
				Just this one
			</button>
			<p class="tm-hint mt-1">{chain.pick.label}</p>
		</div>
	{/if}

	<div class="flex items-center justify-between px-4 py-3" style="border-top: 1px solid var(--tm-border)">
		<a href="{base}/trip/{tripId}" class="tm-chip tm-chip--peach" style="text-decoration: none">
			{saved.length} in wishlist
		</a>
		<span class="tm-attrib">{provider.attribution}</span>
	</div>
</main>
