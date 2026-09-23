<script lang="ts">
	import { formatter } from '$lib/clock';
	import { groupSteps, legRoute, type LegRoute } from '$lib/plan/route';
	import { legUrl } from '$lib/maps';
	import type { LatLng } from '$lib/trip/days';
	import type { Mode } from '$lib/plan/modes';

	type Props = {
		from: LatLng;
		to: LatLng;
		mode: Mode;
		/** When the traveller sets off, which is what makes a transit answer real. */
		departAt: string | null;
		timezone: string;
		estimate: { minutes: number; km: number };
		/**
		 * Where the figure came from. An estimate wears a star until the real
		 * journey comes back, which it does on its own.
		 */
		source?: 'estimate' | 'routed';
		onroute?: (route: LegRoute | null) => void;
	};

	let { from, to, mode, departAt, timezone, estimate, source = 'routed', onroute }: Props =
		$props();

	let open = $state(false);
	let route = $state<LegRoute | null>(null);
	let loading = $state(false);
	let asked = false;

	async function toggle() {
		open = !open;
		if (!open || asked) return;
		asked = true;
		loading = true;
		route = await legRoute(from, to, mode, departAt);
		onroute?.(route);
		loading = false;
	}

	const hhmm = (iso: string | undefined) =>
		iso
			? formatter(undefined, {
					timeZone: timezone,
					hour: '2-digit',
					minute: '2-digit',
					hour12: false
				}).format(new Date(iso))
			: '';
</script>

<div
	class="tm-leg"
	class:tm-leg--estimate={source === 'estimate'}
	style="align-items: flex-start; flex-direction: column; gap: 4px"
>
	<button
		onclick={toggle}
		aria-expanded={open}
		style="background:none;border:none;padding:0;cursor:pointer;color:inherit;font:inherit;
		display:flex;align-items:center;gap:7px;text-align:left"
	>
		<span title={source === 'estimate' ? 'Estimated. The real journey is being looked up.' : ''}>
			{estimate.minutes} min{source === 'estimate' ? '*' : ''} · {estimate.km} km · {mode}
		</span>
		<span style="color: var(--tm-text-faint)">{open ? '▴' : '▾'}</span>
	</button>

	{#if open}
		<div
			style="width:100%;background:var(--tm-surface);border:1px solid var(--tm-border);
			border-radius:var(--tm-r-md);padding:10px 12px;margin:2px 0 4px"
		>
			{#if loading}
				<!-- The shape of the steps on their way, not a word about waiting. -->
				<div style="display:flex;flex-direction:column;gap:7px" aria-busy="true">
					<div class="tm-skel" style="height:18px"></div>
					<div class="tm-skel" style="height:18px;width:80%"></div>
					<div class="tm-skel" style="height:18px;width:60%"></div>
				</div>
			{:else if route?.steps?.length}
				{@const shown = groupSteps(route.steps)}
				<ul style="list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:7px">
					{#each shown as step, i (i)}
						<li style="display:flex;gap:8px;align-items:baseline">
							<span
								style="font:600 var(--tm-text-xs)/1.4 var(--tm-font);color:var(--tm-text-faint);
								min-width:42px;text-align:right;font-variant-numeric:tabular-nums"
							>
								{step.minutes} min
							</span>
							{#if step.kind === 'wait'}
								<span>
									<span class="tm-chip tm-chip--warn">Wait for the {step.line}</span>
									<span
										style="display:block;font:400 var(--tm-text-xs)/1.4 var(--tm-font);color:var(--tm-text-faint)"
									>
										at {step.to}
									</span>
								</span>
							{:else if step.kind === 'transit'}
								<span>
									<span class="tm-chip tm-chip--sky" style="margin-right:6px">{step.line}</span>
									<span style="font:500 var(--tm-text-sm)/1.4 var(--tm-font)">
										{step.from} → {step.to}
									</span>
									<span
										style="display:block;font:400 var(--tm-text-xs)/1.4 var(--tm-font);color:var(--tm-text-faint)"
									>
										{#if step.departAt}{hhmm(step.departAt)}–{hhmm(step.arriveAt)}{/if}
										{#if step.stops}· {step.stops} stops{/if}
										{#if step.headsign}· towards {step.headsign}{/if}
									</span>
								</span>
							{:else}
								<span style="font:400 var(--tm-text-sm)/1.4 var(--tm-font);color:var(--tm-text-muted)">
									{step.kind === 'drive' ? 'Drive' : 'Walk'}{step.instruction
										? ` — ${step.instruction}`
										: ''}
								</span>
							{/if}
						</li>
					{/each}
				</ul>
				{@const waiting = route.minutes - route.movingMinutes}
				<p class="tm-hint" style="margin-top:8px">
					{route.minutes} min door to door
					{#if waiting >= 1}— {route.movingMinutes} moving, {waiting} waiting{/if}
					{#if route.minutes !== estimate.minutes}· the plan allowed {estimate.minutes}{/if}
				</p>
			{:else}
				<p class="tm-hint">
					No routed detail for this leg. The estimate stands.
				</p>
			{/if}

			<a
				class="tm-btn tm-btn--secondary tm-btn--block"
				style="min-height:38px;text-decoration:none;margin-top:10px"
				href={legUrl(from, to, mode)}
				target="_blank"
				rel="noopener noreferrer"
			>
				Open in Maps
			</a>
		</div>
	{/if}
</div>
