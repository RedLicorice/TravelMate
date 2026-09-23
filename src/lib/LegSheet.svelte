<script lang="ts">
	import { PUBLIC_GOOGLE_MAPS_BROWSER_KEY } from '$env/static/public';
	import { formatter } from '$lib/clock';
	import { legUrl } from '$lib/maps';
	import { legRoute, type LegRoute } from '$lib/plan/route';
	import type { LatLng } from '$lib/trip/days';
	import type { Mode } from '$lib/plan/modes';

	type Props = {
		from: LatLng;
		to: LatLng;
		fromName: string;
		toName: string;
		mode: Mode;
		/** When the traveller sets off, which is what makes a transit answer real. */
		departAt: string;
		timezone: string;
		/** The leg as the day has it. */
		planned: { minutes: number; km: number; source?: 'estimate' | 'routed' };
		onclose: () => void;
	};

	let { from, to, fromName, toName, mode, departAt, timezone, planned, onclose }: Props = $props();

	/** Google's journey: undefined while it is asked for, null when it has none. */
	let route = $state<LegRoute | null | undefined>(undefined);
	/** No network, or the picture would not load: the map says so and offers to try again. */
	let noSignal = $state(false);
	/** Changed on a retry, so the browser asks for the picture again rather than reusing the failure. */
	let attempt = $state(0);

	async function load() {
		noSignal = false;
		route = undefined;
		if (!navigator.onLine) {
			noSignal = true;
			route = null;
			return;
		}
		route = await legRoute(from, to, mode, departAt);
		if (!route && !navigator.onLine) noSignal = true;
	}
	$effect(() => {
		void load();
	});

	function retry() {
		attempt++;
		void load();
	}

	/**
	 * A still picture of the journey: Google's path when it has one -- the bus
	 * or the metro for transit, the streets otherwise -- and the two ends
	 * either way. With markers and a path the picture frames itself.
	 */
	const staticMap = $derived.by(() => {
		if (!PUBLIC_GOOGLE_MAPS_BROWSER_KEY || route === undefined) return null;
		const q = new URLSearchParams({ size: '640x220', scale: '2', key: PUBLIC_GOOGLE_MAPS_BROWSER_KEY });
		q.append('markers', `color:0xe98a5f|label:A|${from.lat},${from.lng}`);
		q.append('markers', `color:0xe98a5f|label:B|${to.lat},${to.lng}`);
		if (route?.polyline) q.append('path', `color:0xe98a5fff|weight:5|enc:${route.polyline}`);
		return `https://maps.googleapis.com/maps/api/staticmap?${q}&attempt=${attempt}`;
	});

	const hhmm = (ms: number) =>
		formatter(undefined, { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false }).format(
			new Date(ms)
		);
	const leaves = $derived(Date.parse(departAt));
</script>

<div
	role="presentation"
	style="position:fixed;inset:0;z-index:60;background:rgba(0,0,0,0.35)"
	onclick={onclose}
></div>

<div
	class="tm-sheet"
	style="position:fixed;z-index:61;max-height:86vh;overflow-y:auto;padding:0"
	role="dialog"
	aria-label="{fromName} to {toName}"
>
	<!-- The map on top, with where from and where to written across it. -->
	<div style="position:relative;height:220px;background:var(--tm-surface-2)">
		{#if noSignal}
			<div
				style="height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;color:var(--tm-text-muted);font:600 var(--tm-text-sm)/1.2 var(--tm-font)"
			>
				No signal
				<button class="tm-btn tm-btn--secondary" onclick={retry}>Retry</button>
			</div>
		{:else if staticMap}
			<img
				src={staticMap}
				alt=""
				width="640"
				height="220"
				style="width:100%;height:220px;object-fit:cover;display:block"
				onerror={() => (noSignal = true)}
			/>
		{:else}
			<div class="tm-skel" style="height:100%;border-radius:0" aria-busy="true"></div>
		{/if}
		<p
			style="position:absolute;left:10px;bottom:10px;right:10px;margin:0;padding:6px 10px;
			border-radius:var(--tm-r-md);background:var(--tm-surface);color:var(--tm-text);
			font:600 var(--tm-text-sm)/1.3 var(--tm-font);width:fit-content;max-width:calc(100% - 20px)"
		>
			{fromName} → {toName}
		</p>
	</div>

	<div style="padding: var(--tm-space-3) var(--tm-space-4) var(--tm-space-4)">
		<dl style="display:grid;grid-template-columns:auto 1fr;gap:6px 14px;margin:0">
			<dt class="tm-label">Planned</dt>
			<dd style="margin:0">
				{planned.minutes} min{planned.source === 'estimate' ? '*' : ''} · {planned.km} km · {mode}
				<span class="tm-hint" style="display:block">
					{hhmm(leaves)} → {hhmm(leaves + planned.minutes * 60_000)}
				</span>
			</dd>
			<dt class="tm-label">Google</dt>
			<dd style="margin:0">
				{#if route === undefined}
					<span class="tm-skel" style="display:inline-block;height:1em;width:8em" aria-busy="true"></span>
				{:else if route}
					{route.minutes} min · {route.km} km
				{:else}
					<span class="tm-hint">not available</span>
				{/if}
			</dd>
		</dl>

		<a
			class="tm-btn tm-btn--primary tm-btn--block mt-4"
			style="text-decoration:none"
			href={legUrl(from, to, mode, departAt, timezone)}
			target="_blank"
			rel="noopener noreferrer"
		>
			Open in Google Maps ↗
		</a>
	</div>
</div>
