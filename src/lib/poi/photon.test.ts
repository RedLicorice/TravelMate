import { describe, it, expect } from 'vitest';
import {
	contextOf,
	durationFor,
	safePhone,
	safeUrl,
	toBBox,
	toCity,
	toPlace,
	toPoi,
	type PhotonFeature
} from './photon';

const london: PhotonFeature = {
	geometry: { coordinates: [-0.1277653, 51.5074456] },
	properties: {
		name: 'London',
		osm_key: 'place',
		osm_value: 'city',
		country: 'United Kingdom',
		countrycode: 'gb',
		state: 'England',
		extent: [-0.5103751, 51.6918741, 0.3340155, 51.2867601]
	}
};

const museum: PhotonFeature = {
	geometry: { coordinates: [-0.1269, 51.5194] },
	properties: {
		name: 'British Museum',
		osm_key: 'tourism',
		osm_value: 'museum',
		osm_type: 'W',
		osm_id: 2192363,
		street: 'Great Russell Street',
		city: 'London',
		state: 'England',
		country: 'United Kingdom',
		extra: { opening_hours: 'Mo-Su 10:00-17:00' }
	}
};

describe('toBBox', () => {
	it('reads Photon order: west, north, east, south', () => {
		// The trap: every other API in this project orders it differently, and
		// getting it wrong yields a box on the far side of the equator.
		expect(toBBox(london.properties.extent)).toEqual({
			west: -0.5103751,
			north: 51.6918741,
			east: 0.3340155,
			south: 51.2867601
		});
	});

	it('returns null when absent', () => {
		expect(toBBox(undefined)).toBeNull();
	});

	it('returns null rather than a NaN box on junk', () => {
		expect(toBBox(['a', 'b', 'c', 'd'] as never)).toBeNull();
	});
});

describe('toPlace', () => {
	it('reads coordinates as [lon, lat], not [lat, lon]', () => {
		const p = toPlace(london);
		expect(p.lat).toBeCloseTo(51.5074456);
		expect(p.lng).toBeCloseTo(-0.1277653);
	});

	it('builds a context line from the address parts it has', () => {
		expect(toPlace(museum).label).toBe('Great Russell Street, London, England, United Kingdom');
	});

	it('never renders an empty name', () => {
		const nameless: PhotonFeature = {
			geometry: { coordinates: [0, 0] },
			properties: { street: 'Nowhere Lane' }
		};
		expect(toPlace(nameless).name).toBe('Nowhere Lane');
	});
});

describe('contextOf', () => {
	it('joins house number and street', () => {
		expect(contextOf({ housenumber: '22', street: 'Baker Street', city: 'London' })).toBe(
			'22 Baker Street, London'
		);
	});

	it('skips missing parts rather than leaving stray commas', () => {
		expect(contextOf({ city: 'London', country: 'United Kingdom' })).toBe(
			'London, United Kingdom'
		);
	});
});

describe('toCity', () => {
	it('upper-cases the country code', () => {
		expect(toCity(london).countryCode).toBe('GB');
	});

	it('carries the box through for bounding later searches', () => {
		expect(toCity(london).bbox?.north).toBeCloseTo(51.6918741);
	});
});

describe('toPoi', () => {
	it('takes the category from osm_value', () => {
		expect(toPoi(museum).category).toBe('museum');
	});

	it('defaults a museum to two hours', () => {
		expect(toPoi(museum).durationMin).toBe(120);
	});

	it('falls back to an hour for an unknown category', () => {
		expect(durationFor('something_new')).toBe(60);
		expect(durationFor(null)).toBe(60);
	});

	it('captures opening hours when the source has them', () => {
		expect(toPoi(museum).openingHours).toBe('Mo-Su 10:00-17:00');
	});

	it('builds a stable osm id', () => {
		expect(toPoi(museum).osmId).toBe('W/2192363');
	});

	it('leaves the osm id null when the feature has no identity', () => {
		expect(toPoi(london).osmId).toBeNull();
	});
});

describe('safeUrl', () => {
	it('allows http and https', () => {
		expect(safeUrl('https://britishmuseum.org')).toBe('https://britishmuseum.org/');
		expect(safeUrl('http://example.com/x')).toBe('http://example.com/x');
	});

	it('rejects javascript:, which would run in this origin', () => {
		// OSM tags are world-editable, so this is data from a stranger.
		expect(safeUrl('javascript:alert(document.cookie)')).toBeNull();
		expect(safeUrl('JavaScript:alert(1)')).toBeNull();
	});

	it('rejects data: and other schemes', () => {
		expect(safeUrl('data:text/html,<script>alert(1)</script>')).toBeNull();
		expect(safeUrl('file:///etc/passwd')).toBeNull();
		expect(safeUrl('vbscript:msgbox(1)')).toBeNull();
	});

	it('rejects a relative or malformed value', () => {
		expect(safeUrl('www.example.com')).toBeNull();
		expect(safeUrl('not a url')).toBeNull();
		expect(safeUrl('')).toBeNull();
		expect(safeUrl(null)).toBeNull();
	});

	it('ignores surrounding whitespace rather than failing on it', () => {
		expect(safeUrl('  https://example.com  ')).toBe('https://example.com/');
	});
});

describe('safePhone', () => {
	it('allows real-looking numbers', () => {
		expect(safePhone('+44 20 7323 8299')).toBe('+44 20 7323 8299');
		expect(safePhone('020 7323 8299')).toBe('020 7323 8299');
	});

	it('rejects anything carrying a scheme or markup', () => {
		expect(safePhone('javascript:alert(1)')).toBeNull();
		expect(safePhone('+44"><script>alert(1)</script>')).toBeNull();
	});

	it('rejects empty and absent values', () => {
		expect(safePhone('')).toBeNull();
		expect(safePhone(undefined)).toBeNull();
	});
});
