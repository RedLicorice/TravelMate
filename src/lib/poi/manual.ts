/**
 * Getting a place in when the search provider has never heard of it.
 *
 * OSM is volunteer data and lags reality: a bar that changed hands last year
 * is still listed under the old name, or not at all. When that happens the
 * traveller has coordinates -- from a maps link, or from a pin they dropped --
 * and those are enough.
 */
export type LatLng = { lat: number; lng: number };

const inRange = (lat: number, lng: number) =>
	Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

const ok = (lat: number, lng: number): LatLng | null =>
	inRange(lat, lng) ? { lat, lng } : null;

/**
 * Pull coordinates out of whatever the traveller pasted.
 *
 * Handles bare coordinates and the URL shapes the big map apps produce. Google
 * short links (maps.app.goo.gl) cannot be resolved here: following the
 * redirect needs a cross-origin request the browser will not allow, and the
 * short form carries no coordinates of its own. The caller says so rather than
 * failing silently.
 */
export function parseLatLng(input: string): LatLng | null {
	const text = input.trim();
	if (!text) return null;

	// Google's place pin: !3d<lat>!4d<lng>. Preferred over the @ viewport
	// centre, which is wherever the map happened to be looking.
	const pin = text.match(/!3d(-?\d+\.?\d*)!4d(-?\d+\.?\d*)/);
	if (pin) return ok(Number(pin[1]), Number(pin[2]));

	// Google / generic viewport: @lat,lng,zoom
	const at = text.match(/@(-?\d+\.?\d*),(-?\d+\.?\d*)/);
	if (at) return ok(Number(at[1]), Number(at[2]));

	// OpenStreetMap marker and hash forms
	const osmMarker = text.match(/[?&]mlat=(-?\d+\.?\d*)[^#]*[?&]mlon=(-?\d+\.?\d*)/);
	if (osmMarker) return ok(Number(osmMarker[1]), Number(osmMarker[2]));
	const osmHash = text.match(/#map=\d+\/(-?\d+\.?\d*)\/(-?\d+\.?\d*)/);
	if (osmHash) return ok(Number(osmHash[1]), Number(osmHash[2]));

	// Apple Maps, and geo: URIs from a phone's share sheet
	const apple = text.match(/[?&]ll=(-?\d+\.?\d*),(-?\d+\.?\d*)/);
	if (apple) return ok(Number(apple[1]), Number(apple[2]));
	const geo = text.match(/^geo:(-?\d+\.?\d*),(-?\d+\.?\d*)/i);
	if (geo) return ok(Number(geo[1]), Number(geo[2]));

	// Bare coordinates, comma or whitespace separated.
	const bare = text.match(/^(-?\d{1,2}(?:\.\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)$/);
	if (bare) return ok(Number(bare[1]), Number(bare[2]));

	return null;
}

/** True for the one link shape a browser cannot resolve on its own. */
export const isShortMapLink = (input: string) =>
	/maps\.app\.goo\.gl|goo\.gl\/maps|g\.co\/kgs/i.test(input.trim());
