// Pure SPA. Nothing is prerendered, so adapter-static emits only the fallback;
// the build script copies it to index.html so the site has a root document.
export const ssr = false;
export const prerender = false;

// The trips on this device are read into memory before the first screen is
// drawn, so no screen ever waits for something the phone already has. They
// belong to whoever is signed in: the device is cleared when they sign out,
// and when a session ends by itself (session.svelte.ts).
//
// Imported here, not at the top: the dev server imports this file in Node to
// read the two options above, and the store is browser code -- IndexedDB, the
// Supabase session -- that has no business running there.
export const load = async () => (await import('$lib/store/store.svelte')).openStore();
