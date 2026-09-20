<script lang="ts">
	import { onMount } from 'svelte';
	import { base } from '$app/paths';
	import { listTrips, toTrip, type TripRow } from '$lib/trip/repo';
	import { tripDays } from '$lib/trip/days';
	import { signOut } from '$lib/session.svelte';

	let trips = $state<TripRow[]>([]);
	let error = $state<string | null>(null);
	let loading = $state(true);

	onMount(async () => {
		try {
			trips = await listTrips();
		} catch (e) {
			error = (e as Error).message;
		} finally {
			loading = false;
		}
	});

	// The ramp only has 8 entries; a longer trip stops adding dots rather than
	// wrapping round to day 1, which would read as two days sharing a colour.
	const dots = (row: TripRow) => Math.min(tripDays(toTrip(row)).length, 8);

	const dates = (row: TripRow) =>
		new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).formatRange(
			new Date(row.arrival_at),
			new Date(row.departure_at)
		);
</script>

<main class="mx-auto max-w-lg p-6 pb-28">
	<header class="mb-6 flex items-baseline justify-between">
		<h1 style="font: 700 var(--tm-text-2xl)/1.15 var(--tm-font); letter-spacing: -0.02em">
			Your trips
		</h1>
		<button class="tm-btn tm-btn--ghost" style="min-height: auto; padding: 0" onclick={signOut}>
			Sign out
		</button>
	</header>

	{#if loading}
		<p style="color: var(--tm-text-faint)">Loading…</p>
	{:else if error}
		<p class="tm-hint tm-hint--error">{error}</p>
	{:else if trips.length === 0}
		<div class="tm-card" style="background: var(--tm-surface-2)">
			<p style="color: var(--tm-text-muted)">No trips yet. Where are you going?</p>
		</div>
	{:else}
		<ul class="flex flex-col gap-3">
			{#each trips as trip (trip.id)}
				<li>
					<a href="{base}/trip/{trip.id}" class="tm-card block">
						<p class="tm-card__title">{trip.city}</p>
						<p class="tm-card__meta">{dates(trip)} · {tripDays(toTrip(trip)).length} days</p>
						<div class="mt-3 flex gap-1.5">
							{#each Array(dots(trip)) as _, i}
								<span
									style="width:11px;height:11px;border-radius:50%;background:var(--tm-day-{i + 1})"
								></span>
							{/each}
						</div>
					</a>
				</li>
			{/each}
		</ul>
	{/if}

	<div class="fixed inset-x-0 bottom-0 p-6">
		<a
			href="{base}/trip/new"
			class="tm-btn tm-btn--primary tm-btn--block mx-auto max-w-lg"
			style="text-decoration: none"
		>
			Plan a new trip
		</a>
	</div>
</main>
