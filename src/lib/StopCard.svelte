<script lang="ts">
	import { swipeToClose } from '$lib/swipe';
	import { base } from '$app/paths';
	import { PUBLIC_GOOGLE_MAPS_BROWSER_KEY } from '$env/static/public';
	import Stars from '$lib/Stars.svelte';
	import { placeUrl } from '$lib/maps';
	import { haversineKm } from '$lib/plan/geo';
	import { isMeal } from '$lib/plan/meals';
	import { avatarDataUri } from '$lib/avatar';
	import { displayName, type Profile } from '$lib/profile.svelte';
	import type { PoiRow } from '$lib/trip/pois';

	type Props = {
		poi: PoiRow;
		/**
		 * The visit this card is showing, or null for a place opened from the
		 * wishlist, which is on no day and so has nothing to come off. A place
		 * can be on the plan more than once, and "take it off" has to say which.
		 */
		placementId: string | null;
		/** Whether that visit is held where the traveller put it. The place itself has no say. */
		pinned?: boolean;
		tripId: string;
		hotel: { lat: number; lng: number; name: string } | null;
		people: Profile[];
		busy?: boolean;
		/** Quick edits, applied where the traveller is rather than a screen away. */
		onedit: (patch: { duration_min?: number; priority?: number; notes?: string | null }) => void;
		/** Let Replan move this visit again. */
		onrelease: (placementId: string) => void;
		/** Take this visit off the plan. The place stays on the wishlist, where it came from. */
		onunplace: (placementId: string) => void;
		onclose: () => void;
	};

	let {
		poi,
		placementId,
		pinned = false,
		tripId,
		hotel,
		people,
		busy = false,
		onedit,
		onrelease,
		onunplace,
		onclose
	}: Props = $props();

	const STEPS = [15, 30, 45, 60, 90, 120, 180];

	/**
	 * Edited locally and saved on blur, not on every keystroke: a note is a
	 * sentence, and re-timing the day between two letters of it would be
	 * absurd.
	 */
	let notes = $state('');
	let typedFor = $state<string | null>(null);
	$effect(() => {
		// Reset only when the card is showing a different place, so a half
		// written note survives the day being re-timed underneath it.
		if (typedFor === poi.id) return;
		typedFor = poi.id;
		notes = poi.notes ?? '';
	});

	const addedBy = $derived(people.find((p) => p.userId === poi.added_by) ?? null);

	/** The place, and the hotel when there is one, as a still picture. */
	const staticMap = $derived.by(() => {
		if (!PUBLIC_GOOGLE_MAPS_BROWSER_KEY) return null;
		const q = new URLSearchParams({
			center: `${poi.lat},${poi.lng}`,
			zoom: '15',
			size: '640x180',
			scale: '2',
			key: PUBLIC_GOOGLE_MAPS_BROWSER_KEY
		});
		q.append('markers', `color:0xe98a5f|${poi.lat},${poi.lng}`);
		if (hotel) q.append('markers', `color:0x5b8def|label:H|${hotel.lat},${hotel.lng}`);
		return `https://maps.googleapis.com/maps/api/staticmap?${q}`;
	});
	/** A key not allowed the static map answers with an error: then the tile says what tapping does. */
	let mapFailed = $state(false);
	$effect(() => {
		void poi.id;
		mapFailed = false;
	});
	const km = $derived(
		hotel ? haversineKm(hotel, { lat: poi.lat, lng: poi.lng }).toFixed(1) : null
	);
</script>

<div
	role="presentation"
	style="position:fixed;inset:0;z-index:60;background:rgba(0,0,0,0.35)"
	onclick={onclose}
></div>

