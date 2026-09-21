/** tz-lookup ships no types; it is one function over a packed grid. */
declare module 'tz-lookup' {
	export default function tzLookup(lat: number, lng: number): string;
}
