<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { base } from '$app/paths';
	import {
		cityBBox,
		getTrip,
		hotelMissing,
		setShareToken,
		toTrip,
		updateCityBBox,
		updateHotel,
		type TripRow
	} from '$lib/trip/repo';
	import { listPois, saveAssignments, toPlanPoi, type PoiRow } from '$lib/trip/pois';
	import { tripDays, type Day } from '$lib/trip/days';
	import { replan, schedule, REASON_TEXT, type PlanResult, type UnplacedReason } from '$lib/plan/planner';
	import { isMeal, tightest, type MealWindows } from '$lib/plan/meals';
	import { resolveCurves, type CrowdCurves } from '$lib/plan/crowd';
	import { avatarDataUri } from '$lib/avatar';
	import { displayName, loadTripProfiles, type Profile } from '$lib/profile.svelte';
	import type { Mode } from '$lib/plan/modes';
	import Autocomplete from '$lib/Autocomplete.svelte';
	import LeafletMap from '$lib/Map.svelte';
	import { poi as provider, type City } from '$lib/poi';

	const tripId = page.params.id!;

	let row = $state<TripRow | null>(null);
	let pois = $state<PoiRow[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let busy = $state(false);
	let dayIndex = $state(0);
	let view = $state<'plan' | 'map' | 'wishlist'>('plan');
	let showDetails = $state(false);
	let visible = $state(new Set<number>());
	/** Unassigned stops are their own layer on the map, not a day. */
	let showUnassigned = $state(true);
	let seeded = false;
	let shareUrl = $state<string | null>(null);
	let copied = $state(false);
	let bbox = $state<ReturnType<typeof cityBBox>>(null);
	let people = $state<Profile[]>([]);
	let curves = $state<CrowdCurves | undefined>(undefined);

	onMount(async () => {
		try {
			[row, pois, people] = await Promise.all([
				getTrip(tripId),
				listPois(tripId),
				loadTripProfiles(tripId)
			]);
			if (!row) return;
			if (row.share_token) shareUrl = linkFor(row.share_token);
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

	const linkFor = (token: string) => `${window.location.origin}${base}/shared/${token}`;

	const days = $derived<Day[]>(row ? tripDays(toTrip(row)) : []);

	/**
	 * Busyness is resolved here, before the planner runs, and handed in as a
	 * plain table. The planner stays synchronous because it re-runs on every
	 * drag and hundreds of times inside 2-opt.
	 */
	async function refreshCurves() {
		if (!row || !days.length) return;
		curves = await resolveCurves(
			pois.map((p) => ({ id: p.id, category: p.category })),
			days,
			row.timezone
		);
	}

	$effect(() => {
		// Re-resolve when the stops or the dates change, not on every render.
		void pois.length;
		void days.length;
		refreshCurves();
	});

	$effect(() => {
		if (!seeded && days.length) {
			visible = new Set(days.map((_, i) => i));
			seeded = true;
		}
	});

	/**
	 * The window that suits everyone on the trip. With one traveller this is
	 * simply their own preference; with collaborators it is the overlap, so a
	 * restaurant is never booked for a time that suits only half the party.
	 */
	const agreed = $derived(tightest(people.map((p) => p.mealWindows)));

	const result = $derived<PlanResult | null>(
		row && days.length
			? schedule({
					pois: pois.map(toPlanPoi),
					days,
					allowedModes: row.allowed_modes as Mode[],
					timezone: row.timezone,
					mealWindows: agreed.windows,
					curves
				})
			: null
	);

	const current = $derived(result?.days[dayIndex] ?? null);

	/** poi id -> the day it sits on, for colouring the wishlist and the map. */
	const dayOf = $derived(
		new Map<string, number>(
			(result?.days ?? []).flatMap((d) =>
				d.stops.filter((s) => s.poiId).map((s) => [s.poiId!, d.index] as [string, number])
			)
		)
	);
	const reasonOf = $derived(
		new Map<string, UnplacedReason>(
			(result?.unplaced ?? []).map((u) => [u.poi.id, u.reason] as [string, UnplacedReason])
		)
	);

	const dayColor = (i: number) => `var(--tm-day-${Math.min(i + 1, 8)})`;
	const colorOf = (id: string) =>
		dayOf.has(id) ? dayColor(dayOf.get(id)!) : 'var(--tm-day-none)';

	function toggleDay(i: number) {
		const next = new Set(visible);
		if (next.has(i)) next.delete(i);
		else next.add(i);
		visible = next;
	}

	async function doReplan() {
		if (!row || !days.length) return;
		busy = true;
		error = null;
		try {
			const next = replan({
				pois: pois.map(toPlanPoi),
				days,
				allowedModes: row.allowed_modes as Mode[],
				timezone: row.timezone,
				mealWindows: agreed.windows,
				curves
			});
			const assignments = next.days.flatMap((d) =>
				d.stops.filter((s) => s.poiId).map((s, i) => ({ id: s.poiId!, dayIndex: d.index, orderIndex: i }))
			);
			const cleared = next.unplaced.map((u) => ({ id: u.poi.id, dayIndex: null, orderIndex: null }));
			await saveAssignments([...assignments, ...cleared]);
			pois = await listPois(tripId);
		} catch (e) {
			error = (e as Error).message;
		} finally {
			busy = false;
		}
	}

	/** Mints a link the first time, copies it thereafter. Revoking is separate:
	    a button that shares on one tap and unshares on the next is how people
	    kill a link they meant to send. */
	async function share() {
		if (!row) return;
		try {
			if (!shareUrl) {
				const token = crypto.randomUUID();
				await setShareToken(tripId, token);
				shareUrl = linkFor(token);
			}
			await copy();
		} catch (e) {
			error = (e as Error).message;
		}
	}

	async function revoke() {
		try {
			await setShareToken(tripId, null);
			shareUrl = null;
		} catch (e) {
			error = (e as Error).message;
		}
	}

	async function copy() {
		if (!shareUrl) return;
		try {
			await navigator.clipboard.writeText(shareUrl);
			copied = true;
			setTimeout(() => (copied = false), 1500);
		} catch {
			// Clipboard needs a user gesture and a secure context; the link is on
			// screen either way, so this is a convenience, not the mechanism.
		}
	}

	async function setHotel(h: { name: string; lat: number; lng: number }) {
		try {
			await updateHotel(tripId, h);
			row = await getTrip(tripId);
		} catch (e) {
			error = (e as Error).message;
		}
	}

	const city = $derived<City | null>(
		row ? { name: row.city, label: row.city, lat: 0, lng: 0, countryCode: null, bbox } : null
	);

	const centre = $derived(
		row && !hotelMissing(row)
			? { lat: row.hotel_lat, lng: row.hotel_lng }
			: bbox
				? { lat: (bbox.south + bbox.north) / 2, lng: (bbox.west + bbox.east) / 2 }
				: { lat: 51.5074, lng: -0.1278 }
	);

	const hhmm = (d: Date, tz: string) =>
		new Intl.DateTimeFormat(undefined, { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);

	const dayLabel = (iso: string, tz: string) =>
		new Intl.DateTimeFormat(undefined, { timeZone: tz, weekday: 'short', day: 'numeric' }).format(
			new Date(`${iso}T12:00:00Z`)
		);

	const stamp = (iso: string, tz: string) =>
		new Intl.DateTimeFormat(undefined, {
			timeZone: tz, weekday: 'short', day: 'numeric', month: 'short',
			hour: '2-digit', minute: '2-digit', hour12: false
		}).format(new Date(iso));

	const MODE_ICON: Record<Mode, string> = {
		walk: 'M11 21l2-6-3-3 1-5 3 3 3 1M10 12l-2 9',
		bike: 'M6 17l5-8h5M14 9l4 8',
		transit: 'M5 11h14M8 20l2-4M16 20l-2-4',
		car: 'M3 13l2-5h14l2 5v4h-3M3 17v-4M6 17h9',
		carshare: 'M3 13l2-5h14l2 5v4h-3M3 17v-4M6 17h9'
	};

	const shownDays = $derived((result?.days ?? []).filter((d) => visible.has(d.index)));

	const markers = $derived([
		...shownDays.flatMap((day) =>
			day.stops.map((s, i) => ({
				id: `${day.index}:${s.poiId ?? `anchor-${i}`}`,
				lat: s.at.lat,
				lng: s.at.lng,
				color: s.anchor ? 'var(--tm-text)' : dayColor(day.index),
				glyph: s.anchor ? 'H' : String(day.stops.slice(0, i).filter((x) => !x.anchor).length + 1)
			}))
		),
		...(showUnassigned
			? pois
					.filter((p) => !dayOf.has(p.id))
					.map((p) => ({
						id: `un:${p.id}`,
						lat: p.lat,
						lng: p.lng,
						color: 'var(--tm-day-none)',
						glyph: '?'
					}))
			: [])
	]);

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
		<div class="tm-safe-top p-6">
			<a href="{base}/" class="tm-attrib" style="text-decoration: none">← Trips</a>
			<div class="tm-card mt-6" style="background: var(--tm-surface-2)">
				<p class="tm-card__title">Trip not found</p>
				<p class="tm-card__meta">It may have been deleted, or belong to another account.</p>
			</div>
		</div>
	{:else}
		<div class="tm-safe-top flex flex-col gap-3 px-4 pb-3" style="border-bottom: 1px solid var(--tm-border)">
			<div class="flex items-start justify-between gap-2">
				<div>
					<a href="{base}/" class="tm-attrib" style="text-decoration: none">← Trips</a>
					<button
						style="background:none;border:none;padding:0;cursor:pointer;color:inherit;display:flex;align-items:center;gap:6px"
						aria-expanded={showDetails}
						onclick={() => (showDetails = !showDetails)}
					>
						<span style="font: 700 var(--tm-text-xl)/1.15 var(--tm-font)">{row.city}</span>
						<span style="color: var(--tm-text-faint); font-size: 12px">{showDetails ? '▴' : '▾'}</span>
					</button>
				</div>
				<div class="flex gap-2">
					<button
						class="tm-btn tm-btn--secondary"
						style="min-height:36px"
						onclick={doReplan}
						disabled={busy || !pois.length || hotelMissing(row)}
					>
						{busy ? 'Planning…' : 'Replan'}
					</button>
					<button class="tm-btn tm-btn--primary" style="min-height:36px" onclick={share}>
						{copied ? 'Copied' : shareUrl ? 'Copy link' : 'Share'}
					</button>
				</div>
			</div>

			{#if showDetails}
				<div class="tm-card" style="background: var(--tm-surface-2)">
					<dl class="flex flex-col gap-2">
						{#each [['City', row.city], ['Hotel', row.hotel_name], ['Arrival', stamp(row.arrival_at, row.timezone)], ['Departure', stamp(row.departure_at, row.timezone)], ['Timezone', row.timezone], ['Getting around', (row.allowed_modes ?? []).join(', ')]] as [label, value]}
							<div class="flex items-baseline justify-between gap-4">
								<dt style="font: 400 var(--tm-text-sm)/1.3 var(--tm-font); color: var(--tm-text-faint); white-space: nowrap">{label}</dt>
								<dd style="font: 500 var(--tm-text-base)/1.3 var(--tm-font); text-align: right">{value}</dd>
							</div>
						{/each}
					</dl>
					<div class="mt-3" style="border-top: 1px solid var(--tm-border); padding-top: 0.75rem">
						<p class="tm-label mb-2">
							{people.length > 1 ? `${people.length} travellers` : 'Just you'}
						</p>
						<div class="flex flex-wrap items-center gap-2">
							{#each people as person (person.userId)}
								<span class="flex items-center gap-1.5">
									<img
										src={person.avatarUrl ?? avatarDataUri(person.avatarSeed)}
										alt=""
										width="22"
										height="22"
										style="width:22px;height:22px;border-radius:50%;object-fit:cover"
									/>
									<span style="font: 500 var(--tm-text-sm)/1 var(--tm-font)">
										{displayName(person)}
									</span>
								</span>
							{/each}
						</div>
						<p class="tm-hint mt-2">
							Meals {agreed.windows.lunch.from}–{agreed.windows.lunch.to} and
							{agreed.windows.dinner.from}–{agreed.windows.dinner.to}
							{#if people.length > 1}(the overlap between everyone){/if}
						</p>
						{#if agreed.conflicts.length}
							<span class="tm-chip tm-chip--warn mt-2">
								No shared {agreed.conflicts.join(' or ')} time — using the latest start
							</span>
						{/if}
					</div>

					<div class="mt-3 flex gap-2">
						<a
							href="{base}/trip/{tripId}/edit"
							class="tm-btn tm-btn--secondary flex-1"
							style="min-height:38px;text-decoration:none"
						>
							Edit trip
						</a>
						{#if shareUrl}
							<button class="tm-btn tm-btn--secondary flex-1" style="min-height:38px" onclick={revoke}>
								Stop sharing
							</button>
						{/if}
					</div>
					{#if shareUrl}
						<p class="tm-attrib mt-2" style="word-break: break-all">{shareUrl}</p>
					{/if}
				</div>
			{/if}

			<div class="tm-seg" role="tablist" aria-label="View">
				<button role="tab" aria-selected={view === 'plan'} onclick={() => (view = 'plan')}>Plan</button>
				<button role="tab" aria-selected={view === 'map'} onclick={() => (view = 'map')}>Map</button>
				<button role="tab" aria-selected={view === 'wishlist'} onclick={() => (view = 'wishlist')}>Wishlist</button>
			</div>

			{#if view !== 'wishlist'}
				<div class="flex items-center gap-1.5 overflow-x-auto">
					{#each days as day, i (day.date)}
						{@const on = view === 'map' ? visible.has(i) : i === dayIndex}
						<button
							class="tm-chip"
							style={on ? `background:${dayColor(i)};color:#fff` : 'opacity:0.55'}
							onclick={() => (view === 'map' ? toggleDay(i) : (dayIndex = i))}
						>
							{dayLabel(day.date, row.timezone)}
						</button>
					{/each}
					{#if view === 'map'}
						<button
							class="tm-chip"
							style={showUnassigned
								? 'background:var(--tm-day-none);color:#fff;white-space:nowrap'
								: 'opacity:0.55;white-space:nowrap'}
							onclick={() => (showUnassigned = !showUnassigned)}
						>
							Unassigned
						</button>
					{/if}
				</div>
			{/if}

			{#if error}<p class="tm-hint tm-hint--error">{error}</p>{/if}
		</div>

		{#if hotelMissing(row)}
			<div class="tm-card m-4" style="background: var(--tm-warn-soft); border-color: transparent">
				<p class="tm-card__title" style="color: var(--tm-warn-ink)">Hotel location missing</p>
				<p class="tm-card__meta" style="color: var(--tm-warn-ink)">
					This trip was saved before hotels were searchable, so the planner has nothing to
					measure from.
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
			<div class="flex-1"><LeafletMap {markers} {routes} center={centre} /></div>
		{:else if view === 'wishlist'}
			<div class="flex-1 overflow-y-auto p-4">
				{#if !pois.length}
					<div class="tm-card" style="background: var(--tm-surface-2)">
						<p class="tm-card__title">Wishlist is empty</p>
						<p class="tm-card__meta">Add places and they will be arranged into days.</p>
					</div>
				{:else}
					{#each pois as p (p.id)}
						{@const assigned = dayOf.has(p.id)}
						<a
							href="{base}/trip/{tripId}/poi/{p.id}"
							class="tm-result"
							style="align-items: center; text-decoration: none; color: inherit"
						>
							<span style="display: flex; gap: 10px; align-items: flex-start">
								<span
									style="width:12px;height:12px;border-radius:50%;margin-top:4px;flex:none;background:{colorOf(p.id)}"
								></span>
								<span>
									<span class="tm-result__name">{p.name}</span>
									<span class="tm-result__meta" style="display:block">
										{p.category ?? 'place'} · {p.duration_min} min
										{#if isMeal(p.category)} · meal{/if}
										{#if assigned}
											· {dayLabel(days[dayOf.get(p.id)!].date, row.timezone)}
										{:else}
											· {REASON_TEXT[reasonOf.get(p.id) ?? 'not-planned-yet']}
										{/if}
									</span>
								</span>
							</span>
							<span style="color: var(--tm-text-faint)">›</span>
						</a>
					{/each}
					<p class="tm-hint mt-3">
						Tap any place for busyness, booking and how long to stay.
					</p>
				{/if}
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

		<div class="tm-safe-bottom flex items-center justify-between px-4 pt-3" style="border-top: 1px solid var(--tm-border)">
			{#if result?.unplaced.length}
				<button class="tm-chip tm-chip--warn" onclick={() => (view = 'wishlist')}>
					{result.unplaced.length} unplaced
				</button>
			{:else}
				<span class="tm-chip tm-chip--mint">{pois.length} stops</span>
			{/if}
			<a href="{base}/trip/{tripId}/add" class="tm-btn tm-btn--primary" style="min-height:38px;text-decoration:none">
				Add places
			</a>
		</div>
	{/if}
</main>
