<script lang="ts">
	import type { Terminals } from '$lib/trip/repo';

	/**
	 * How long checking in takes.
	 *
	 * Arriving at the hotel, handing over the bags and being given a key is one
	 * errand with one name, and this is how long the trip should set aside for
	 * it. The same allowance covers collecting the bags on the way out, which
	 * is the other end of the same arrangement.
	 */
	type Props = { terminals: Terminals };
	let { terminals = $bindable() }: Props = $props();
</script>

<div class="tm-field">
	<label class="tm-label" for="checkin">Checking in takes {terminals.bagDropMin} min</label>
	<input
		id="checkin"
		type="range"
		min="0"
		max="120"
		step="15"
		bind:value={terminals.bagDropMin}
		style="width:100%;accent-color:var(--tm-primary)"
	/>
	<span class="tm-hint">
		{terminals.bagDropMin === 0
			? 'Straight out: no stop at the hotel before the city.'
			: 'A card on the arrival day, and again when the bags are collected on the way out.'}
	</span>
</div>
