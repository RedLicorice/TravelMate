<script lang="ts">
	import { base } from '$app/paths';
	import TripMap from '$lib/GoogleMap.svelte';
	import Stars from '$lib/Stars.svelte';
	import { placeUrl } from '$lib/maps';
	import { haversineKm } from '$lib/plan/geo';
	import { isMeal } from '$lib/plan/meals';
	import { avatarDataUri } from '$lib/avatar';
	import { displayName, type Profile } from '$lib/profile.svelte';
	import type { PoiRow } from '$lib/trip/pois';

	type Props = {
		poi: PoiRow;
		tripId: string;
		hotel: { lat: number; lng: number; name: string } | null;
		people: Profile[];
		busy?: boolean;
		/** Quick edits, applied where the traveller is rather than a screen away. */
		onedit: (patch: { duration_min?: number; priority?: number; pinned?: boolean }) => void;
		onremove: () => void;
		onclose: () => void;
	};

	let { poi, tripId, hotel, people, busy = false, onedit, onremove, onclose }: Props = $props();

	const STEPS = [15, 30, 45, 60, 90, 120, 180];

	const addedBy = $derived(people.find((p) => p.userId === poi.added_by) ?? null);
	const km = $derived(
		hotel ? haversineKm(hotel, { lat: poi.lat, lng: poi.lng }).toFixed(1) : null
	);
</script>

<div
	role="presentation"
	style="position:fixed;inset:0;z-index:60;background:rgba(0,0,0,0.35)"
	onclick={onclose}
></div>

<div class="tm-sheet" style="position:fixed;z-index:61;max-height:86vh;overflow-y:auto;padding:0">
	<!-- Map on top: where a place is answers most of what gets asked about it,
	     and answers it before any reading. -->
	<div style="height:180px">
		<TripMap
			markers={[
				{ id: poi.id, lat: poi.lat, lng: poi.lng, color: 'var(--tm-primary)', selected: true },
				...(hotel ? [{ id: 'hotel', lat: hotel.lat, lng: hotel.lng, glyph: 'H', color: 'var(--tm-sky)' }] : [])
			]}
			routes={[]}
			center={{ lat: poi.lat, lng: poi.lng }}
			zoom={15}
		/>
	</div>

	<div style="padding: var(--tm-space-3) var(--tm-space-4) var(--tm-space-4)">
		<p class="tm-card__title">{poi.name}</p>
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

		{#if poi.pinned}
			<button
				class="tm-btn tm-btn--secondary tm-btn--block mt-4"
				disabled={busy}
				onclick={() => onedit({ pinned: false })}
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

		<button
			class="tm-btn tm-btn--block mt-2"
			style="background: var(--tm-danger-soft); color: var(--tm-danger-ink)"
			disabled={busy}
			onclick={onremove}
		>
			Remove from the trip
		</button>
		<button class="tm-btn tm-btn--ghost tm-btn--block mt-2" onclick={onclose}>Close</button>
	</div>
</div>
