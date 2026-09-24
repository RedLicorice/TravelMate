/// <reference lib="webworker" />
/**
 * The service worker: the shell, and nothing of the trip.
 *
 * It keeps the document, the code and the assets, so the app opens with no
 * connection at all. The trip itself lives in the device database, and is
 * none of this worker's business -- except that when the tab is gone and a
 * connection comes back, Background Sync wakes this worker to send what the
 * traveller did offline. Browsers without Background Sync have the page send
 * it instead (store.svelte.ts).
 */
import { createClient } from '@supabase/supabase-js';
import { PUBLIC_SUPABASE_PUBLISHABLE_KEY, PUBLIC_SUPABASE_URL } from '$env/static/public';
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { authStorage } from '$lib/store/idb';
import { CHANNEL, SYNC_TAG, drain } from '$lib/store/sync';

declare const self: ServiceWorkerGlobalScope;

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
// Every URL is drawn by the one page adapter-static writes. There is no such
// page on the dev server, which serves every route itself.
if (import.meta.env.PROD) registerRoute(new NavigationRoute(createHandlerBoundToURL('404.html')));

// A new version takes over as soon as it is installed, and takes the open
// pages with it. It used to wait to be told, which only happened within ten
// seconds of the app opening: on an iPhone, where an installed app is
// resumed far more often than started and a waiting worker stays waiting,
// that meant a phone could run an old version indefinitely. The page
// reloads onto the new version itself, at a moment that does not interrupt
// (+layout.svelte).
self.addEventListener('install', () => void self.skipWaiting());
self.addEventListener('message', (e) => {
	if (e.data?.type === 'SKIP_WAITING') void self.skipWaiting();
});

// Trip reads used to be cached here by URL. The device database holds the
// trip now, and an old copy of somebody's rows has no business lingering.
self.addEventListener('activate', (e) =>
	e.waitUntil(Promise.all([caches.delete('trip-data'), self.clients.claim()]))
);

self.addEventListener('sync', (e) => {
	const event = e as ExtendableEvent & { tag: string };
	if (event.tag !== SYNC_TAG) return;
	event.waitUntil(
		(async () => {
			// The same session the page uses, from the same place. Not refreshed
			// on a timer: a worker lives for as long as this one event.
			const server = createClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
				auth: { storage: authStorage, persistSession: true, autoRefreshToken: false, detectSessionInUrl: false }
			});
			await drain(server, () => {});
			// An open tab redraws from the device database.
			new BroadcastChannel(CHANNEL).postMessage({ from: 'worker', kind: 'synced' });
		})()
	);
});
