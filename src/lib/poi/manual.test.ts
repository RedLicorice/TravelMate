import { describe, it, expect } from 'vitest';
import { isShortMapLink, parseLatLng } from './manual';

/** The real link shape that prompted this, resolved to its long form. */
const GOOGLE_LONG =
	'https://www.google.com/maps/place/The+Starman/@51.5108826,-0.1393713,19z/data=!4m6!3m5!1s0x48760557da56fd43:0x82513a207b651ff6!8m2!3d51.510882!4d-0.1395231!16s%2Fg%2F11s4k1j6tn';

describe('parseLatLng', () => {
	it('prefers the place pin over the viewport centre', () => {
		// @51.5108826,-0.1393713 is wherever the map was looking; !3d/!4d is the
		// pin itself. They differ by ~10m here, and the pin is the right answer.
		const point = parseLatLng(GOOGLE_LONG);
		expect(point?.lat).toBeCloseTo(51.510882, 5);
		expect(point?.lng).toBeCloseTo(-0.1395231, 5);
	});

	it('falls back to the viewport when there is no pin', () => {
		const point = parseLatLng('https://www.google.com/maps/@51.5108826,-0.1393713,19z');
		expect(point?.lat).toBeCloseTo(51.5108826, 5);
	});

	it('reads an OpenStreetMap marker link', () => {
		expect(parseLatLng('https://www.openstreetmap.org/?mlat=41.8902&mlon=12.4924')).toEqual({
			lat: 41.8902,
			lng: 12.4924
		});
	});

	it('reads an OpenStreetMap hash link', () => {
		expect(parseLatLng('https://www.openstreetmap.org/#map=19/41.8902/12.4924')).toEqual({
			lat: 41.8902,
			lng: 12.4924
		});
	});

	it('reads an Apple Maps link', () => {
		expect(parseLatLng('https://maps.apple.com/?ll=51.5,-0.14&q=Somewhere')).toEqual({
			lat: 51.5,
			lng: -0.14
		});
	});

	it('reads a geo: URI from a share sheet', () => {
		expect(parseLatLng('geo:41.8902,12.4924')).toEqual({ lat: 41.8902, lng: 12.4924 });
	});

	it('reads bare coordinates, however they are separated', () => {
		expect(parseLatLng('51.510882, -0.139523')).toEqual({ lat: 51.510882, lng: -0.139523 });
		expect(parseLatLng('51.510882 -0.139523')).toEqual({ lat: 51.510882, lng: -0.139523 });
	});

	it('refuses coordinates off the globe', () => {
		expect(parseLatLng('91.0, 0.0')).toBeNull();
		expect(parseLatLng('0.0, 181.0')).toBeNull();
	});

	it('refuses things that are not coordinates', () => {
		expect(parseLatLng('The Starman, London')).toBeNull();
		expect(parseLatLng('')).toBeNull();
		expect(parseLatLng('https://example.com')).toBeNull();
	});
});

describe('isShortMapLink', () => {
	it('recognises the link a browser cannot resolve', () => {
		// Following this redirect is a cross-origin request the browser refuses,
		// and the short form carries no coordinates of its own.
		expect(isShortMapLink('https://maps.app.goo.gl/nTvk4xifRwut3we79')).toBe(true);
	});

	it('does not flag a long link that can be parsed', () => {
		expect(isShortMapLink(GOOGLE_LONG)).toBe(false);
	});
});
