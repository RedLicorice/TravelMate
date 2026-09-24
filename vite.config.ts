import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { SvelteKitPWA } from '@vite-pwa/sveltekit';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

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
			paths: { base },
			// Registered by the app (see the layout), not by SvelteKit.
			serviceWorker: { register: false },
			// The worker's file is named for the URL it is served at. Installed
			// copies look for an update at /sw.js, and a copy that finds nothing
			// there keeps its old worker -- and its old app -- for good.
			files: { serviceWorker: 'src/sw' }
		}),
		SvelteKitPWA({
			// The integration does not read SvelteKit's config: without this it
			// assumes a site at the domain root with no fallback page, leaves
			// 404.html out of the precache and binds the navigation fallback to
			// '/'. Offline that is a blank screen at every URL.
			kit: { adapterFallback: '404.html', spa: true },
			// The app decides when to take a new version, and it takes it on
			// opening. 'prompt' is the generated module's name for "hand the
			// decision to the app" -- nobody is ever asked anything. See the
			// layout: a new version found while the app is being opened is taken
			// at once; one that turns up later waits for the next opening rather
			// than reloading a page somebody is using.
			registerType: 'prompt',
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
			// Written by hand, for Background Sync: see src/sw.ts. It caches the
			// shell and nothing else; the trip lives in the device database.
			strategies: 'injectManifest',
			srcDir: 'src',
			filename: 'sw.ts',
			injectManifest: {
				globPatterns: ['**/*.{js,css,html,woff2,png,svg}'],
				// The country flags are one file each, fetched only for a trip
				// in that country; precaching all of them would put every
				// country's flag on every phone. Their names are the country's
				// code in capitals -- nothing else the app ships is named so.
				globIgnores: ['**/_app/immutable/assets/[A-Z][A-Z]*.svg']
			}
		})
	],
	server: {
		// Vite rejects requests whose Host header it does not recognise. Kept in
		// an env var rather than hardcoded so one developer's tailnet name does
		// not end up in the repo.
		allowedHosts: process.env.DEV_ALLOWED_HOSTS?.split(',').filter(Boolean) ?? []
	},
});
