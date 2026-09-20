<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { base } from '$app/paths';
	import { getTrip, toTrip, type TripRow } from '$lib/trip/repo';
	import { tripDays, type Day } from '$lib/trip/days';

	let row = $state<TripRow | null>(null);
	let days = $state<Day[]>([]);
	let error = $state<string | null>(null);
	let loading = $state(true);

	onMount(async () => {
		try {
			row = await getTrip(page.params.id!);
			if (row) days = tripDays(toTrip(row));
		} catch (e) {
			error = (e as Error).message;
		} finally {
			loading = false;
		}
	});

	const time = (d: Date, tz: string) =>
		new Intl.DateTimeFormat(undefined, {
			timeZone: tz,
			hour: '2-digit',
			minute: '2-digit',
			hour12: false
		}).format(d);

	const weekday = (iso: string, tz: string) =>
		new Intl.DateTimeFormat(undefined, { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' })
			.format(new Date(`${iso}T12:00:00Z`));

	const hours = (min: number) =>
		min === 0 ? 'no time' : `${Math.floor(min / 60)}h${min % 60 ? ` ${min % 60}m` : ''}`;
</script>

<main class="mx-auto max-w-lg p-6 pb-28">
	<a href="{base}/" class="tm-btn tm-btn--ghost" style="min-height:auto;padding:0">← Trips</a>

	{#if loading}
		<p class="mt-6" style="color: var(--tm-text-faint)">Loading…</p>
	{:else if error}
		<p class="tm-hint tm-hint--error mt-6">{error}</p>
	{:else if !row}
		<!-- maybeSingle returns null both for a deleted trip and for one owned by
		     someone else: RLS filters rather than erroring. Same message either
		     way, because distinguishing them would leak that the id exists. -->
		<div class="tm-card mt-6" style="background: var(--tm-surface-2)">
			<p class="tm-card__title">Trip not found</p>
			<p class="tm-card__meta">It may have been deleted, or belong to another account.</p>
		</div>
	{:else}
		<h1 class="mt-3" style="font: 700 var(--tm-text-2xl)/1.15 var(--tm-font); letter-spacing: -0.02em">
			{row.city}
		</h1>
		<p class="tm-card__meta">{row.hotel_name} · {row.timezone}</p>

		<ul class="mt-6 flex flex-col gap-3">
			{#each days as day, i (day.date)}
				<li class="tm-card" style="border-left: 3px solid var(--tm-day-{Math.min(i + 1, 8)})">
					<div class="flex items-baseline justify-between">
						<p class="tm-card__title">{weekday(day.date, row.timezone)}</p>
						<span class="tm-chip" class:tm-chip--warn={day.usableMin === 0}>
							{hours(day.usableMin)}
						</span>
					</div>
					<p class="tm-card__meta">
						{time(day.start, row.timezone)} – {time(day.end, row.timezone)}
					</p>
					<p class="tm-card__meta" style="margin-top: 6px">
						{day.fixedStart.map((w) => w.name).join(' → ')} … {day.fixedEnd
							.map((w) => w.name)
							.join(' → ')}
					</p>
				</li>
			{/each}
		</ul>

		<div class="tm-card mt-6" style="background: var(--tm-surface-2)">
			<p class="tm-card__meta">
				No places yet. Adding them is phase 2 — the planner needs stops before it has anything to
				arrange.
			</p>
		</div>
	{/if}
</main>