<div class="tm-sheet" style="position:fixed;z-index:61;max-height:86vh;overflow-y:auto;padding:0" {@attach swipeToClose(onclose)}>
	<!-- Map on top: where a place is answers most of what gets asked about it,
	     and answers it before any reading. A picture of the map, not a map:
	     it does not scroll or zoom, it costs nothing to open the card, and
	     tapping it opens the place in Google Maps. -->
	<a
		href={placeUrl({ lat: poi.lat, lng: poi.lng }, poi.name)}
		target="_blank"
		rel="noopener noreferrer"
		aria-label="Open {poi.name} in Google Maps"
		style="display:grid;place-items:center;height:180px;background:var(--tm-surface-2);color:var(--tm-text-muted);text-decoration:none;font:600 var(--tm-text-sm)/1 var(--tm-font)"
	>
		{#if staticMap && !mapFailed}
			<img
				src={staticMap}
				alt=""
				width="640"
				height="180"
				style="width:100%;height:180px;object-fit:cover"
				onerror={() => (mapFailed = true)}
			/>
		{:else}
			Open in Google Maps
		{/if}
	</a>

	<div style="padding: var(--tm-space-3) var(--tm-space-4) var(--tm-space-4)">
		<p class="tm-card__title">{poi.name}</p>
		{#if poi.address}<p class="tm-card__meta">{poi.address}</p>{/if}
		<p class="tm-card__meta">
			{poi.category ?? 'place'}
			{#if km} · {km} km from {hotel?.name}{/if}
			{#if isMeal(poi.category)} · somewhere to eat{/if}
		</p>

		{#if addedBy}
			<div class="mt-2 flex items-center gap-2">
				<img
					src={addedBy.avatarUrl ?? avatarDataUri(addedBy.avatarSeed)}
					alt=""
					width="20"
					height="20"
					style="width:20px;height:20px;border-radius:50%;object-fit:cover"
				/>
				<span class="tm-hint">{displayName(addedBy)} added this</span>
			</div>
		{/if}

		<h3 class="tm-label mt-4 mb-2">How wanted</h3>
		<Stars value={poi.priority} label="Wanted" onchange={(v) => onedit({ priority: v })} />

		<h3 class="tm-label mt-4 mb-2">How long</h3>
		<div class="flex flex-wrap gap-2">
			{#each STEPS as m}
				<button
					class="tm-chip"
					aria-pressed={poi.duration_min === m}
					disabled={busy}
					style={poi.duration_min === m
						? 'background: var(--tm-peach-soft); color: var(--tm-peach-ink)'
						: 'opacity: 0.6'}
					onclick={() => onedit({ duration_min: m })}
				>
					{m < 60 ? `${m} min` : `${m / 60} h`}
				</button>
			{/each}
		</div>

		<div class="tm-field mt-4">
			<label class="tm-label" for="card-notes">Notes</label>
			<textarea
				class="tm-input"
				id="card-notes"
				rows="3"
				style="padding-top: 10px; padding-bottom: 10px; min-height: auto"
				bind:value={notes}
				placeholder="Booking reference, who recommended it, what to order…"
				onblur={() => {
					const next = notes.trim() || null;
					if (next !== (poi.notes ?? null)) onedit({ notes: next });
				}}
			></textarea>
		</div>

		{#if pinned && placementId}
			<button
				class="tm-btn tm-btn--secondary tm-btn--block mt-4"
				disabled={busy}
				onclick={() => onrelease(placementId)}
			>
				Let the plan move it
			</button>
		{/if}

		<a
			class="tm-btn tm-btn--secondary tm-btn--block mt-2"
			style="text-decoration:none"
			href={placeUrl({ lat: poi.lat, lng: poi.lng }, poi.name)}
			target="_blank"
			rel="noopener noreferrer"
		>
			Open in Maps
		</a>

		<a
			class="tm-btn tm-btn--secondary tm-btn--block mt-2"
			style="text-decoration:none"
			href="{base}/trip/{tripId}/poi/{poi.id}"
		>
			Everything about it
		</a>

		<!-- Off the plan, not off the trip. Taking a place out of a day is
		     saying "not this day", not "never mind" -- and the two were the
		     same button, so a stop removed from the plan vanished from the
		     wishlist as well. Deleting it for good lives on its own page,
		     behind a confirmation, which is where something irreversible
		     belongs. -->
		{#if placementId}
			<button
				class="tm-btn tm-btn--secondary tm-btn--block mt-2"
				disabled={busy}
				onclick={() => onunplace(placementId)}
			>
				Take it off the plan
			</button>
			<p class="tm-hint mt-1" style="text-align:center">
				Back to the wishlist. Everything about it has the delete.
			</p>
		{/if}
		<button class="tm-btn tm-btn--ghost tm-btn--block mt-2" onclick={onclose}>Close</button>
	</div>
</div>
