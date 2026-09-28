<script lang="ts">
	import type { Mode } from '$lib/plan/modes';

	type Props = {
		mode: Mode;
		estimate: { minutes: number; km: number };
		/** An estimate wears a star until the real journey time is worked out. */
		source?: 'estimate' | 'routed';
		/** The route the traveller chose for this journey, when they chose one: said instead of the mode. */
		summary?: string | null;
		/** Tapped: the journey's own sheet, with its map and the way into Google Maps. */
		onopen: () => void;
		/**
		 * When the journey sets off and arrives, in ms: the day's rail reads
		 * its hours off them (see measure in dnd.svelte.ts).
		 */
		from?: number;
		to?: number;
	};

	let { mode, estimate, source = 'routed', summary = null, onopen, from, to }: Props = $props();
</script>

<button
	class="tm-leg"
	class:tm-leg--estimate={source === 'estimate'}
	data-start={from}
	data-end={to}
	onclick={onopen}
	style="background:none;border:none;padding:0;cursor:pointer;font:inherit;color:inherit;display:flex;align-items:center;gap:7px;text-align:left"
	title={source === 'estimate' ? 'Estimated. The real journey time is being worked out.' : ''}
>
	<span>{estimate.minutes} min{source === 'estimate' ? '*' : ''} · {estimate.km} km · {summary ?? mode}</span>
	<span style="color: var(--tm-text-faint)" aria-hidden="true">›</span>
</button>
