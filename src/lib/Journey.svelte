<script lang="ts">
	import { tick } from 'svelte';
	import { track } from '$lib/telemetry';
	import Autocomplete from '$lib/Autocomplete.svelte';
	import { poi as provider, type City, type Terminal } from '$lib/poi';
	import { emptyLeg, modeOf, type JourneyLeg, type JourneyMode, type JourneyPoint } from '$lib/trip/journey';

	type Props = {
		/** 'arrival' reads left to right towards the city; 'departure' away from it. */
		direction: 'arrival' | 'departure';
		legs: JourneyLeg[];
		city: City | null;
	};
	let { direction, legs = $bindable(), city }: Props = $props();

	const MODES: { mode: JourneyMode; label: string }[] = [
		{ mode: 'flight', label: 'Flight' },
		{ mode: 'train', label: 'Train' },
		{ mode: 'coach', label: 'Coach' },
		{ mode: 'ferry', label: 'Ferry' },
		{ mode: 'transit', label: 'Public transport' },
		{ mode: 'car', label: 'Car' }
	];

	/** What the service field is called and looks like, per mode. A car has none. */
	const SERVICE: Record<Exclude<JourneyMode, 'car'>, { label: string; eg: string }> = {
		flight: { label: 'Flight number', eg: 'BA117' },
		train: { label: 'Train', eg: 'IC 9612' },
		coach: { label: 'Coach', eg: 'FX010' },
		ferry: { label: 'Sailing', eg: 'DFDS 1830' },
		transit: { label: 'Line', eg: 'Central line' }
	};

	/**
	 * A car has no ticket, so the service and booking it may have carried from
	 * an earlier mode are dropped rather than hidden -- `describe` would print
	 * a flight number after a leg that is now a drive.
	 */
	const setMode = (i: number, mode: JourneyMode) =>
		patch(i, mode === 'car' ? { mode, service: null, bookingRef: null } : { mode });

	const toPoint = (t: Terminal): JourneyPoint => ({
		name: t.name,
		lat: t.lat,
		lng: t.lng,
		kind: t.kind
	});

	function patch(i: number, change: Partial<JourneyLeg>) {
		legs = legs.map((leg, j) => (j === i ? { ...leg, ...change } : leg));
		// Written down because a leg that never appears on the plan is a fault
		// nobody can describe afterwards: this says what was actually set.
		track('journey.leg.patch', {
			direction,
			leg: i,
			legs: legs.length,
			changed: Object.keys(change),
			from: legs[i]?.from?.name ?? null,
			to: legs[i]?.to?.name ?? null,
			mode: legs[i]?.mode ?? null,
			departLocal: legs[i]?.departLocal ?? null,
			arriveLocal: legs[i]?.arriveLocal ?? null
		});
	}

	/**
	 * Insert a leg at `index`, or append when it is past the end.
	 *
	 * The new leg is stitched to its neighbours: it starts where the one above
	 * ended and ends where the one below begins. Getting from Milano Centrale
	 * to Malpensa is a leg like any other, and having to retype both ends of it
	 * is the commonest way to end up with a journey that teleports.
	 */
	function addLeg(index = legs.length) {
		const before = legs[index - 1];
		const after = legs[index];
		const fresh = { ...emptyLeg(), from: before?.to ?? null, to: after?.from ?? null };
		legs = [...legs.slice(0, index), fresh, ...legs.slice(index)];
		track('journey.leg.add', { direction, at: index, legs: legs.length });

		// Put the traveller in it. A card added below the fold, with nothing
		// focused, is a card that looks like it never opened.
		void tick().then(() => {
			const card = document.getElementById(`${direction}-leg-${fresh.id}`);
			card?.scrollIntoView({ block: 'center', behavior: 'smooth' });
			card?.querySelector('input')?.focus();
		});
	}

	function removeLeg(i: number) {
		legs = legs.filter((_, j) => j !== i);
		track('journey.leg.remove', { direction, at: i, legs: legs.length });
	}

	/**
	 * What is in a box while it is being typed in.
	 *
	 * The box owns its own text until the traveller leaves it. Writing every
	 * keystroke back into `legs` -- which is where the value was then drawn
	 * from again -- is what made these unusable: the space in "FR 5410" was
	 * deleted as it was typed, the caret jumped to the end of the line, and a
	 * half-typed date was handed back to the browser as an invalid one and
	 * wiped. Nothing reaches the trip until the box is done with.
	 */
	let draft = $state<Record<string, string>>({});

	// Keyed by the leg itself: drafts used to belong to a position, so adding a
	// connection above one moved what was being typed into the leg below it.
	const keyOf = (i: number, field: string) => `${direction}:${legs[i]?.id ?? i}:${field}`;

	/** What to show: what they are typing, or what the leg already says. */
	const shown = (i: number, field: string, stored: string | null) =>
		draft[keyOf(i, field)] ?? stored ?? '';

	const typing = (i: number, field: string) => (e: Event) => {
		draft[keyOf(i, field)] = (e.currentTarget as HTMLInputElement).value;
	};

	/** Done with it: tidy the text and let the trip have it. */
	const commit = (i: number, field: 'service' | 'bookingRef' | 'departLocal' | 'arriveLocal') =>
		(e: Event) => {
			const raw = (e.currentTarget as HTMLInputElement).value.trim();
			delete draft[keyOf(i, field)];
			patch(i, { [field]: raw || null });
		};

	/** The leg whose time the plan is built on. */
	const planLeg = $derived(direction === 'arrival' ? legs.length - 1 : 0);
