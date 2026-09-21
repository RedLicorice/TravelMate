import { describe, it, expect } from 'vitest';
import { dayTruncated, dayUrl, legUrl, MAX_WAYPOINTS, routePoints } from './maps';

const hotel = { lat: 41.8986, lng: 12.4768 };
const colosseum = { lat: 41.8902, lng: 12.4924 };
const forum = { lat: 41.8925, lng: 12.4853 };

describe('legUrl', () => {
	it('builds directions for one hop', () => {
		const url = new URL(legUrl(hotel, colosseum, 'walk'));
		expect(url.searchParams.get('origin')).toBe('41.898600,12.476800');
		expect(url.searchParams.get('destination')).toBe('41.890200,12.492400');
		expect(url.searchParams.get('travelmode')).toBe('walking');
	});

	it('carries the travel mode across', () => {
		// A transit leg must open transit directions, not driving ones.
		expect(new URL(legUrl(hotel, colosseum, 'transit')).searchParams.get('travelmode')).toBe('transit');
		expect(new URL(legUrl(hotel, colosseum, 'bike')).searchParams.get('travelmode')).toBe('bicycling');
		expect(new URL(legUrl(hotel, colosseum, 'carshare')).searchParams.get('travelmode')).toBe('driving');
	});
});

describe('dayUrl', () => {
	it('puts the middle stops in as waypoints, in order', () => {
		const url = new URL(dayUrl([hotel, colosseum, forum, hotel], 'walk')!);
		expect(url.searchParams.get('waypoints')).toBe('41.890200,12.492400|41.892500,12.485300');
	});

	it('has no waypoints parameter for a two-point day', () => {
		expect(new URL(dayUrl([hotel, colosseum], 'walk')!).searchParams.has('waypoints')).toBe(false);
	});

	it('returns null for a day with nowhere to go', () => {
		expect(dayUrl([hotel], 'walk')).toBeNull();
		expect(dayUrl([], 'walk')).toBeNull();
	});

	it('trims a long day rather than refusing it', () => {
		// Google takes nine waypoints. Most of the day beats none of it.
		const many = [hotel, ...Array(15).fill(colosseum), hotel];
		const url = new URL(dayUrl(many, 'walk')!);
		expect(url.searchParams.get('waypoints')!.split('|')).toHaveLength(MAX_WAYPOINTS);
		expect(dayTruncated(many)).toBe(true);
	});

	it('does not claim to have trimmed a day that fit', () => {
		expect(dayTruncated([hotel, colosseum, forum, hotel])).toBe(false);
	});
});

describe('routePoints', () => {
	const a = { lat: 51.5, lng: -0.1 };
	const b = { lat: 51.6, lng: -0.2 };
	const c = { lat: 51.7, lng: -0.3 };

	it('passes through both ends of a stop you leave from elsewhere', () => {
		expect(routePoints([{ at: a }, { at: b, exitAt: c }])).toEqual([a, b, c]);
	});

	it('leaves an ordinary day untouched', () => {
		expect(routePoints([{ at: a }, { at: b, exitAt: null }, { at: c }])).toEqual([a, b, c]);
	});

	it('does nothing with nothing', () => {
		expect(routePoints([])).toEqual([]);
	});
});
