// This trip's own rows, read from the device before any of its screens draws:
// only what is needed, not every trip on the phone. Imported inside load, not
// at the top, for the same reason as the root layout: the dev server imports
// this file in Node, where the store has no business running.
export const load = async ({ params }: { params: { id: string } }) =>
	(await import('$lib/store/store.svelte')).openTrip(params.id);
