<script lang="ts">
	import { onDestroy, onMount, tick } from 'svelte';
	import { PUBLIC_GOOGLE_MAPS_BROWSER_KEY } from '$env/static/public';

	export type MapMarker = {
		id: string;
		lat: number;
		lng: number;
		/** CSS colour for the pin body. Defaults to the unassigned grey. */
		color?: string;
		/** Glyph inside the pin: a day number, 'H' for the hotel, an icon. */
		glyph?: string;
		selected?: boolean;
	};

	export type MapRoute = {
		id: string;
		points: { lat: number; lng: number }[];
		color: string;
	};

	type Props = {
		markers: MapMarker[];
		/** One polyline per visible day, each in that day's colour. */
		routes?: MapRoute[];
		center: { lat: number; lng: number };
		zoom?: number;
		height?: string;
		onselect?: (id: string) => void;
		/** Long-press on touch, right-click on desktop: drop a pin here. */
		onlongpress?: (point: { lat: number; lng: number }) => void;
	};

	let {
		markers,
		routes = [],
		center,
		zoom = 13,
		height = '100%',
		onselect,
		onlongpress
	}: Props = $props();

	/**
	 * The trip's own vector map. Rotation, tilt and pins drawn by the app all
	 * need one; Google's demo id supports none of them properly.
	 *
	 * Not a secret: a Map ID says how a map looks, and carries no access of
	 * its own. The key beside it is what is restricted.
	 */
	const MAP_ID = '9d69a674fd68f7d232ad3ecb';

	let host = $state<HTMLDivElement | null>(null);
	let map: google.maps.Map | null = null;
	let pins: google.maps.marker.AdvancedMarkerElement[] = [];
	let lines: google.maps.Polyline[] = [];
	let ready = $state(false);
	/** No map to show: offline, blocked, or the script would not load. */
	let down = $state(false);
	let reason = $state<string | null>(null);

	/**
	 * Load the Maps script once for the whole app, however many maps are on
	 * screen: a second tag for the same library is an error, not a no-op, and
	 * the place picker shows two maps at once.
	 *
	 * Resolved from Google's own callback rather than from the script tag's
	 * onload. Under loading=async the tag fires as soon as the bootstrap byte
	 * arrives, long before google.maps.Map exists -- which is exactly the
	 * "not a constructor" this component shipped with. The callback is the one
	 * signal that means ready.
	 */
	const READY_CALLBACK = '__tmGoogleMapsReady';
	let booting: Promise<void> | null = null;

	function loadMaps(): Promise<void> {
		if (window.google?.maps?.Map) return Promise.resolve();
		if (booting) return booting;

		booting = new Promise<void>((resolve, reject) => {
			if (!PUBLIC_GOOGLE_MAPS_BROWSER_KEY) {
				reject(new Error('No PUBLIC_GOOGLE_MAPS_BROWSER_KEY in this build'));
				return;
			}

			const w = window as unknown as Record<string, unknown>;
			// A refused key is reported here, not through the script's onerror.
			// Without listening for it, a referrer restriction is indis-
			// tinguishable from being offline.
			w.gm_authFailure = () => reject(new Error('Google refused the key for this address'));
			w[READY_CALLBACK] = () => resolve();

			const tag = document.createElement('script');
			tag.src =
				'https://maps.googleapis.com/maps/api/js' +
				`?key=${PUBLIC_GOOGLE_MAPS_BROWSER_KEY}` +
				'&v=weekly&loading=async&libraries=marker' +
				`&callback=${READY_CALLBACK}`;
			tag.async = true;
			tag.onerror = () =>
				reject(new Error('maps.googleapis.com did not load (offline, or blocked here)'));
			document.head.appendChild(tag);
		});
		return booting;
	}

	/**
	 * A pin drawn as the app draws them, not as Google does: the day colours
	 * are the plan's own language and a map that ignores them is a map of
	 * somewhere else.
	 */
	/**
	 * A colour Google will accept.
	 *
	 * The day colours are custom properties, and a pin is a DOM element so the
	 * browser resolves them for free. A polyline is not: Google parses the
	 * colour itself, does not know what var(--tm-day-1) means, and draws black.
	 */
	function resolved(colour: string): string {
		const named = /^var\((--[^),]+)/.exec(colour.trim());
		if (!named) return colour;
		const value = getComputedStyle(document.documentElement)
			.getPropertyValue(named[1])
			.trim();
		return value || '#888';
	}

	function pinFor(m: MapMarker): HTMLElement {
		const el = document.createElement('div');
		el.className = 'tm-pin-el';
		el.style.background = m.color ?? 'var(--tm-day-none)';
		if (m.selected) el.classList.add('tm-pin-el--on');
		if (m.glyph) el.textContent = m.glyph;
		return el;
	}

	function draw() {
		if (!map || !window.google?.maps) return;

		for (const p of pins) p.map = null;
		const Marker = Pin;
		if (!Marker) return;
		pins = markers.map((m) => {
			const pin = new Marker({
				map,
				position: { lat: m.lat, lng: m.lng },
				content: pinFor(m),
				title: m.id
			});
			if (onselect) pin.addListener('click', () => onselect(m.id));
			return pin;
		});

		for (const l of lines) l.setMap(null);
		lines = routes
			.filter((r) => r.points.length > 1)
			.map(
				(r) =>
					new google.maps.Polyline({
						map,
						path: r.points,
						strokeColor: resolved(r.color),
						strokeOpacity: 0.85,
						strokeWeight: 4
					})
			);
	}

	let Pin: typeof google.maps.marker.AdvancedMarkerElement | null = null;

	async function start() {
		// Put the map's own element back before anything else: while the panel
		// is showing there is nothing for the map to bind to, so a retry would
		// otherwise have nowhere to draw.
		down = false;
		await tick();

		try {
			await loadMaps();
		} catch (e) {
			// Offline, blocked, or Google is having a bad day. The screen says
			// so and everything else on it goes on working: a plan is worth
			// more than the map of it, and a traveller reads this on a train.
			//
			// Reported rather than swallowed: 'no map' with no reason is the
			// hardest kind of bug to be told about.
			reason = e instanceof Error ? e.message : String(e);
			console.error('[map]', reason);
			down = true;
			return;
		}
		if (!host) {
			reason = 'The map had nowhere to draw';
			down = true;
			return;
		}
		Pin = google.maps.marker.AdvancedMarkerElement;
		map = new google.maps.Map(host, {
			center,
			zoom,
			mapId: MAP_ID,
			disableDefaultUI: true,
			zoomControl: true,
			// Two fingers to turn the map and to tilt it. Worth having on a
			// phone in a strange city: holding the map the way the street runs
			// is how people actually read one.
			rotateControl: true,
			headingInteractionEnabled: true,
			tiltInteractionEnabled: true,
			gestureHandling: 'greedy',
			clickableIcons: false
		});
		if (onlongpress) {
			map.addListener('contextmenu', (e: google.maps.MapMouseEvent) => {
				if (e.latLng) onlongpress({ lat: e.latLng.lat(), lng: e.latLng.lng() });
			});
		}
		ready = true;
		down = false;
		draw();
	}

	onMount(() => {
		void start();
		// Try again when the connection comes back, rather than leaving a dead
		// panel until the page is reloaded. A traveller goes through tunnels.
		const retry = () => {
			if (!ready) void start();
		};
		window.addEventListener('online', retry);
		return () => window.removeEventListener('online', retry);
	});

	// Redraw when what is on the map changes. Cheap: a day has tens of pins,
	// not thousands, and rebuilding is simpler than diffing them.
	$effect(() => {
		void markers;
		void routes;
		if (ready) draw();
	});

	$effect(() => {
		if (ready && map) map.setCenter(center);
	});

	onDestroy(() => {
		for (const p of pins) p.map = null;
		for (const l of lines) l.setMap(null);
	});
</script>

{#if down}
	<div class="tm-map-down" style="height:{height}">
		<p class="tm-card__title">No map right now</p>
		<p class="tm-card__meta">
			{markers.length}
			{markers.length === 1 ? 'place' : 'places'} here. The plan works without the map.
		</p>
		{#if reason}<p class="tm-hint mt-2">{reason}</p>{/if}
	</div>
{:else}
	<div bind:this={host} style="width:100%;height:{height}"></div>
{/if}

<style>
	.tm-map-down {
		display: grid;
		align-content: center;
		justify-items: center;
		gap: 2px;
		text-align: center;
		padding: var(--tm-space-4);
		background: var(--tm-surface-2);
	}

	:global(.tm-pin-el) {
		display: grid;
		place-items: center;
		width: 26px;
		height: 26px;
		border-radius: 50%;
		border: 2px solid var(--tm-surface);
		box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3);
		font: 700 11px/1 var(--tm-font);
		color: #fff;
	}

	:global(.tm-pin-el--on) {
		width: 32px;
		height: 32px;
		z-index: 2;
	}
</style>
