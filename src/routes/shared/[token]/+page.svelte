<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { getSharedTrip, joinTrip, toTrip, type TripRow } from '$lib/trip/repo';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { session } from '$lib/session.svelte';
	import { toPlanPoi, type PoiRow } from '$lib/trip/pois';
	import { tripDays } from '$lib/trip/days';
	import { schedule, type PlanResult } from '$lib/plan/planner';
	import { resolveCurves, type CrowdCurves } from '$lib/plan/crowd';
	import type { Mode } from '$lib/plan/modes';

	let row = $state<TripRow | null>(null);
	let pois = $state<PoiRow[]>([]);
	let loading = $state(true);
	let gone = $state(false);
	let error = $state<string | null>(null);
	let joining = $state(false);
	let curves = $state<CrowdCurves | undefined>(undefined);

	onMount(async () => {
		try {
			const shared = await getSharedTrip(page.params.token!);
			if (!shared) {
				gone = true;
				return;
			}
			row = shared.trip;
			pois = shared.pois ?? [];
			curves = await resolveCurves(
				pois.map((x) => ({ id: x.id, category: x.category })),
				tripDays(toTrip(row)),
				row.timezone
			);
		} catch (e) {
			error = (e as Error).message;
		} finally {
			loading = false;
		}
	});

	async function join() {
		joining = true;
		error = null;
		try {
			const id = await joinTrip(page.params.token!);
			if (!id) {
				gone = true;
				return;
			}
			await goto(`${base}/trip/${id}`, { replaceState: true });
		} catch (e) {
			error = (e as Error).message;
			joining = false;
		}
	}

	const days = $derived(row ? tripDays(toTrip(row)) : []);

	const result = $derived<PlanResult | null>(
		row && days.length
			? schedule({
					pois: pois.map(toPlanPoi),
					days,
					allowedModes: row.allowed_modes as Mode[],
					timezone: row.timezone,
					curves
				})
			: null
	);

	const hhmm = (d: Date, tz: string) =>
		new Intl.DateTimeFormat(undefined, { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);

	const dayLabel = (iso: string, tz: string) =>
		new Intl.DateTimeFormat(undefined, { timeZone: tz, weekday: 'long', day: 'numeric', month: 'short' })
			.format(new Date(`${iso}T12:00:00Z`));

	const dayColor = (i: number) => `var(--tm-day-${Math.min(i + 1, 8)})`;
</script>

<main class="mx-auto max-w-lg px-6 pb-16">
	<header class="tm-safe-top mb-6">
		<p class="tm-attrib">Shared plan</p>
		{#if row}
			<h1 style="font: 700 var(--tm-text-2xl)/1.15 var(--tm-font); letter-spacing: -0.02em">
				{row.city}
			</h1>
			<p class="tm-card__meta">{row.hotel_name}</p>
		{/if}
	</header>

	{#if loading}
		<p style="color: var(--tm-text-faint)">Loading…</p>
	{:else if gone}
		<!-- A revoked token and a token that never existed are the same answer.
		     Saying which would confirm that a given link once worked. -->
		<div class="tm-card" style="background: var(--tm-surface-2)">
			<p class="tm-card__title">This link is not active</p>
			<p class="tm-card__meta">It may have been turned off by whoever shared it.</p>
		</div>
	{:else if error}
		<p class="tm-hint tm-hint--error">{error}</p>
	{:else if row && result}
		{#each result.days as day, i (day.date)}
			<section class="mb-6" style="--tm-stop-day: {dayColor(i)}">
				<div class="mb-2 flex items-center gap-2">
					<span style="width:11px;height:11px;border-radius:50%;background:{dayColor(i)}"></span>
					<h2 style="font: 600 var(--tm-text-lg)/1.2 var(--tm-font)">
						{dayLabel(day.date, row.timezone)}
					</h2>
				</div>
				{#if day.stops.filter((s) => !s.anchor).length === 0}
					<p class="tm-hint">Nothing planned.</p>
				{:else}
					{#each day.stops as stop, j (stop.name + j)}
						{#if stop.legIn}
							<div class="tm-leg">
								<span>{stop.legIn.minutes} min · {stop.legIn.mode}</span>
							</div>
						{/if}
						<div class="tm-stop" class:tm-stop--anchor={stop.anchor}>
							<span class="tm-stop__time">{hhmm(stop.arrive, row.timezone)}</span>
							<div>
								<p class="tm-stop__name">{stop.name}</p>
								<p class="tm-stop__sub">{stop.durationMin ? `${stop.durationMin} min` : 'anchor'}</p>
							</div>
						</div>
					{/each}
				{/if}
			</section>
		{/each}
		{#if session.user}
			<div class="tm-card" style="background: var(--tm-peach-soft); border-color: transparent">
				<p class="tm-card__title" style="color: var(--tm-peach-ink)">Travelling too?</p>
				<p class="tm-card__meta" style="color: var(--tm-peach-ink)">
					Join and the plan will take your meal times into account alongside everyone else's.
				</p>
				<button class="tm-btn tm-btn--primary tm-btn--block mt-3" onclick={join} disabled={joining}>
					{joining ? 'Joining…' : 'Join this trip'}
				</button>
			</div>
		{:else}
			<p class="tm-hint">Sign in to join this trip and add places of your own.</p>
		{/if}
		<p class="tm-attrib mt-4">© OpenStreetMap contributors</p>
	{/if}
</main>
