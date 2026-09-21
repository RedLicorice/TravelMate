<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
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

	let host: HTMLDivElement;
	let map: google.maps.Map | null = null;
	let pins: google.maps.marker.AdvancedMarkerElement[] = [];
	let lines: google.maps.Polyline[] = [];
	let ready = $state(false);

	/**
	 * Load the Maps script once for the whole app, however many maps are on
	 * screen. A second <script> tag for the same library is an error rather
	 * than a no-op, and the place picker shows two maps at once.
	 */
	let loading: Promise<void> | null = null;
	function loadMaps(): Promise<void> {
		if (window.google?.maps) return Promise.resolve();
		if (loading) return loading;
		loading = new Promise((resolve, reject) => {
			const tag = document.createElement('script');
			tag.src =
				`https://maps.googleapis.com/maps/api/js?key=${PUBLIC_GOOGLE_MAPS_BROWSER_KEY}` +
				'&libraries=marker&loading=async&v=weekly';
			tag.async = true;
			tag.onload = () => resolve();
			tag.onerror = () => reject(new Error('Google Maps failed to load'));
			document.head.appendChild(tag);
		});
		return loading;
	}

	/**
	 * A pin drawn as the app draws them, not as Google does: the day colours
	 * are the plan's own language and a map that ignores them is a map of
	 * somewhere else.
	 */
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
		pins = markers.map((m) => {
			const pin = new google.maps.marker.AdvancedMarkerElement({
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
						strokeColor: r.color,
						strokeOpacity: 0.85,
						strokeWeight: 4
					})
			);
	}

	onMount(async () => {
		try {
			await loadMaps();
		} catch {
			// No map rather than a broken page: everything else on the screen
			// still works without one.
			return;
		}
		map = new google.maps.Map(host, {
			center,
			zoom,
			mapId: 'DEMO_MAP_ID',
			disableDefaultUI: true,
			zoomControl: true,
			gestureHandling: 'greedy',
			clickableIcons: false
		});
		if (onlongpress) {
			map.addListener('contextmenu', (e: google.maps.MapMouseEvent) => {
				if (e.latLng) onlongpress({ lat: e.latLng.lat(), lng: e.latLng.lng() });
			});
		}
		ready = true;
		draw();
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

<div bind:this={host} style="width:100%;height:{height}"></div>

<style>
	:global(.tm-pin-el) {
		display: grid;
		place-items: center;
		width: 26px;
		height: 26px;
		border-radius: 50% 50% 50% 2px;
		transform: rotate(-45deg);
		border: 2px solid var(--tm-surface);
		box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3);
		font: 700 11px/1 var(--tm-font);
		color: #fff;
	}

	:global(.tm-pin-el)::first-line {
		/* The glyph rides upright inside a rotated pin. */
		line-height: 1;
	}

	:global(.tm-pin-el--on) {
		width: 32px;
		height: 32px;
		z-index: 2;
	}
</style>
