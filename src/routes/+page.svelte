<script lang="ts">
	import { onMount } from 'svelte';
	import { base } from '$app/paths';
	import { listTrips, toTrip, type TripRow } from '$lib/trip/repo';
	import { tripDays } from '$lib/trip/days';
	import { watchInstall } from '$lib/pwa.svelte';
	import InstallCard from '$lib/InstallCard.svelte';

	let trips = $state<TripRow[]>([]);
	let error = $state<string | null>(null);
	let loading = $state(true);
	let openId = $state<string | null>(null);

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

	/** Shown in the trip's own timezone: 15:00 means 15:00 where they land. */
	const stamp = (iso: string, tz: string) =>
		new Intl.DateTimeFormat(undefined, {
			timeZone: tz,
			weekday: 'short',
			day: 'numeric',
			month: 'short',
			hour: '2-digit',
			minute: '2-digit',
			hour12: false
		}).format(new Date(iso));
</script>

<main class="mx-auto max-w-lg px-6 pb-28">
	<header class="tm-safe-top mb-6 flex items-baseline justify-between">
		<h1 style="font: 700 var(--tm-text-2xl)/1.15 var(--tm-font); letter-spacing: -0.02em">
			Your trips
		</h1>
		<a href="{base}/profile" class="tm-attrib" style="text-decoration: none">Profile</a>
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
				<li class="tm-card" style="padding: 0; overflow: hidden">
					<button
						class="w-full text-left"
						style="background: none; border: none; padding: var(--tm-space-4); cursor: pointer; color: inherit; font: inherit"
						aria-expanded={openId === trip.id}
						onclick={() => (openId = openId === trip.id ? null : trip.id)}
					>
						<p class="tm-card__title">{trip.city}</p>
						<p class="tm-card__meta">{range(trip)} · {dayCount(trip)} days</p>
						<div class="mt-3 flex gap-1.5">
							{#each Array(dots(trip)) as _, i}
								<span
									style="width:11px;height:11px;border-radius:50%;background:var(--tm-day-{i + 1})"
								></span>
							{/each}
						</div>
					</button>

					{#if openId === trip.id}
						<div
							style="border-top: 1px solid var(--tm-border); background: var(--tm-surface-2); padding: var(--tm-space-4)"
						>
							<dl class="flex flex-col gap-3">
								{#each [['City', trip.city], ['Hotel', trip.hotel_name], ['Arrival', stamp(trip.arrival_at, trip.timezone)], ['Departure', stamp(trip.departure_at, trip.timezone)], ['Timezone', trip.timezone]] as [label, value]}
									<div class="flex items-baseline justify-between gap-4">
										<dt
											style="font: 400 var(--tm-text-sm)/1.3 var(--tm-font); color: var(--tm-text-faint); white-space: nowrap"
										>
											{label}
										</dt>
										<dd
											style="font: 500 var(--tm-text-base)/1.3 var(--tm-font); text-align: right"
										>
											{value}
										</dd>
									</div>
								{/each}
							</dl>
							<a
								href="{base}/trip/{trip.id}"
								class="tm-btn tm-btn--primary tm-btn--block mt-4"
								style="text-decoration: none">Open plan</a
							>
						</div>
					{/if}
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