</script>

<!-- By the leg, not by where it sits: inserting a connection in the middle
     used to rebuild every box below it. -->
{#each legs as leg, i (leg.id ?? i)}
	{@const mode = modeOf(leg)}
	{#if i > 0}
		<!-- Getting between two terminals is itself a leg: the transfer from a
		     station to the airport it connects to, say. -->
		<button class="tm-slot" style="margin-top:8px" onclick={() => addLeg(i)}>
			<span aria-hidden="true">+</span> Add a step here
		</button>
	{/if}
	<div
		class="tm-card mt-3"
		id="{direction}-leg-{leg.id ?? i}"
		style="background: var(--tm-surface-2)"
	>
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

		<div class="tm-seg mt-3" role="tablist" aria-label="Travelling by">
			{#each MODES as m (m.mode)}
				<button role="tab" aria-selected={mode === m.mode} onclick={() => setMode(i, m.mode)}>
					{m.label}
				</button>
			{/each}
		</div>

		{#if mode !== 'car'}
			<div class="mt-3 flex flex-col gap-3">
				<div class="tm-field">
					<label class="tm-label" for="{direction}-svc-{i}">{SERVICE[mode].label}</label>
					<input
						class="tm-input"
						id="{direction}-svc-{i}"
						value={shown(i, 'service', leg.service)}
						placeholder={SERVICE[mode].eg}
						oninput={typing(i, 'service')}
						onchange={commit(i, 'service')}
					/>
				</div>
				<div class="tm-field">
					<label class="tm-label" for="{direction}-ref-{i}">Booking</label>
					<input
						class="tm-input"
						id="{direction}-ref-{i}"
						value={shown(i, 'bookingRef', leg.bookingRef)}
						placeholder="ABC123"
						oninput={typing(i, 'bookingRef')}
						onchange={commit(i, 'bookingRef')}
					/>
				</div>
			</div>
		{/if}

		<div class="mt-3 flex flex-col gap-3">
			<div class="tm-field">
				<label class="tm-label" for="{direction}-dep-{i}">Departs</label>
				<input
					class="tm-input"
					type="datetime-local"
					id="{direction}-dep-{i}"
					value={shown(i, 'departLocal', leg.departLocal)}
					oninput={typing(i, 'departLocal')}
					onchange={commit(i, 'departLocal')}
				/>
			</div>
			<div class="tm-field">
				<label class="tm-label" for="{direction}-arr-{i}">Arrives</label>
				<input
					class="tm-input"
					type="datetime-local"
					id="{direction}-arr-{i}"
					value={shown(i, 'arriveLocal', leg.arriveLocal)}
					oninput={typing(i, 'arriveLocal')}
					onchange={commit(i, 'arriveLocal')}
				/>
			</div>
		</div>

		<div class="tm-field mt-3">
			<label class="tm-label" for="{direction}-out-{i}">
				Getting out of {leg.to?.name ?? 'there'} takes {leg.outMin ?? 0} min
			</label>
			<input
				id="{direction}-out-{i}"
				type="range"
				min="0"
				max="180"
				step="5"
				value={leg.outMin ?? 0}
				oninput={(e) =>
					patch(i, { outMin: Number((e.currentTarget as HTMLInputElement).value) || null })}
				style="width:100%;accent-color:var(--tm-primary)"
			/>
			<span class="tm-hint">
				Passport queues, baggage reclaim, the walk to the exit. Leave it at zero for a
				platform change.
			</span>
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

<button class="tm-btn tm-btn--secondary tm-btn--block mt-3" onclick={() => addLeg()}>
	{legs.length ? 'Add a connection' : 'Add the journey'}
</button>
