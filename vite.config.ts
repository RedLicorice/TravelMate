import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { SvelteKitPWA } from '@vite-pwa/sveltekit';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';

// CI sets this to '/<repo>' so assets resolve under the GitHub Pages subpath.
// SvelteKit types base as '' | `/${string}`; the env var is a plain string.
const base = (process.env.BASE_PATH ?? '') as '' | `/${string}`;

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			// Pure SPA: auth state lives only in the browser, so there is nothing
			// meaningful to render on a server that will never exist.
			adapter: adapter({ fallback: '404.html' }),
			paths: { base }
		}),
		SvelteKitPWA({
			registerType: 'autoUpdate',
			// The fallback page is not prerendered, so auto-injection has nothing
			// to write into. Registered from the root layout instead.
			injectRegister: null,
			// Without this the worker only exists in a production build, so the
			// Install prompt never appears on the dev server the phone is using.
			devOptions: { enabled: true, type: 'module', suppressWarnings: true },
			manifest: {
				name: 'TravelMate',
				short_name: 'TravelMate',
				description: 'Plan a city trip into days that minimise moving about.',
				start_url: `${base}/`,
				scope: `${base}/`,
				display: 'standalone',
				orientation: 'portrait',
				background_color: '#fbf9f7',
				theme_color: '#e98a5f',
				categories: ['travel', 'navigation'],
				icons: [
					{ src: `${base}/icon-192.png`, sizes: '192x192', type: 'image/png' },
					{ src: `${base}/icon-512.png`, sizes: '512x512', type: 'image/png' },
					// Android crops a maskable icon to whatever shape the launcher
					// uses, so the same art is declared twice rather than shipping a
					// square that gets its corners cut off.
					{ src: `${base}/icon-512.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' }
				]
			},
			workbox: {
				globPatterns: ['**/*.{js,css,html,woff2,png,svg}'],
				runtimeCaching: [
					{
						// Map tiles: show the last-seen city rather than grey squares
						// when the traveller is abroad with no signal. Capped so a
						// week of panning does not fill the device.
						urlPattern: /^https:\/\/tile\.openstreetmap\.org\/.*/i,
						handler: 'CacheFirst',
						options: {
							cacheName: 'osm-tiles',
							expiration: { maxEntries: 300, maxAgeSeconds: 60 * 60 * 24 * 30 },
							cacheableResponse: { statuses: [0, 200] }
						}
					},
					{
						// Trip data: serve from cache immediately, refresh behind it.
						// A stale plan beats a spinner on a hot street.
						urlPattern: /^https:\/\/[a-z0-9]+\.supabase\.co\/rest\/v1\/.*/i,
						handler: 'NetworkFirst',
						options: {
							cacheName: 'trip-data',
							networkTimeoutSeconds: 4,
							expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 7 },
							cacheableResponse: { statuses: [0, 200] }
						}
					}
				]
			}
		})
	],
	server: {
		// Vite rejects requests whose Host header it does not recognise. Kept in
		// an env var rather than hardcoded so one developer's tailnet name does
		// not end up in the repo.
		allowedHosts: process.env.DEV_ALLOWED_HOSTS?.split(',').filter(Boolean) ?? []
	},
	test: {
		environment: 'node',
		include: ['src/**/*.test.ts']
	}
});
