import { openStore } from '$lib/store/store.svelte';

// Pure SPA. Nothing is prerendered, so adapter-static emits only the fallback;
// the build script copies it to index.html so the site has a root document.
export const ssr = false;
export const prerender = false;

// The trips on this device are read into memory before the first screen is
// drawn, so no screen ever waits for something the phone already has. They
// belong to whoever is signed in: the device is cleared when they sign out,
// and when a session ends by itself (session.svelte.ts).
export const load = () => openStore();
