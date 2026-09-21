<script lang="ts">
	import Autocomplete from '$lib/Autocomplete.svelte';
	import { poi as provider, type City, type Terminal } from '$lib/poi';
	import { emptyLeg, type JourneyLeg, type JourneyPoint } from '$lib/trip/journey';

	type Props = {
		/** 'arrival' reads left to right towards the city; 'departure' away from it. */
		direction: 'arrival' | 'departure';
		legs: JourneyLeg[];
		city: City | null;
	};
	let { direction, legs = $bindable(), city }: Props = $props();

	const SERVICE: Record<string, string> = {
		airport: 'Flight number',
		train: 'Train number',
		bus: 'Coach number',
		ferry: 'Sailing',
		other: 'Service number'
	};
	const SERVICE_EG: Record<string, string> = {
		airport: 'BA117',
		train: 'IC 9612',
		bus: 'FX010',
		ferry: 'DFDS 1830',
		other: ''
	};

	/** Name the field after whichever end of the leg the traveller has picked. */
	const serviceLabel = (leg: JourneyLeg) =>
		SERVICE[leg.from?.kind ?? leg.to?.kind ?? 'other'] ?? SERVICE.other;
	const servicePlaceholder = (leg: JourneyLeg) =>
		SERVICE_EG[leg.from?.kind ?? leg.to?.kind ?? 'other'] ?? '';

	const toPoint = (t: Terminal): JourneyPoint => ({
		name: t.name,
		lat: t.lat,
		lng: t.lng,
		kind: t.kind
	});

	function patch(i: number, change: Partial<JourneyLeg>) {
		legs = legs.map((leg, j) => (j === i ? { ...leg, ...change } : leg));
	}

	function addLeg() {
		// A connection starts where the last one ended: nobody flies out of a
		// city they did not arrive in, and retyping it is the commonest way to
		// end up with a journey that teleports.
		const previous = legs[legs.length - 1];
		legs = [...legs, { ...emptyLeg(), from: previous?.to ?? null }];
	}

	function removeLeg(i: number) {
		legs = legs.filter((_, j) => j !== i);
	}

	const field = (e: Event) => (e.currentTarget as HTMLInputElement).value.trim() || null;

	/** The leg whose time the plan is built on. */
	const planLeg = $derived(direction === 'arrival' ? legs.length - 1 : 0);
</script>

{#each legs as leg, i (i)}
	<div class="tm-card mt-3" style="background: var(--tm-surface-2)">
		<div class="flex items-baseline justify-between gap-3">
			<span class="tm-label">
				{legs.length > 1 ? `Leg ${i + 1} of ${legs.length}` : 'The journey'}
			</span>
			{#if legs.length > 1}
				<button
					class="tm-btn tm-btn--ghost"
					style="min-height:28px;padding:0 8px;font-size:12px"
					onclick={() => removeLeg(i)}
				>
					Remove
				</button>
			{/if}
		</div>

		<div class="mt-3">
			<Autocomplete
				label="From"
				placeholder={leg.from?.name ?? 'Airport, station or port'}
				hint={leg.from ? `Currently ${leg.from.name}.` : ''}
				search={(q, signal) => provider.searchTerminals(q, city, signal)}
				onpick={(t) => patch(i, { from: toPoint(t) })}
			/>
		</div>

		<div class="mt-3">
			<Autocomplete
				label="To"
				placeholder={leg.to?.name ?? 'Airport, station or port'}
				hint={leg.to ? `Currently ${leg.to.name}.` : ''}
				search={(q, signal) => provider.searchTerminals(q, city, signal)}
				onpick={(t) => patch(i, { to: toPoint(t) })}
			/>
		</div>

		<div class="flex gap-3 mt-3">
			<div class="tm-field" style="flex:2">
				<label class="tm-label" for="{direction}-svc-{i}">{serviceLabel(leg)}</label>
				<input
					class="tm-input"
					id="{direction}-svc-{i}"
					value={leg.service ?? ''}
					placeholder={servicePlaceholder(leg)}
					oninput={(e) => patch(i, { service: field(e) })}
				/>
			</div>
			<div class="tm-field" style="flex:1">
				<label class="tm-label" for="{direction}-ref-{i}">Booking</label>
				<input
					class="tm-input"
					id="{direction}-ref-{i}"
					value={leg.bookingRef ?? ''}
					placeholder="ABC123"
					oninput={(e) => patch(i, { bookingRef: field(e) })}
				/>
			</div>
		</div>

		<div class="flex gap-3 mt-3">
			<div class="tm-field" style="flex:1">
				<label class="tm-label" for="{direction}-dep-{i}">Departs</label>
				<input
					class="tm-input"
					type="datetime-local"
					id="{direction}-dep-{i}"
					value={leg.departLocal ?? ''}
					oninput={(e) => patch(i, { departLocal: field(e) })}
				/>
			</div>
			<div class="tm-field" style="flex:1">
				<label class="tm-label" for="{direction}-arr-{i}">Arrives</label>
				<input
					class="tm-input"
					type="datetime-local"
					id="{direction}-arr-{i}"
					value={leg.arriveLocal ?? ''}
					oninput={(e) => patch(i, { arriveLocal: field(e) })}
				/>
			</div>
		</div>

		<p class="tm-hint mt-2">
			{#if i === planLeg}
				{direction === 'arrival'
					? 'This is where the trip begins: the plan starts from here, at this time.'
					: 'This is the one you must catch: the plan ends in time for it.'}
			{:else}
				Local time at each station, as printed on the ticket. A connection does not
				change the plan in the city, only your record of getting there.
			{/if}
		</p>
	</div>
{/each}

<button class="tm-btn tm-btn--secondary tm-btn--block mt-3" onclick={addLeg}>
	{legs.length ? 'Add a connection' : 'Add the journey'}
</button>
