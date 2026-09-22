import { PUBLIC_SUPABASE_URL } from '$env/static/public';
import { openStore } from '$lib/store/store.svelte';
import { keptUser } from '$lib/store/idb';
import { ownedBy } from '$lib/session.svelte';

// Pure SPA. Nothing is prerendered, so adapter-static emits only the fallback;
// the build script copies it to index.html so the site has a root document.
export const ssr = false;
export const prerender = false;

// The trips on this device are read into memory before the first screen is
// drawn, so no screen ever waits for something the phone already has -- and
// only once it is settled that they belong to whoever is signed in. Reading
// first and checking after drew the previous account's trips on a shared
// phone until the check caught up.
export const load = async () => {
	await ownedBy(await keptUser(PUBLIC_SUPABASE_URL));
	await openStore();
};
