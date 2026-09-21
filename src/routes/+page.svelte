<script lang="ts">
	import { onMount } from 'svelte';
	import { base } from '$app/paths';
	import { listTrips, toTrip, type TripRow } from '$lib/trip/repo';
	import { tripDays } from '$lib/trip/days';
	import { watchInstall } from '$lib/pwa.svelte';
	import InstallCard from '$lib/InstallCard.svelte';
	import ProfileButton from '$lib/ProfileButton.svelte';
	import TripAvatar from '$lib/TripAvatar.svelte';

	let trips = $state<TripRow[]>([]);
	let error = $state<string | null>(null);
	let loading = $state(true);

	onMount(() => {
		const stop = watchInstall();
		listTrips()
			.then((t) => (trips = t))
			.catch((e) => (error = (e as Error).message))
			.finally(() => (loading = false));
		return stop;
	});

	// The ramp holds 8 colours; a longer trip stops adding dots rather than
	// wrapping to day 1, which would show two days sharing a colour.
	const dots = (row: TripRow) => Math.min(tripDays(toTrip(row)).length, 8);
	const dayCount = (row: TripRow) => tripDays(toTrip(row)).length;

	const range = (row: TripRow) =>
		new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).formatRange(
			new Date(row.arrival_at),
			new Date(row.departure_at)
		);

</script>

<main class="mx-auto max-w-lg px-6 pb-28">
	<header class="tm-safe-top mb-6 flex items-center justify-between gap-4">
		<h1 style="font: 700 var(--tm-text-2xl)/1.15 var(--tm-font); letter-spacing: -0.02em">
			Your trips
		</h1>
		<ProfileButton />
	</header>

	<InstallCard />

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
					<a
						href="{base}/trip/{trip.id}"
						class="tm-card flex items-center gap-3"
						style="text-decoration: none"
					>
						<TripAvatar
							imageUrl={trip.image_url}
							countryCode={trip.country_code}
							city={trip.city}
						/>
						<span style="min-width: 0; flex: 1">
							<span class="tm-card__title" style="display:block">{trip.city}</span>
							<span class="tm-card__meta" style="display:block">
								{range(trip)} · {dayCount(trip)} days
							</span>
							<span class="mt-3 flex gap-1.5">
								{#each Array(dots(trip)) as _, i}
									<span
										style="width:11px;height:11px;border-radius:50%;background:var(--tm-day-{i + 1})"
									></span>
								{/each}
							</span>
						</span>
					</a>
				</li>
			{/each}
		</ul>
	{/if}

	<div class="tm-safe-bottom fixed inset-x-0 bottom-0 px-6 pt-3">
		<a
			href="{base}/trip/new"
			class="tm-btn tm-btn--primary tm-btn--block mx-auto max-w-lg"
			style="text-decoration: none">Plan a new trip</a
		>
	</div>
</main>
