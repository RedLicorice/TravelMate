<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { base } from '$app/paths';
	import {
		cityBBox,
		getTrip,
		hotelMissing,
		toTrip,
		updateCityBBox,
		updateHotel,
		type TripRow
	} from '$lib/trip/repo';
	import Autocomplete from '$lib/Autocomplete.svelte';
	import { poi as provider, type City } from '$lib/poi';
	import { listPois, saveAssignments, toPlanPoi, type PoiRow } from '$lib/trip/pois';
	import { tripDays, type Day } from '$lib/trip/days';
	import { replan, schedule, type PlanResult } from '$lib/plan/planner';
	import type { Mode } from '$lib/plan/modes';
	import Map from '$lib/Map.svelte';

	const tripId = page.params.id!;

	let row = $state<TripRow | null>(null);
	let pois = $state<PoiRow[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let busy = $state(false);
	let dayIndex = $state(0);
	let view = $state<'plan' | 'map'>('plan');
	/** Which days are drawn on the map. Every day starts visible. */
	let visible = $state(new Set<number>());
	let seeded = false;

	function toggleDay(i: number) {
		const next = new Set(visible);
		if (next.has(i)) next.delete(i);
		else next.add(i);
		visible = next;
	}

	let bbox = $state<ReturnType<typeof cityBBox>>(null);

	onMount(async () => {
		try {
			[row, pois] = await Promise.all([getTrip(tripId), listPois(tripId)]);
			if (!row) return;
			bbox = cityBBox(row);
			if (!bbox) {
				const [match] = await provider.searchCities(row.city);
				if (match?.bbox) {
					bbox = match.bbox;
					await updateCityBBox(tripId, match.bbox);
				}
			}
		} catch (e) {
			error = (e as Error).message;
		} finally {
			loading = false;
		}
	});

	const city = $derived<City | null>(
		row ? { name: row.city, label: row.city, lat: 0, lng: 0, countryCode: null, bbox } : null
	);

	// Null Island is a real place in the Gulf of Guinea, and a trip saved before
	// the hotel picker existed points at it. Centre on the city instead, and say
	// so rather than silently showing the wrong sea.
	const centre = $derived(
		row && !hotelMissing(row)
			? { lat: row.hotel_lat, lng: row.hotel_lng }
			: bbox
				? { lat: (bbox.south + bbox.north) / 2, lng: (bbox.west + bbox.east) / 2 }
				: { lat: 51.5074, lng: -0.1278 }
	);

	async function setHotel(h: { name: string; lat: number; lng: number }) {
		try {
			await updateHotel(tripId, h);
			row = await getTrip(tripId);
		} catch (e) {
			error = (e as Error).message;
		}
	}

	const days = $derived<Day[]>(row ? tripDays(toTrip(row)) : []);

	$effect(() => {
		if (!seeded && days.length) {
			visible = new Set(days.map((_, i) => i));
			seeded = true;
		}
	});

	const result = $derived<PlanResult | null>(
		row && days.length
			? schedule({
					pois: pois.map(toPlanPoi),
					days,
					allowedModes: row.allowed_modes as Mode[],
					timezone: row.timezone
				})
			: null
	);

	const current = $derived(result?.days[dayIndex] ?? null);

	async function doReplan() {
		if (!row || !days.length) return;
		busy = true;
		error = null;
		try {
			const next = replan({
				pois: pois.map(toPlanPoi),
				days,
				allowedModes: row.allowed_modes as Mode[],
				timezone: row.timezone
			});
			// Persist what the planner decided, so a reload shows the same trip.
			const assignments = next.days.flatMap((d) =>
				d.stops
					.filter((s) => s.poiId)
					.map((s, i) => ({ id: s.poiId!, dayIndex: d.index, orderIndex: i }))
			);
			const unplacedIds = next.unplaced.map((p) => ({
				id: p.id,
				dayIndex: null,
				orderIndex: null
			}));
			await saveAssignments([...assignments, ...unplacedIds]);
			pois = await listPois(tripId);
		} catch (e) {
			error = (e as Error).message;
		} finally {
			busy = false;
		}
	}

	const hhmm = (d: Date, tz: string) =>
		new Intl.DateTimeFormat(undefined, { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);

	const dayLabel = (iso: string, tz: string) =>
		new Intl.DateTimeFormat(undefined, { timeZone: tz, weekday: 'short', day: 'numeric' }).format(
			new Date(`${iso}T12:00:00Z`)
		);

	const MODE_ICON: Record<Mode, string> = {
		walk: 'M11 21l2-6-3-3 1-5 3 3 3 1M10 12l-2 9',
		bike: 'M6 17l5-8h5M14 9l4 8',
		transit: 'M5 11h14M8 20l2-4M16 20l-2-4',
		car: 'M3 13l2-5h14l2 5v4h-3M3 17v-4M6 17h9',
		carshare: 'M3 13l2-5h14l2 5v4h-3M3 17v-4M6 17h9'
	};

	const dayColor = (i: number) => `var(--tm-day-${Math.min(i + 1, 8)})`;

	const shownDays = $derived((result?.days ?? []).filter((d) => visible.has(d.index)));

	const markers = $derived(
		shownDays.flatMap((day) =>
			day.stops.map((s, i) => ({
				id: `${day.index}:${s.poiId ?? `anchor-${i}`}`,
				lat: s.at.lat,
				lng: s.at.lng,
				color: s.anchor ? 'var(--tm-text)' : dayColor(day.index),
				glyph: s.anchor
					? 'H'
					: String(day.stops.slice(0, i).filter((x) => !x.anchor).length + 1)
			}))
		)
	);

	const routes = $derived(
		shownDays.map((day) => ({
			id: String(day.index),
			points: day.stops.map((s) => s.at),
			color: dayColor(day.index)
		}))
	);
</script>

<main class="flex h-dvh flex-col">
	{#if loading}
		<p class="p-6" style="color: var(--tm-text-faint)">Loading…</p>
	{:else if !row}
		<div class="p-6">
			<a href="{base}/" class="tm-btn tm-btn--ghost" style="min-height:auto;padding:0">← Trips</a>
			<div class="tm-card mt-6" style="background: var(--tm-surface-2)">
				<p class="tm-card__title">Trip not found</p>
				<p class="tm-card__meta">It may have been deleted, or belong to another account.</p>
			</div>
		</div>
	{:else}
		<div class="flex flex-col gap-3 p-4" style="border-bottom: 1px solid var(--tm-border)">
			<div class="flex items-center justify-between">
				<div>
					<a href="{base}/" class="tm-attrib" style="text-decoration: none">← Trips</a>
					<h1 style="font: 700 var(--tm-text-xl)/1.15 var(--tm-font)">{row.city}</h1>
				</div>
				<button
					class="tm-btn tm-btn--secondary"
					style="min-height:38px"
					onclick={doReplan}
					disabled={busy || !pois.length || hotelMissing(row)}
				>
					{busy ? 'Planning…' : 'Replan'}
				</button>
			</div>

			<div class="tm-seg" role="tablist" aria-label="View">
				<button role="tab" aria-selected={view === 'plan'} onclick={() => (view = 'plan')}>Plan</button>
				<button role="tab" aria-selected={view === 'map'} onclick={() => (view = 'map')}>Map</button>
			</div>

			<div class="flex items-center gap-1.5 overflow-x-auto">
				{#each days as day, i (day.date)}
					{@const on = view === 'map' ? visible.has(i) : i === dayIndex}
					<button
						class="tm-chip"
						aria-pressed={view === 'map' ? on : undefined}
						style={on
							? `background:${dayColor(i)};color:#fff`
							: 'opacity:0.55'}
						onclick={() => (view === 'map' ? toggleDay(i) : (dayIndex = i))}
					>
						{dayLabel(day.date, row.timezone)}
					</button>
				{/each}
				{#if view === 'map'}
					<button
						class="tm-chip"
						style="white-space: nowrap"
						onclick={() =>
							(visible = visible.size === days.length
								? new Set()
								: new Set(days.map((_, i) => i)))}
					>
						{visible.size === days.length ? 'None' : 'All'}
					</button>
				{/if}
			</div>

			{#if error}<p class="tm-hint tm-hint--error">{error}</p>{/if}
		</div>

		{#if hotelMissing(row)}
			<div class="m-4 tm-card" style="background: var(--tm-warn-soft); border-color: transparent">
				<p class="tm-card__title" style="color: var(--tm-warn-ink)">Hotel location missing</p>
				<p class="tm-card__meta" style="color: var(--tm-warn-ink)">
					This trip was saved before hotels were searchable, so it has no coordinates and the
					planner has nothing to measure from. Pick it now.
				</p>
				<div class="mt-3">
					<Autocomplete
						label="Hotel"
						placeholder="Hotels in {row.city}"
						search={(q, signal) => provider.searchHotels(q, city!, signal)}
						onpick={(h) => setHotel(h)}
					/>
				</div>
			</div>
		{/if}

		{#if view === 'map'}
			<div class="flex-1">
				<Map {markers} {routes} center={centre} />
			</div>
		{:else}
			<div class="flex-1 overflow-y-auto p-4" style="--tm-stop-day: {dayColor(dayIndex)}">
				{#if !pois.length}
					<div class="tm-card" style="background: var(--tm-surface-2)">
						<p class="tm-card__title">Nothing to plan yet</p>
						<p class="tm-card__meta">Add some places and the days will arrange themselves.</p>
					</div>
				{:else if current}
					{#each current.stops as stop, i (stop.name + i)}
						{#if stop.legIn}
							<div class="tm-leg">
								<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
									<path d={MODE_ICON[stop.legIn.mode]} />
								</svg>
								<span>{stop.legIn.minutes} min · {stop.legIn.km} km · {stop.legIn.mode}</span>
							</div>
						{/if}
						<div class="tm-stop" class:tm-stop--anchor={stop.anchor}>
							<span class="tm-stop__time">{hhmm(stop.arrive, row.timezone)}</span>
							<div>
								<p class="tm-stop__name">{stop.name}</p>
								<p class="tm-stop__sub">
									{stop.anchor ? (stop.durationMin ? `${stop.durationMin} min stop` : 'anchor') : `${stop.durationMin} min`}
								</p>
								{#each stop.warnings as w (w.kind)}
									<div class="mt-2"><span class="tm-chip tm-chip--warn">{w.message}</span></div>
								{/each}
							</div>
						</div>
					{/each}
				{/if}
			</div>
		{/if}

		<div class="flex items-center justify-between px-4 py-3" style="border-top: 1px solid var(--tm-border)">
			{#if result?.unplaced.length}
				<span class="tm-chip tm-chip--warn">{result.unplaced.length} unplaced</span>
			{:else}
				<span class="tm-chip tm-chip--mint">{pois.length} stops</span>
			{/if}
			<a href="{base}/trip/{tripId}/add" class="tm-btn tm-btn--primary" style="min-height:38px;text-decoration:none">
				Add places
			</a>
		</div>
	{/if}
</main>
