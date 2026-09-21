import { describe, it, expect } from 'vitest';
import { describe as describeJourney, emptyLeg, endpointOf, summaryOf, type JourneyLeg } from './journey';

const point = (name: string, lat: number, lng: number, kind: 'airport' | 'train' = 'airport') => ({
	name,
	lat,
	lng,
	kind
});

const rome = point('Roma Termini', 41.9009, 12.5018, 'train');
const milanStation = point('Milano Centrale', 45.4869, 9.2049, 'train');
const milanAirport = point('Malpensa', 45.6306, 8.7281);
const stansted = point('Stansted', 51.886, 0.2389);

/** Rome to Milan by train, then Milan to London by air. */
const arrival: JourneyLeg[] = [
	{ ...emptyLeg(), from: rome, to: milanStation, service: 'FR 9612', departLocal: '2026-10-02T08:00', arriveLocal: '2026-10-02T11:10' },
	{ ...emptyLeg(), from: milanAirport, to: stansted, service: 'FR 8012', departLocal: '2026-10-02T14:30', arriveLocal: '2026-10-02T15:45' }
];

describe('endpointOf', () => {
	it('arrives at the end of the journey, not the start of it', () => {
		expect(endpointOf(arrival, 'arrival')?.point.name).toBe('Stansted');
	});

	it('departs from the start of the journey, not the end of it', () => {
		expect(endpointOf(arrival, 'departure')?.point.name).toBe('Roma Termini');
	});

	it('skips a leg that has not named its end yet', () => {
		const half = [...arrival, { ...emptyLeg(), from: stansted }];
		expect(endpointOf(half, 'arrival')?.point.name).toBe('Stansted');
	});

	it('is nothing for a journey with no points at all', () => {
		expect(endpointOf([emptyLeg()], 'arrival')).toBeNull();
		expect(endpointOf([], 'departure')).toBeNull();
	});
});

describe('summaryOf', () => {
	it('gives the planner the landing point and the landing time', () => {
		const s = summaryOf(arrival, 'arrival', 'Europe/London');
		expect(s.name).toBe('Stansted');
		expect(s.kind).toBe('airport');
		// 15:45 London on 2 October is 14:45 UTC.
		expect(s.at).toBe('2026-10-02T14:45:00.000Z');
	});

	it('reads the departure time from the first leg, which is the one you must catch', () => {
		const s = summaryOf(arrival, 'departure', 'Europe/Rome');
		expect(s.name).toBe('Roma Termini');
		// 08:00 Rome is 06:00 UTC.
		expect(s.at).toBe('2026-10-02T06:00:00.000Z');
	});

	it('leaves the time alone when the journey does not state one', () => {
		const s = summaryOf([{ ...emptyLeg(), to: stansted }], 'arrival', 'Europe/London');
		expect(s.name).toBe('Stansted');
		expect(s.at).toBeNull();
	});

	it('summarises an empty journey to nothing', () => {
		expect(summaryOf([], 'arrival', 'Europe/London')).toEqual({
			name: null,
			lat: null,
			lng: null,
			kind: null,
			at: null
		});
	});
});

describe('describe', () => {
	it('reads as the journey it is', () => {
		expect(describeJourney(arrival)).toBe(
			'Roma Termini → Milano Centrale (FR 9612), Malpensa → Stansted (FR 8012)'
		);
	});

	it('ignores legs nobody has filled in', () => {
		expect(describeJourney([emptyLeg()])).toBe('');
	});
});
