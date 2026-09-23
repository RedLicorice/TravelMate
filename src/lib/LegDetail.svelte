<script lang="ts">
	import { legUrl } from '$lib/maps';
	import type { LatLng } from '$lib/trip/days';
	import type { Mode } from '$lib/plan/modes';

	type Props = {
		from: LatLng;
		to: LatLng;
		mode: Mode;
		/** When the traveller sets off, which a transit journey depends on. */
		departAt: string | null;
		timezone: string;
		estimate: { minutes: number; km: number };
		/** An estimate wears a star until the real journey time is worked out. */
		source?: 'estimate' | 'routed';
	};

	let { from, to, mode, departAt, timezone, estimate, source = 'routed' }: Props = $props();
</script>

<!-- The journey itself is Google Maps' to show: tapping opens it there, from
     this card to the next, in this mode -- and for transit, at this hour. -->
<a
	class="tm-leg"
	class:tm-leg--estimate={source === 'estimate'}
	href={legUrl(from, to, mode, departAt, timezone)}
	target="_blank"
	rel="noopener noreferrer"
	style="text-decoration:none;color:inherit;display:flex;align-items:center;gap:7px"
	title={source === 'estimate' ? 'Estimated. The real journey time is being worked out.' : ''}
>
	<span>{estimate.minutes} min{source === 'estimate' ? '*' : ''} · {estimate.km} km · {mode}</span>
	<span style="color: var(--tm-text-faint)" aria-hidden="true">↗</span>
</a>
