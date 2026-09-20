<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { base } from '$app/paths';
	import { goto } from '$app/navigation';
	import { getTrip, toTrip, type TripRow } from '$lib/trip/repo';
	import { getPoi, listPois, removePoi, toPlanPoi, updatePoi, type PoiRow } from '$lib/trip/pois';
	import { tripDays } from '$lib/trip/days';
	import { schedule, REASON_TEXT, type PlannedStop } from '$lib/plan/planner';
	import { busyWindows, categoryCrowd, hourLabel } from '$lib/plan/crowd';
	import { isMeal, tightest } from '$lib/plan/meals';
	import { haversineKm } from '$lib/plan/geo';
	import { loadTripProfiles } from '$lib/profile.svelte';
	import type { Mode } from '$lib/plan/modes';
	import { safePhone, safeUrl } from '$lib/poi/photon';

	const tripId = page.params.id!;
	const poiId = page.params.poiId!;

	let trip = $state<TripRow | null>(null);
	let poi = $state<PoiRow | null>(null);
	let all = $state<PoiRow[]>([]);
	let windows = $state(tightest([]).windows);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let saving = $state(false);
	let confirmRemove = $state(false);

	let duration = $state(60);
	let notes = $state('');

	onMount(async () => {
		try {
			const [t, p, list, people] = await Promise.all([
				getTrip(tripId),
				getPoi(poiId),
				listPois(tripId),
				loadTripProfiles(tripId)
			]);
			trip = t;
			poi = p;
			all = list;
			windows = tightest(people.map((x) => x.mealWindows)).windows;
			if (p) {
				duration = p.duration_min;
				notes = p.notes ?? '';
			}
		} catch (e) {
			error = (e as Error).message;
		} finally {
			loading = false;
		}
	});

	const days = $derived(trip ? tripDays(toTrip(trip)) : []);

	const plan = $derived(
		trip && days.length
			? schedule({
					pois: all.map(toPlanPoi),
					days,
					allowedModes: trip.allowed_modes as Mode[],
					timezone: trip.timezone,
					mealWindows: windows
				})
			: null
	);

	/** Where this stop landed, if it landed. */
	const placed = $derived(
		plan
			? (plan.days
					.flatMap((d) => d.stops.map((s) => ({ stop: s, dayIndex: d.index })))
					.find((x) => x.stop.poiId === poiId) ?? null)
			: null
	);

	const reason = $derived(plan?.unplaced.find((u) => u.poi.id === poiId)?.reason ?? null);

	const kmFromHotel = $derived(
		trip && poi ? haversineKm({ lat: trip.hotel_lat, lng: trip.hotel_lng }, poi).toFixed(1) : null
	);

	/**
	 * Expected busyness. When the stop is on the plan this is the figure for its
	 * actual arrival; otherwise it is the category's general shape, which is all
	 * that can honestly be said before a time exists.
	 */
	const busyNow = $derived(
		placed && trip ? (placed.stop as PlannedStop).busyness : null
	);
	const windowsForCategory = $derived(busyWindows(poi?.category ?? null));

	const quiet = $derived.by(() => {
		if (!trip || !poi) return null;
		// The quietest hour the day window allows, from the same curve the
		// planner uses -- not a second opinion invented for this screen.
		const open = Number(trip.day_start.slice(0, 2));
		const close = Number(trip.day_end.slice(0, 2));
		let best: { hour: number; level: number } | null = null;
		for (let h = open; h < close; h++) {
			const at = new Date(`${days[0]?.date ?? '2026-01-01'}T${String(h).padStart(2, '0')}:00:00Z`);
			const level = categoryCrowd.busyness(poi.category, at, 'UTC') ?? 1;
			if (!best || level < best.level) best = { hour: h, level };
		}
		return best;
	});

	/**
	 * Booking advice is derived from our own crowd curve, never invented. A
	 * website, when OSM has one, is the only real booking route we can offer.
	 */
	const worthBooking = $derived(windowsForCategory.some((w) => w.level >= 0.8));

	const hhmm = (d: Date, tz: string) =>
		new Intl.DateTimeFormat(undefined, { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);

	const dayLabel = (iso: string, tz: string) =>
		new Intl.DateTimeFormat(undefined, { timeZone: tz, weekday: 'long', day: 'numeric', month: 'short' })
			.format(new Date(`${iso}T12:00:00Z`));

	async function persist(patch: Parameters<typeof updatePoi>[1]) {
		saving = true;
		error = null;
		try {
			poi = await updatePoi(poiId, patch);
			all = await listPois(tripId);
		} catch (e) {
			error = (e as Error).message;
		} finally {
			saving = false;
		}
	}

	async function remove() {
		try {
			await removePoi(poiId);
			await goto(`${base}/trip/${tripId}`, { replaceState: true });
		} catch (e) {
			error = (e as Error).message;
		}
	}

	const STEPS = [15, 30, 45, 60, 90, 120, 180, 240];

	// Validated again at render, not only at capture: rows written before the
	// capture-time check existed are still in the database.
	const website = $derived(safeUrl(poi?.website));
	const phone = $derived(safePhone(poi?.phone));
</script>

<main class="mx-auto max-w-lg px-6 pb-16">
	<header class="tm-safe-top mb-4">
		<a href="{base}/trip/{tripId}" class="tm-attrib" style="text-decoration: none">← Wishlist</a>
	</header>

	{#if loading}
		<p style="color: var(--tm-text-faint)">Loading…</p>
	{:else if !poi || !trip}
		<div class="tm-card" style="background: var(--tm-surface-2)">
			<p class="tm-card__title">Not found</p>
			<p class="tm-card__meta">This place may have been removed from the trip.</p>
		</div>
	{:else}
		<h1 style="font: 700 var(--tm-text-2xl)/1.15 var(--tm-font); letter-spacing: -0.02em">
			{poi.name}
		</h1>
		<p class="tm-card__meta">
			{poi.category ?? 'place'}{#if kmFromHotel} · {kmFromHotel} km from {trip.hotel_name}{/if}
		</p>

		<!-- Where it sits in the plan -->
		<div class="tm-card mt-4" style="background: var(--tm-surface-2)">
			{#if placed}
				<div class="flex items-center gap-2">
					<span
						style="width:11px;height:11px;border-radius:50%;background:var(--tm-day-{Math.min(placed.dayIndex + 1, 8)})"
					></span>
					<p class="tm-card__title">{dayLabel(days[placed.dayIndex].date, trip.timezone)}</p>
				</div>
				<p class="tm-card__meta">
					{hhmm(placed.stop.arrive, trip.timezone)} – {hhmm(placed.stop.depart, trip.timezone)}
				</p>
				{#each placed.stop.warnings as w (w.kind)}
					<span class="tm-chip tm-chip--warn mt-2">{w.message}</span>
				{/each}
			{:else}
				<p class="tm-card__title">Not scheduled</p>
				<p class="tm-card__meta">{REASON_TEXT[reason ?? 'not-planned-yet']}</p>
			{/if}
		</div>

		<!-- Expected busyness -->
		<h2 class="tm-label mt-6 mb-2">Expected busyness</h2>
		<div class="tm-card">
			{#if busyNow !== null}
				<p style="font: 600 var(--tm-text-base)/1.3 var(--tm-font)">
					{busyNow >= 0.8 ? 'Usually packed' : busyNow >= 0.5 ? 'Fairly busy' : 'Usually quiet'}
					at {hhmm(placed!.stop.arrive, trip.timezone)}
				</p>
			{:else}
				<p style="font: 600 var(--tm-text-base)/1.3 var(--tm-font)">
					No arrival time yet — here is the usual shape.
				</p>
			{/if}

			{#if windowsForCategory.length}
				<ul class="mt-2 flex flex-col gap-1">
					{#each windowsForCategory as w}
						<li class="tm-card__meta">
							{hourLabel(w.from)}–{hourLabel(w.to)} ·
							{w.level >= 0.8 ? 'packed' : w.level >= 0.5 ? 'busy' : 'steady'}
						</li>
					{/each}
				</ul>
				{#if quiet}
					<p class="tm-card__meta mt-2">Quietest around {hourLabel(quiet.hour)}.</p>
				{/if}
			{:else}
				<p class="tm-card__meta mt-1">
					Nothing known about this kind of place, so the planner assumes it is steady all day.
				</p>
			{/if}
			<p class="tm-hint mt-2">
				Estimated from the category and the clock, not from live measurements.
			</p>
		</div>

		<!-- Booking -->
		<h2 class="tm-label mt-6 mb-2">Before you go</h2>
		<div class="tm-card">
			{#if worthBooking}
				<p class="tm-card__meta">
					{isMeal(poi.category)
						? 'Peak times fill up. Worth reserving a table.'
						: 'Gets packed at peak times. Timed tickets, if sold, are usually worth it.'}
				</p>
			{:else}
				<p class="tm-card__meta">Rarely crowded enough to need booking ahead.</p>
			{/if}

			{#if poi.opening_hours}
				<p class="tm-card__meta mt-2">Opening hours: <code>{poi.opening_hours}</code></p>
			{/if}
			<div class="mt-3 flex flex-wrap gap-2">
				{#if website}
					<a
						class="tm-btn tm-btn--secondary"
						href={website}
						target="_blank"
						rel="noopener noreferrer"
						style="min-height:38px;text-decoration:none"
					>
						Website
					</a>
				{/if}
				{#if phone}
					<a class="tm-btn tm-btn--secondary" href="tel:{phone}" style="min-height:38px;text-decoration:none">
						Call
					</a>
				{/if}
				<a
					class="tm-btn tm-btn--secondary"
					href="https://www.openstreetmap.org/?mlat={poi.lat}&mlon={poi.lng}#map=18/{poi.lat}/{poi.lng}"
					target="_blank"
					rel="noopener noreferrer"
					style="min-height:38px;text-decoration:none"
				>
					Open map
				</a>
			</div>
			{#if !website && !phone}
				<p class="tm-hint mt-2">
					No contact details in OpenStreetMap for this place.
				</p>
			{/if}
		</div>

		<!-- Edits -->
		<h2 class="tm-label mt-6 mb-2">How long to stay</h2>
		<div class="flex flex-wrap gap-2">
			{#each STEPS as m}
				<button
					class="tm-chip"
					aria-pressed={duration === m}
					style={duration === m
						? 'background: var(--tm-peach-soft); color: var(--tm-peach-ink)'
						: 'opacity: 0.6'}
					onclick={() => {
						duration = m;
						persist({ duration_min: m });
					}}
				>
					{m < 60 ? `${m} min` : `${m / 60} h`}
				</button>
			{/each}
		</div>
		<p class="tm-hint mt-2">
			Changing this moves everything after it on the day. Tap Replan to reshuffle properly.
		</p>

		<div class="tm-field mt-6">
			<label class="tm-label" for="notes">Notes</label>
			<textarea
				class="tm-input"
				id="notes"
				rows="3"
				style="padding-top: 10px; padding-bottom: 10px; min-height: auto"
				bind:value={notes}
				placeholder="Booking reference, who recommended it, what to order…"
				onblur={() => persist({ notes: notes.trim() || null })}
			></textarea>
			<span class="tm-hint">
				{#if error}
					<span class="tm-hint--error">{error}</span>
				{:else if saving}
					Saving…
				{:else}
					Saved automatically.
				{/if}
			</span>
		</div>

		<div class="mt-10" style="border-top: 1px solid var(--tm-border); padding-top: 1rem">
			{#if confirmRemove}
				<p class="tm-hint mb-2">Remove {poi.name} from this trip?</p>
				<div class="flex gap-2">
					<button class="tm-btn tm-btn--secondary flex-1" onclick={() => (confirmRemove = false)}>
						Keep it
					</button>
					<button
						class="tm-btn flex-1"
						style="background: var(--tm-danger-ink); color: var(--tm-surface)"
						onclick={remove}
					>
						Remove
					</button>
				</div>
			{:else}
				<button
					class="tm-btn tm-btn--ghost"
					style="color: var(--tm-danger-ink)"
					onclick={() => (confirmRemove = true)}
				>
					Remove from trip
				</button>
			{/if}
		</div>
	{/if}
</main>
