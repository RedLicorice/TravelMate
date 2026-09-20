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

	type Props = {
		markers: MapMarker[];
		route?: { lat: number; lng: number }[];
		center: { lat: number; lng: number };
		zoom?: number;
		height?: string;
		onselect?: (id: string) => void;
	};

	let { markers, route = [], center, zoom = 13, height = '100%', onselect }: Props = $props();

	let host: HTMLDivElement;
	let map: LeafletMap | null = null;
	let layer: Marker[] = [];
	let line: Polyline | null = null;
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
		line?.remove();
		line = route.length > 1
			? L.polyline(
					route.map((p) => [p.lat, p.lng]),
					{ color: markers[0]?.color ?? '#888', weight: 3, opacity: 0.8 }
				).addTo(map)
			: null;
	}

	// Redraw when the caller's data changes, not on every unrelated render.
	$effect(() => {
		void markers;
		void route;
		draw();
	});
</script>

<div bind:this={host} style="height: {height}; width: 100%; z-index: 0"></div>
