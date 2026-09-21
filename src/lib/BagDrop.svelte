<script lang="ts">
	import type { Terminals } from '$lib/trip/repo';

	type Props = { terminals: Terminals };
	let { terminals = $bindable() }: Props = $props();
</script>

<div class="tm-field">
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
