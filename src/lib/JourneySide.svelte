<script lang="ts">
	import Journey from '$lib/Journey.svelte';
	import { ADVANCE_DEFAULT, type City, type TerminalKind } from '$lib/poi';
	import { endpointOf } from '$lib/trip/journey';
	import type { Terminals } from '$lib/trip/repo';

	/**
	 * One end of the trip: how the traveller gets in, or how they get out.
	 *
	 * Each end stands on its own -- its own legs, its own allowance, its own
	 * switch -- because they are planned at different times and for different
	 * reasons. Somebody who knows their flight in but not their flight home
	 * should be able to say so.
	 */
	type Props = { direction: 'arrival' | 'departure'; terminals: Terminals; city: City | null };
	let { direction, terminals = $bindable(), city }: Props = $props();

	const legs = $derived(
		direction === 'arrival' ? terminals.arrivalLegs : terminals.departureLegs
	);

	/**
	 * Having a journey is the switch. There is no separate flag, because a flag
	 * can disagree with the data -- and then the traveller sees an airport on
	 * screen that the planner quietly ignores.
	 *
	 * The one thing a flag is needed for is the moment between turning it on
	 * and adding the first leg, which is why `opened` exists at all.
	 */
	let opened = $state(false);
	const on = $derived(opened || legs.length > 0);

	function toggle() {
		if (on) {
			opened = false;
			terminals =
				direction === 'arrival'
					? { ...terminals, arrivalLegs: [] }
					: { ...terminals, departureLegs: [] };
		} else {
			opened = true;
		}
	}

	const NOUN: Record<string, string> = {
		airport: 'airport',
		train: 'station',
		bus: 'coach station',
		ferry: 'ferry terminal',
		other: 'terminal'
	};

	/** The one they have to catch, which is what "be there in advance" is about. */
	const leaving = $derived(endpointOf(terminals.departureLegs, 'departure'));
	const departureNoun = $derived(NOUN[leaving?.point.kind ?? 'other'] ?? 'terminal');

	// Follow the kind's default only while the traveller has not moved the
	// slider themselves -- replacing a deliberate 90 minutes with 120 because
	// they re-picked the airport would be rude.
	let touchedAdvance = $state(false);
	$effect(() => {
		if (direction !== 'departure') return;
		const kind = leaving?.point.kind as TerminalKind | undefined;
		if (!touchedAdvance && kind) {
			terminals = { ...terminals, departureBufferMin: ADVANCE_DEFAULT[kind] };
		}
	});

	const advanceLabel = $derived(
		terminals.departureBufferMin >= 60
			? `${Math.floor(terminals.departureBufferMin / 60)} h${terminals.departureBufferMin % 60 ? ` ${terminals.departureBufferMin % 60} min` : ''}`
			: `${terminals.departureBufferMin} min`
	);
</script>

<div class="tm-field" style="gap: var(--tm-space-3)">
	<button
		type="button"
		role="switch"
		aria-checked={on}
		onclick={toggle}
		style="display:flex;align-items:center;justify-content:space-between;gap:12px;
		background:none;border:none;padding:0;cursor:pointer;color:inherit;text-align:left"
	>
		<span>
			<span class="tm-label">
				{direction === 'arrival' ? 'Arrival journey' : 'Departure journey'}
			</span>
			<span class="tm-hint" style="display:block">
				{direction === 'arrival'
					? 'Day one starts where you land and checks in at the hotel.'
					: 'The last day ends in time for the journey out.'}
			</span>
		</span>
		<span
			style="flex:none;width:44px;height:26px;border-radius:999px;position:relative;
			background:{on ? 'var(--tm-primary)' : 'var(--tm-border-strong)'};transition:background var(--tm-motion)"
		>
			<span
				style="position:absolute;top:3px;left:{on ? 21 : 3}px;width:20px;height:20px;border-radius:50%;
				background:var(--tm-surface);transition:left var(--tm-motion)"
			></span>
		</span>
	</button>
</div>

{#if on}
	<p class="tm-hint mt-3">
		{direction === 'arrival'
			? 'One leg, or several. Rome to Milan by train and Milan to London by air is one arrival.'
			: 'One leg, or several, the way you are going home.'}
	</p>

	{#if direction === 'arrival'}
		<Journey direction="arrival" bind:legs={terminals.arrivalLegs} {city} />
	{:else}
		<Journey direction="departure" bind:legs={terminals.departureLegs} {city} />

		<div class="tm-field mt-4">
			<label class="tm-label" for="advance">Be there {advanceLabel} in advance</label>
			<input
				id="advance"
				type="range"
				min="0"
				max="240"
				step="15"
				bind:value={terminals.departureBufferMin}
				oninput={() => (touchedAdvance = true)}
				style="width:100%;accent-color:var(--tm-primary)"
			/>
			<span class="tm-hint">
				The plan has you standing in the {departureNoun} {advanceLabel} before you leave -- the
				journey there is counted, not squeezed in afterwards.
			</span>
		</div>
	{/if}
{/if}
