<script lang="ts">
	import OpeningHours from '$lib/OpeningHours.svelte';
	import { formatter } from '$lib/clock';
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { base } from '$app/paths';
	import { goto } from '$app/navigation';
	import { getTrip, hotelMissing, toTrip } from '$lib/trip/repo';
	import { getPoi, removePoi, updatePoi } from '$lib/trip/pois';
	import { between, listPlacements, place, unplace } from '$lib/trip/placements';
	import { mutate, pullTrip } from '$lib/store/store.svelte';
	import { tripDays } from '$lib/trip/days';
	import { REASON_TEXT, type UnplacedReason } from '$lib/plan/planner';
	import { loadPlan, toPlannedDays } from '$lib/trip/plan';
	import { busyWindows, categoryBusyness, hourLabel } from '$lib/plan/crowd';
	import { effectiveDayStart, isMeal, latestReady } from '$lib/plan/meals';
	import { haversineKm } from '$lib/plan/geo';
	import { isShortMapLink, parseLatLng } from '$lib/poi/manual';
	import { displayName, tripProfiles } from '$lib/profile.svelte';
	import { avatarDataUri } from '$lib/avatar';
	import { safePhone, safeUrl } from '$lib/poi/photon';
	import Stars from '$lib/Stars.svelte';
	import TripMap from '$lib/GoogleMap.svelte';
	import { placeUrl } from '$lib/maps';

	const tripId = page.params.id!;
	const poiId = page.params.poiId!;

	const trip = $derived(getTrip(tripId));
	const poi = $derived(getPoi(poiId));
	/** Every visit to this place, in plan order. */
	const placements = $derived(listPlacements(tripId).filter((v) => v.poi_id === poiId));
	const people = $derived(tripProfiles(tripId));
	const ready = $derived(latestReady(people.map((x) => ({ wakeAt: x.wakeAt, prepMin: x.prepMin }))));
	const stored = $derived(loadPlan(tripId));
	/** Not on this device yet: the page draws its shape until the trip arrives. */
	let loading = $state(!getPoi(poiId));
	let error = $state<string | null>(null);
	let saving = $state(false);
	let confirmRemove = $state(false);

	let duration = $state(60);
	let notes = $state('');
	/** Pasted coordinates or map link for where this stop lets you out. */
	let exitPaste = $state('');
	let exitError = $state<string | null>(null);

	// Filled once, from the place as it first reads; after that the fields are
	// the traveller's to type in.
	let filled = false;
	$effect(() => {
		if (filled || !poi) return;
		filled = true;
		duration = poi.duration_min;
		notes = poi.notes ?? '';
	});

	onMount(() => {
		if (poi) return;
		loading = true;
		pullTrip(tripId)
			.catch((e) => (error = (e as Error).message))
			.finally(() => (loading = false));
	});

	/** Whoever put this on the wishlist, if they are still on the trip. */
	const addedBy = $derived(people.find((p) => p.userId === poi?.added_by) ?? null);

	const days = $derived(
		trip
			? tripDays({ ...toTrip(trip), dayStart: effectiveDayStart(toTrip(trip).dayStart, ready) })
			: []
	);

	// The stored plan, not a fresh one: this page must agree with the times the
	// trip page is showing, down to the minute.
	const plan = $derived(
		trip && days.length ? toPlannedDays(stored, days) : null
	);

	/**
	 * Each visit, with the stored stop that is it -- when the plan has one; a
	 * visit put on a day since the last Replan has a day but no time yet.
	 *
	 * A plan saved before 0041 has no placement id on its stops, so those fall
	 * back to the match the migration made: same place, same day, the nth of
	 * each matched to the nth of the other.
	 */
	const visits = $derived(
		placements.map((pl) => {
			const stops = plan?.find((d) => d.index === pl.day_index)?.stops ?? [];
			const rank = placements.filter(
				(o) => o.day_index === pl.day_index && o.at < pl.at
			).length;
			const stop =
				stops.find((s) => s.placementId === pl.id) ??
				stops.filter((s) => s.poiId === poiId && !s.placementId)[rank] ??
				null;
			return { placement: pl, stop };
		})
	);

	/** The first visit the plan has timed, for the busyness figure. */
	const placed = $derived(visits.find((v) => v.stop) ?? null);

	/** Why it is not on the plan. Same rule as the wishlist uses. */
	const reason = $derived<UnplacedReason | null>(
		!poi || placements.length
			? null
			: trip && hotelMissing(trip)
				? 'hotel-unknown'
				: !days.some((d) => d.usableMin > 0)
					? 'no-usable-days'
					: !trip?.plan_generated_at ||
						  Date.parse(poi.created_at) > Date.parse(trip.plan_generated_at)
						? 'not-planned-yet'
						: 'day-full'
	);

	const kmFromHotel = $derived(
		trip && poi ? haversineKm({ lat: trip.hotel_lat, lng: trip.hotel_lng }, poi).toFixed(1) : null
	);

	/**
	 * Expected busyness. When the stop is on the plan this is the figure for its
	 * actual arrival; otherwise it is the category's general shape, which is all
	 * that can honestly be said before a time exists.
	 */
	const busyNow = $derived(placed && trip ? placed.stop!.busyness : null);
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
			const level = categoryBusyness(poi.category, at, 'UTC');
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
		formatter(undefined, { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);

	const dayLabel = (iso: string, tz: string) =>
		formatter(undefined, { timeZone: tz, weekday: 'long', day: 'numeric', month: 'short' })
			.format(new Date(`${iso}T12:00:00Z`));

	async function persist(patch: Parameters<typeof updatePoi>[2]) {
		error = null;
		try {
			await mutate(`Changed ${poi?.name ?? 'a place'}`, tripId, (w) => updatePoi(w, poiId, patch));
		} catch (e) {
			error = (e as Error).message;
		}
	}

	async function remove() {
		try {
			await mutate(`Removed ${poi?.name ?? 'a place'}`, tripId, (w) => removePoi(w, poiId));
			await goto(`${base}/trip/${tripId}`, { replaceState: true });
		} catch (e) {
			error = (e as Error).message;
		}
	}

	const STEPS = [15, 30, 45, 60, 90, 120, 180, 240];

	/**
	 * The keyboard-reachable way to put a place on a day. Dragging is faster
	 * with a thumb, and impossible without one.
	 *
	 * Lands at the end of the day's sightseeing, which is not the end of the
	 * day: the day ends at the hotel it is slept in, and a visit put after
	 * that one is a visit made in the traveller's sleep. It goes in the space
	 * before whatever furniture closes the day out.
	 */
	async function addToDay(index: number) {
		saving = true;
		error = null;
		try {
			const stops = plan?.find((d) => d.index === index)?.stops ?? [];
			// Back past the furniture the day finishes on.
			let i = stops.length;
			while (i > 0 && stops[i - 1].anchor) i--;
			const prev = stops[i - 1];
			const next = stops[i];
			const when =
				prev && next
					? between(prev.depart, next.arrive)
					: prev
						? new Date(prev.depart.getTime() + 15 * 60_000).toISOString()
						: next
							? new Date(next.arrive.getTime() - 60 * 60_000).toISOString()
							: (days[index]?.start ?? new Date()).toISOString();
			await mutate(`Put ${poi?.name ?? 'a place'} on a day`, tripId, (w) =>
				place(w, tripId, poiId, index, when)
			);
		} catch (e) {
			error = (e as Error).message;
		} finally {
			saving = false;
		}
	}

	async function removeVisit(id: string) {
		saving = true;
		error = null;
		try {
			await mutate(`Took ${poi?.name ?? 'a place'} off a day`, tripId, (w) => unplace(w, id));
		} catch (e) {
			error = (e as Error).message;
		} finally {
			saving = false;
		}
	}

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
		<div class="flex flex-col gap-3">
			<div class="tm-skel" style="height:72px"></div>
			<div class="tm-skel" style="height:72px"></div>
			<div class="tm-skel" style="height:72px"></div>
		</div>
	{:else if !poi || !trip}
		<div class="tm-card" style="background: var(--tm-surface-2)">
			<p class="tm-card__title">Not found</p>
			<p class="tm-card__meta">This place may have been removed from the trip.</p>
		</div>
	{:else}
		<h1 style="font: 700 var(--tm-text-2xl)/1.15 var(--tm-font); letter-spacing: -0.02em">
			{poi.name}
		</h1>
		{#if poi.address}<p class="tm-card__meta">{poi.address}</p>{/if}
		{@const firstDay = placements.length ? days[Math.min(...placements.map((pl) => pl.day_index))] : undefined}
		<OpeningHours
			periods={poi.opening_periods}
			text={poi.opening_hours}
			date={firstDay?.date ?? new Date().toLocaleDateString('en-CA')}
			dayName={firstDay && trip ? dayLabel(firstDay.date, trip.timezone) : 'today'}
		/>
		<p class="tm-card__meta">
			{poi.category ?? 'place'}{#if kmFromHotel} · {kmFromHotel} km from {trip.hotel_name}{/if}
		</p>

		<!-- Every time it is on the plan. One card per visit, each with its own
		     remove: the same cafe on Tuesday and Thursday is two visits, and
		     taking one off says nothing about the other. -->
		{#each visits as { placement, stop } (placement.id)}
			{@const day = days[placement.day_index]}
			<div class="tm-card mt-4" style="background: var(--tm-surface-2)">
				<div class="flex items-center gap-2">
					<span
						style="width:11px;height:11px;border-radius:50%;background:var(--tm-day-{Math.min(placement.day_index + 1, 8)})"
					></span>
					<p class="tm-card__title">
						{day ? dayLabel(day.date, trip.timezone) : `Day ${placement.day_index + 1}`}
					</p>
				</div>
				<p class="tm-card__meta">
					{#if stop}
						{hhmm(stop.arrive, trip.timezone)} – {hhmm(stop.depart, trip.timezone)}
					{:else}
						No time yet. Tap Replan on the trip to fit it in.
					{/if}
				</p>
				{#each stop?.warnings ?? [] as w (w.kind)}
					<span class="tm-chip tm-chip--warn mt-2">{w.message}</span>
				{/each}
				<button
					class="tm-btn tm-btn--secondary tm-btn--block mt-3"
					disabled={saving}
					onclick={() => removeVisit(placement.id)}
				>
					Take it off this day
				</button>
			</div>
		{:else}
			<div class="tm-card mt-4" style="background: var(--tm-surface-2)">
				<p class="tm-card__title">Not scheduled</p>
				<p class="tm-card__meta">{REASON_TEXT[reason ?? 'not-planned-yet']}</p>
			</div>
		{/each}

		<h2 class="tm-label mt-6 mb-2">{placements.length ? 'Add it to another day' : 'Put it on a day'}</h2>
		<div class="flex flex-wrap gap-2">
			{#each days as day, i (day.date)}
				<button
					class="tm-chip"
					style="opacity:0.6"
					disabled={saving}
					onclick={() => addToDay(i)}
				>
					{dayLabel(day.date, trip.timezone)}
				</button>
			{/each}
		</div>
		<p class="tm-hint mt-2">
			Lands at the end of that day. Drag it on the plan to place it precisely.
		</p>

		<h2 class="tm-label mt-6 mb-2">How much you want this</h2>
		<Stars
			value={poi.priority}
			size={18}
			onchange={(v) => persist({ priority: v })}
		/>
		<p class="tm-hint mt-2">
			When a day runs out of hours, the least wanted stops are the ones that fall off. Higher
			ratings also pull a place towards the start of the trip.
		</p>

		<!-- Expected busyness -->
		{#if addedBy}
			<div class="mt-4 flex items-center gap-2">
				<img
					src={addedBy.avatarUrl ?? avatarDataUri(addedBy.avatarSeed)}
					alt=""
					width="22"
					height="22"
					style="width:22px;height:22px;border-radius:50%;object-fit:cover"
				/>
				<span class="tm-hint">{displayName(addedBy)} added this</span>
			</div>
		{/if}

		<h2 class="tm-label mt-6 mb-2">Where it is</h2>
		<div
			style="height:180px;border-radius:var(--tm-r-md);overflow:hidden;
			border:1px solid var(--tm-border)"
		>
			<TripMap
				markers={[
					{ id: poi.id, lat: poi.lat, lng: poi.lng, color: 'var(--tm-primary)', selected: true },
					...(trip
						? [
								{
									id: 'hotel',
									lat: trip.hotel_lat,
									lng: trip.hotel_lng,
									glyph: 'H',
									kind: 'hotel' as const
								}
							]
						: [])
				]}
				routes={[]}
				center={{ lat: poi.lat, lng: poi.lng }}
			/>
		</div>
		<p class="tm-hint mt-2">
			{kmFromHotel} km from {trip?.hotel_name ?? 'the hotel'}.
		</p>

		<h2 class="tm-label mt-6 mb-2">Expected busyness</h2>
		<div class="tm-card">
			{#if busyNow !== null}
				<p style="font: 600 var(--tm-text-base)/1.3 var(--tm-font)">
					{busyNow >= 0.8 ? 'Usually packed' : busyNow >= 0.5 ? 'Fairly busy' : 'Usually quiet'}
					at {hhmm(placed!.stop!.arrive, trip.timezone)}
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
					href={placeUrl({ lat: poi.lat, lng: poi.lng }, poi.name)}
					target="_blank"
					rel="noopener noreferrer"
					style="min-height:38px;text-decoration:none"
				>
					Open in Maps
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

		<!-- Some stops let you out somewhere else: a cable car, a ferry, a
		     funicular. The plan then measures the next leg from that end. -->
		<h2 class="tm-label mt-6 mb-2">Where it ends</h2>
		{#if poi.exit_lat !== null && poi.exit_lng !== null}
			<div class="tm-card" style="background: var(--tm-surface-2)">
				<p class="tm-card__title">Ends somewhere else</p>
				<p class="tm-card__meta">
					{poi.exit_lat.toFixed(5)}, {poi.exit_lng.toFixed(5)} ·
					{haversineKm({ lat: poi.lat, lng: poi.lng }, { lat: poi.exit_lat, lng: poi.exit_lng }).toFixed(1)} km
					from where it starts
				</p>
				<button
					class="tm-btn tm-btn--secondary tm-btn--block mt-3"
					onclick={() => persist({ exit_lat: null, exit_lng: null })}
				>
					It ends where it starts
				</button>
			</div>
		{:else}
			<div class="tm-field">
				<input
					class="tm-input"
					bind:value={exitPaste}
					placeholder="51.5083, 0.0184 or a map link"
					aria-label="Where this stop ends"
					aria-invalid={exitError ? 'true' : undefined}
				/>
				<button
					class="tm-btn tm-btn--secondary tm-btn--block"
					disabled={!exitPaste.trim()}
					onclick={() => {
						const point = parseLatLng(exitPaste);
						if (!point) {
							exitError = isShortMapLink(exitPaste)
								? 'Short map links hide their coordinates. Open it once, then paste the full link.'
								: 'No coordinates in that. Paste a full map link, or something like 51.5083, 0.0184.';
							return;
						}
						exitError = null;
						exitPaste = '';
						persist({ exit_lat: point.lat, exit_lng: point.lng });
					}}
				>
					Set where it ends
				</button>
				{#if exitError}
					<span class="tm-hint tm-hint--error">{exitError}</span>
				{:else}
					<span class="tm-hint">
						For a crossing like a cable car or a ferry. Leave it alone for a return trip —
						that ends where it began.
					</span>
				{/if}
			</div>
		{/if}

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
				<p class="tm-hint mb-2">
					Remove {poi.name} from this trip? It comes off the wishlist and off every day it is
					on{#if placements.length} — {placements.length === 1 ? 'one visit' : `${placements.length} visits`}{/if}.
				</p>
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
