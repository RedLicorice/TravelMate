<script lang="ts">
	import Autocomplete from '$lib/Autocomplete.svelte';
	import { poi as provider, ADVANCE_DEFAULT, type City, type Terminal, type TerminalKind } from '$lib/poi';
	import type { Terminals } from '$lib/trip/repo';

	type Props = { terminals: Terminals; city: City | null };
	let { terminals = $bindable(), city }: Props = $props();

	/**
	 * Presence of an arrival or departure point is the switch. There is no
	 * separate flag, because a flag can disagree with the data -- and then the
	 * traveller sees an airport on screen that the planner quietly ignores.
	 */
	let on = $state(!!(terminals.arrivalName || terminals.departureName));

	function toggle() {
		on = !on;
		if (!on) {
			terminals = {
				...terminals,
				arrivalName: null, arrivalLat: null, arrivalLng: null, arrivalKind: null,
				arrivalService: null, arrivalBookingRef: null,
				departureName: null, departureLat: null, departureLng: null, departureKind: null,
				departureService: null, departureBookingRef: null
			};
		}
	}

	const NOUN: Record<string, string> = {
		airport: 'airport', train: 'station', bus: 'coach station', ferry: 'ferry terminal', other: 'terminal'
	};

	/** What the ticket calls the service, so the field asks for what they hold. */
	const SERVICE: Record<string, string> = {
		airport: 'Flight number', train: 'Train number', bus: 'Coach number',
		ferry: 'Sailing', other: 'Service number'
	};
	const SERVICE_EG: Record<string, string> = {
		airport: 'BA117', train: 'IC 9612', bus: 'FX010', ferry: 'DFDS 1830', other: ''
	};

	const arrivalService = $derived(SERVICE[terminals.arrivalKind ?? 'other'] ?? SERVICE.other);
	const departureService = $derived(SERVICE[terminals.departureKind ?? 'other'] ?? SERVICE.other);

	function pickArrival(t: Terminal) {
		terminals = { ...terminals, arrivalName: t.name, arrivalLat: t.lat, arrivalLng: t.lng, arrivalKind: t.kind };
	}

	function pickDeparture(t: Terminal) {
		terminals = {
			...terminals,
			departureName: t.name, departureLat: t.lat, departureLng: t.lng, departureKind: t.kind,
			// Only follow the kind's default while the traveller has not moved
			// the slider themselves -- overwriting a deliberate 90 minutes with
			// 120 because they re-picked the airport would be rude.
			departureBufferMin: touchedAdvance ? terminals.departureBufferMin : ADVANCE_DEFAULT[t.kind]
		};
	}

	let touchedAdvance = $state(false);

	/** Empty means unset, not an empty string: the column is nullable. */
	const value = (e: Event) => (e.currentTarget as HTMLInputElement).value.trim() || null;

	const advanceLabel = $derived(
		terminals.departureBufferMin >= 60
			? `${Math.floor(terminals.departureBufferMin / 60)} h${terminals.departureBufferMin % 60 ? ` ${terminals.departureBufferMin % 60} min` : ''}`
			: `${terminals.departureBufferMin} min`
	);

	const departureNoun = $derived(NOUN[terminals.departureKind ?? 'other'] ?? 'terminal');
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
			<span class="tm-label">Arriving by plane, train or boat</span>
			<span class="tm-hint" style="display:block">
				Day one starts at the terminal and drops your bags at the hotel. The last day ends with the
				journey back.
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
	<div class="mt-4">
		<Autocomplete
			label="Arriving at"
			placeholder={terminals.arrivalName ?? 'Airport, station or port'}
			hint={terminals.arrivalName ? `Currently ${terminals.arrivalName}.` : 'Where you land.'}
			search={(q, signal) => provider.searchTerminals(q, city, signal)}
			onpick={pickArrival}
		/>
	</div>

	<div class="flex gap-3 mt-4">
		<div class="tm-field" style="flex:2">
			<label class="tm-label" for="arrsvc">{arrivalService}</label>
			<input
				class="tm-input"
				id="arrsvc"
				value={terminals.arrivalService ?? ''}
				placeholder={SERVICE_EG[terminals.arrivalKind ?? 'other']}
				oninput={(e) => (terminals = { ...terminals, arrivalService: value(e) })}
			/>
		</div>
		<div class="tm-field" style="flex:1">
			<label class="tm-label" for="arrref">Booking</label>
			<input
				class="tm-input"
				id="arrref"
				value={terminals.arrivalBookingRef ?? ''}
				placeholder="ABC123"
				oninput={(e) => (terminals = { ...terminals, arrivalBookingRef: value(e) })}
			/>
		</div>
	</div>

	<div class="tm-field mt-4">
		<label class="tm-label" for="arrbuf">
			Getting out takes about {terminals.arrivalBufferMin} min
		</label>
		<input
			id="arrbuf"
			type="range"
			min="0"
			max="180"
			step="15"
			bind:value={terminals.arrivalBufferMin}
			style="width:100%;accent-color:var(--tm-primary)"
		/>
		<span class="tm-hint">Passport queues, baggage reclaim. Nothing is planned before this.</span>
	</div>

	<div class="mt-4">
		<Autocomplete
			label="Leaving from"
			placeholder={terminals.departureName ?? 'Airport, station or port'}
			hint={terminals.departureName ? `Currently ${terminals.departureName}.` : 'Where you leave from.'}
			search={(q, signal) => provider.searchTerminals(q, city, signal)}
			onpick={pickDeparture}
		/>
	</div>

	<div class="flex gap-3 mt-4">
		<div class="tm-field" style="flex:2">
			<label class="tm-label" for="depsvc">{departureService}</label>
			<input
				class="tm-input"
				id="depsvc"
				value={terminals.departureService ?? ''}
				placeholder={SERVICE_EG[terminals.departureKind ?? 'other']}
				oninput={(e) => (terminals = { ...terminals, departureService: value(e) })}
			/>
		</div>
		<div class="tm-field" style="flex:1">
			<label class="tm-label" for="depref">Booking</label>
			<input
				class="tm-input"
				id="depref"
				value={terminals.departureBookingRef ?? ''}
				placeholder="ABC123"
				oninput={(e) => (terminals = { ...terminals, departureBookingRef: value(e) })}
			/>
		</div>
	</div>

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
			Check-in. The plan has you standing in the {departureNoun} {advanceLabel} before you
			leave -- the journey there is counted, not squeezed in afterwards.
		</span>
	</div>

	<div class="tm-field mt-4">
		<label class="tm-label" for="bags">Dropping bags takes {terminals.bagDropMin} min</label>
		<input
			id="bags"
			type="range"
			min="0"
			max="120"
			step="15"
			bind:value={terminals.bagDropMin}
			style="width:100%;accent-color:var(--tm-primary)"
		/>
		<span class="tm-hint">
			{terminals.bagDropMin === 0
				? 'Travelling light: no hotel stop before sightseeing.'
				: 'The hotel is a fixed stop on arrival and before leaving.'}
		</span>
	</div>
{/if}
