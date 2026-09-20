import { describe, it, expect } from 'vitest';
import { toBBox, toCity, toPlace, type NominatimRow } from './nominatim';

const london: NominatimRow = {
	name: 'Greater London',
	display_name: 'Greater London, England, United Kingdom',
	lat: '51.5074456',
	lon: '-0.1277653',
	boundingbox: ['51.2867601', '51.6918741', '-0.5103751', '0.3340155'],
	address: { country_code: 'gb' }
};

const hotel: NominatimRow = {
	name: 'Premier Inn Ealing',
	display_name: 'Premier Inn Ealing, 22, Uxbridge Road, Ealing, London, W5 2BP, United Kingdom',
	lat: '51.5129',
	lon: '-0.3100',
	category: 'tourism',
	type: 'hotel'
};

describe('toBBox', () => {
	it('reads Nominatim order: south, north, west, east', () => {
		expect(toBBox(london.boundingbox)).toEqual({
			south: 51.2867601,
			north: 51.6918741,
			west: -0.5103751,
			east: 0.3340155
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
	it('splits the entity from its context', () => {
		const p = toPlace(hotel);
		expect(p.name).toBe('Premier Inn Ealing');
		expect(p.label).toBe('22, Uxbridge Road, Ealing, London, W5 2BP, United Kingdom');
	});

	it('falls back to the first display_name segment when name is absent', () => {
		expect(toPlace({ ...hotel, name: undefined }).name).toBe('Premier Inn Ealing');
	});

	it('parses coordinates as numbers, not strings', () => {
		const p = toPlace(hotel);
		expect(p.lat).toBeCloseTo(51.5129);
		expect(p.lng).toBeCloseTo(-0.31);
	});

	it('survives a single-segment display_name', () => {
		const p = toPlace({ display_name: 'Atlantis', lat: '0', lon: '0' });
		expect(p.name).toBe('Atlantis');
		expect(p.label).toBe('Atlantis');
	});
});

describe('toCity', () => {
	it('upper-cases the country code', () => {
		expect(toCity(london).countryCode).toBe('GB');
	});

	it('carries the bounding box through for later hotel bounding', () => {
		expect(toCity(london).bbox?.north).toBeCloseTo(51.6918741);
	});

	it('tolerates a missing address block', () => {
		expect(toCity({ ...london, address: undefined }).countryCode).toBeNull();
	});
});
