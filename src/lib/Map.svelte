<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import type { Map as LeafletMap, Marker, Polyline } from 'leaflet';

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
	let map: LeafletMap | null = null;
	let layer: Marker[] = [];
	let lines: Polyline[] = [];
	let L: typeof import('leaflet') | null = null;

	onMount(async () => {
		// Dynamic import keeps Leaflet out of the initial bundle: the plan view
		// opens far more often than the map does.
		L = (await import('leaflet')).default;
		await import('leaflet/dist/leaflet.css');

		map = L.map(host, { zoomControl: false, attributionControl: true }).setView(
			[center.lat, center.lng],
			zoom
		);
		L.control.zoom({ position: 'bottomright' }).addTo(map);
		// Leaflet raises contextmenu for both a right-click and a touch
		// long-press, which is exactly the gesture wanted here.
		map.on('contextmenu', (e: { latlng: { lat: number; lng: number } }) =>
			onlongpress?.({ lat: e.latlng.lat, lng: e.latlng.lng })
		);
		L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
			maxZoom: 19,
			// Required by the OSM tile usage policy, not decoration.
			attribution: '&copy; OpenStreetMap contributors'
		}).addTo(map);
		draw();
	});

	onDestroy(() => map?.remove());

	function icon(m: MapMarker) {
		const size = m.selected ? 32 : 26;
		const color = m.color ?? 'var(--tm-day-none)';
		return L!.divIcon({
			className: '',
			iconSize: [size, size],
			iconAnchor: [size / 2, size],
			html: `<div style="width:${size}px;height:${size}px;border-radius:50% 50% 50% 4px;
				transform:rotate(-45deg);background:${color};
				box-shadow:0 0 0 ${m.selected ? 3 : 2}px var(--tm-pin-halo);
				display:grid;place-items:center">
				<span style="transform:rotate(45deg);font:700 ${Math.round(size / 2.4)}px/1 var(--tm-font);
				color:#fff">${m.glyph ?? ''}</span></div>`
		});
	}

	function draw() {
		if (!map || !L) return;
		layer.forEach((m) => m.remove());
		layer = markers.map((m) =>
			L!
				.marker([m.lat, m.lng], { icon: icon(m) })
				.addTo(map!)
				.on('click', () => onselect?.(m.id))
		);
		lines.forEach((l) => l.remove());
		lines = routes
			.filter((r) => r.points.length > 1)
			.map((r) =>
				L!
					.polyline(
						r.points.map((p) => [p.lat, p.lng]),
						{ color: r.color, weight: 3.5, opacity: 0.85, lineJoin: 'round' }
					)
					.addTo(map!)
			);
	}

	/** Fit the view to everything drawn, so toggling a day never leaves the
	    traveller looking at empty sea. Only when there is something to fit. */
	export function fitAll() {
		if (!map || !L) return;
		const points = [
			...markers.map((m) => [m.lat, m.lng] as [number, number]),
			...routes.flatMap((r) => r.points.map((p) => [p.lat, p.lng] as [number, number]))
		];
		if (points.length > 1) map.fitBounds(L.latLngBounds(points), { padding: [40, 40] });
	}

	// Redraw when the caller's data changes, not on every unrelated render.
	$effect(() => {
		void markers;
		void routes;
		draw();
	});
</script>

<div bind:this={host} style="height: {height}; width: 100%; z-index: 0"></div>
