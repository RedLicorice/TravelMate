<script lang="ts">
	import type { RouteStep } from '$lib/plan/route';

	/**
	 * How a route travels, as a row of small drawn icons: walk › metro › walk.
	 * Drawn, not emoji. Walks one after another are one walk, and a walk under
	 * two minutes -- across a platform, out of a door -- is left out.
	 */
	type Props = { steps: RouteStep[]; fallback: 'walk' | 'car' | 'bike' | 'train' };
	let { steps, fallback }: Props = $props();

	type Icon = 'walk' | 'car' | 'bike' | 'metro' | 'bus' | 'train' | 'tram' | 'ferry';
	const VEHICLE: Record<string, Icon> = {
		SUBWAY: 'metro',
		METRO_RAIL: 'metro',
		BUS: 'bus',
		INTERCITY_BUS: 'bus',
		TROLLEYBUS: 'bus',
		SHARE_TAXI: 'bus',
		RAIL: 'train',
		HEAVY_RAIL: 'train',
		COMMUTER_TRAIN: 'train',
		HIGH_SPEED_TRAIN: 'train',
		LONG_DISTANCE_TRAIN: 'train',
		MONORAIL: 'train',
		TRAM: 'tram',
		LIGHT_RAIL: 'tram',
		CABLE_CAR: 'tram',
		FUNICULAR: 'tram',
		GONDOLA_LIFT: 'tram',
		FERRY: 'ferry'
	};
	const LABEL: Record<Icon, string> = {
		walk: 'walk',
		car: 'car',
		bike: 'bike',
		metro: 'metro',
		bus: 'bus',
		train: 'train',
		tram: 'tram',
		ferry: 'ferry'
	};

	const icons = $derived.by(() => {
		const out: { icon: Icon; seconds: number }[] = [];
		for (const s of steps) {
			if (s.kind === 'wait') continue;
			const icon: Icon =
				s.kind === 'transit' ? (VEHICLE[s.vehicle ?? ''] ?? 'train') : s.kind === 'drive' ? 'car' : s.kind === 'bike' ? 'bike' : 'walk';
			const last = out.at(-1);
			if (last && last.icon === icon && icon !== 'metro' && icon !== 'bus' && icon !== 'train' && icon !== 'tram' && icon !== 'ferry') {
				last.seconds += s.seconds;
			} else out.push({ icon, seconds: s.seconds });
		}
		const kept = out.filter((x) => x.icon !== 'walk' || x.seconds >= 120 || out.length === 1).map((x) => x.icon);
		return kept.length ? kept : [fallback];
	});
</script>

<span class="tm-route-icons" aria-label={icons.map((i) => LABEL[i]).join(', then ')}>
	{#each icons as icon, i}
		{#if i > 0}<span class="tm-route-icons__sep" aria-hidden="true">›</span>{/if}
		<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
			{#if icon === 'walk'}
				<circle cx="13" cy="4" r="2" /><path d="M11 21l2-6-3-3 2-5 4 3 2 1M10 12l-2 3H5" />
			{:else if icon === 'car'}
				<path d="M3 16v-3l2.5-5h9l4.5 5h2v3h-2M9 16h6" /><circle cx="7" cy="16" r="2" /><circle cx="17" cy="16" r="2" />
			{:else if icon === 'bike'}
				<circle cx="6" cy="17" r="3.5" /><circle cx="18" cy="17" r="3.5" /><path d="M6 17l4-8h5l3 8M10 9h-2" />
			{:else if icon === 'metro'}
				<circle cx="12" cy="12" r="9" /><path d="M8 16V8l4 5 4-5v8" />
			{:else if icon === 'bus'}
				<rect x="4" y="4" width="16" height="13" rx="2" /><path d="M4 10h16M4 7h16" /><circle cx="8" cy="19.5" r="1.5" /><circle cx="16" cy="19.5" r="1.5" />
			{:else if icon === 'train'}
				<path d="M7 16V7a4 4 0 0 1 4-4h2a4 4 0 0 1 4 4v9z" /><path d="M7 10h10" /><circle cx="10" cy="13" r="0.8" /><circle cx="14" cy="13" r="0.8" /><path d="M5 21h14M9 16l-2 5M15 16l2 5" />
			{:else if icon === 'tram'}
				<rect x="6" y="6" width="12" height="12" rx="2" /><path d="M9 3h6M12 3v3M6 13h12M9 21l1-3M15 21l-1-3" />
			{:else}
				<path d="M4 15l2 4h12l2-4zM12 4v11M12 5l5 7h-5" /><path d="M3 21c2 0 2-1 4-1s2 1 4 1 2-1 4-1 2 1 4 1" />
			{/if}
		</svg>
	{/each}
</span>

<style>
	.tm-route-icons {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		color: var(--tm-text-muted);
	}
	.tm-route-icons__sep {
		color: var(--tm-text-faint);
		font-size: 11px;
	}
</style>
