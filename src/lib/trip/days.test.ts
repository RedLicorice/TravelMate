import { describe, it, expect } from 'vitest';
import { fromLocalInput, reinterpret, toLocalInput, tripDays, type Trip } from './days';

const hotel = { lat: 41.8986, lng: 12.4768 };
const fco = { lat: 41.8003, lng: 12.2389 };

const base: Trip = {
	hotelName: 'Hotel Artemide',
	hotel,
	timezone: 'Europe/Rome',
	arrivalAt: '2026-04-10T13:00:00Z', // 15:00 Rome (CEST)
	departureAt: '2026-04-13T16:00:00Z', // 18:00 Rome
	arrivalPoint: { name: 'Fiumicino', at: fco },
	departurePoint: { name: 'Fiumicino', at: fco },
	arrivalLegs: [],
	departureLegs: [],
	arrivalBufferMin: 45,
	departureBufferMin: 120,
	bagDropMin: 30,
	dayStart: '09:00',
	dayEnd: '19:00'
};

const hhmm = (d: Date, tz: string) =>
	new Intl.DateTimeFormat('en-GB', {
		timeZone: tz,
		hour: '2-digit',
		minute: '2-digit',
		hour12: false
	}).format(d);

describe('tripDays', () => {
	it('covers every calendar day in the destination timezone, inclusive', () => {
		expect(tripDays(base).map((d) => d.date)).toEqual([
			'2026-04-10',
			'2026-04-11',
			'2026-04-12',
			'2026-04-13'
		]);
	});

	it('starts the first day at arrival plus the buffer, not at day_start', () => {
		expect(hhmm(tripDays(base)[0].start, base.timezone)).toBe('15:45');
	});

	it('ends the last day at departure minus the buffer', () => {
		expect(hhmm(tripDays(base).at(-1)!.end, base.timezone)).toBe('16:00');
	});

	it('uses the normal day window for middle days', () => {
		const [, second] = tripDays(base);
		expect(hhmm(second.start, base.timezone)).toBe('09:00');
		expect(hhmm(second.end, base.timezone)).toBe('19:00');
	});

	it('never starts the first day before day_start for an early arrival', () => {
		const early = { ...base, arrivalAt: '2026-04-10T03:00:00Z' }; // 05:00 Rome
		expect(hhmm(tripDays(early)[0].start, base.timezone)).toBe('09:00');
	});

	it('anchors the first day airport then hotel, with bag drop', () => {
		const [first] = tripDays(base);
		expect(first.fixedStart.map((w) => w.name)).toEqual(['Fiumicino', 'Hotel Artemide']);
		expect(first.fixedStart[1].dwellMin).toBe(30);
		expect(first.fixedEnd.map((w) => w.name)).toEqual(['Hotel Artemide']);
	});

	it('anchors the last day hotel then airport', () => {
		const last = tripDays(base).at(-1)!;
		expect(last.fixedStart.map((w) => w.name)).toEqual(['Hotel Artemide']);
		expect(last.fixedEnd.map((w) => w.name)).toEqual(['Hotel Artemide', 'Fiumicino']);
		expect(last.fixedEnd[0].dwellMin).toBe(30);
	});

	it('shapes a day like a middle day when there is no arrival point', () => {
		const [first] = tripDays({ ...base, arrivalPoint: null });
		expect(first.fixedStart.map((w) => w.name)).toEqual(['Hotel Artemide']);
	});

	it('gives a departure day with no usable time zero minutes, not a negative', () => {
		const earlyFlight = { ...base, departureAt: '2026-04-13T05:00:00Z' }; // 07:00 Rome
		const last = tripDays(earlyFlight).at(-1)!;
		expect(last.usableMin).toBe(0);
		expect(last.end.getTime()).toBeGreaterThanOrEqual(last.start.getTime());
	});

	it('skips the bag drop when bag_drop_min is zero', () => {
		const [first] = tripDays({ ...base, bagDropMin: 0 });
		expect(first.fixedStart.map((w) => w.name)).toEqual(['Fiumicino']);
	});

	it('handles a single-day trip', () => {
		expect(
			tripDays({
				...base,
				arrivalAt: '2026-04-10T06:00:00Z',
				departureAt: '2026-04-10T19:00:00Z'
			})
		).toHaveLength(1);
	});

	it('uses the destination timezone, not the machine timezone', () => {
		// 23:30 on the 10th in Tokyo is still the 10th there.
		const tokyo = {
			...base,
			timezone: 'Asia/Tokyo',
			arrivalAt: '2026-04-10T14:30:00Z', // 23:30 Tokyo
			departureAt: '2026-04-12T01:00:00Z', // 10:00 Tokyo
			arrivalPoint: null,
			departurePoint: null
		};
		expect(tripDays(tokyo).map((d) => d.date)).toEqual([
			'2026-04-10',
			'2026-04-11',
			'2026-04-12'
		]);
	});

	it('crosses a spring-forward boundary without losing or duplicating a day', () => {
		// Europe/Rome springs forward 02:00 -> 03:00 on 2026-03-29.
		const dst = {
			...base,
			arrivalAt: '2026-03-27T09:00:00Z',
			departureAt: '2026-03-30T09:00:00Z',
			arrivalPoint: null,
			departurePoint: null
		};
		expect(tripDays(dst).map((d) => d.date)).toEqual([
			'2026-03-27',
			'2026-03-28',
			'2026-03-29',
			'2026-03-30'
		]);
	});
});

describe('local input conversion', () => {
	it('round-trips a wall-clock value through the trip timezone', () => {
		const iso = fromLocalInput('2026-04-10T15:00', 'Europe/Rome');
		expect(iso).toBe('2026-04-10T13:00:00.000Z'); // 15:00 CEST
		expect(toLocalInput(iso, 'Europe/Rome')).toBe('2026-04-10T15:00');
	});

	it('reads the value in the destination zone, not the machine zone', () => {
		// The bug this guards: 15:00 entered for a Tokyo trip must be 15:00 in
		// Tokyo, whatever the planner's own clock says.
		expect(fromLocalInput('2026-04-10T15:00', 'Asia/Tokyo')).toBe('2026-04-10T06:00:00.000Z');
	});

	it('renders midnight as 00:00, not 24:00', () => {
		expect(toLocalInput('2026-04-09T22:00:00.000Z', 'Europe/Rome')).toBe('2026-04-10T00:00');
	});
});

describe('the journey shows on the plan', () => {
	const withLegs = (): Trip => ({
		...base,
		arrivalPoint: { name: 'Stansted', at: { lat: 51.886, lng: 0.2389 } },
		departurePoint: { name: 'Stansted', at: { lat: 51.886, lng: 0.2389 } },
		arrivalLegs: [
			{ from: { name: 'Roma Termini', lat: 41.9, lng: 12.5, kind: 'train' },
			  to: { name: 'Milano Centrale', lat: 45.4, lng: 9.2, kind: 'train' },
			  service: 'FR 9612', bookingRef: null, departLocal: null, arriveLocal: null },
			{ from: { name: 'Malpensa', lat: 45.6, lng: 8.7, kind: 'airport' },
			  to: { name: 'Stansted', lat: 51.886, lng: 0.2389, kind: 'airport' },
			  service: 'FR 8012', bookingRef: null, departLocal: null, arriveLocal: null }
		],
		departureLegs: [
			{ from: { name: 'Stansted', lat: 51.886, lng: 0.2389, kind: 'airport' },
			  to: { name: 'Ciampino', lat: 41.8, lng: 12.6, kind: 'airport' },
			  service: 'FR 8013', bookingRef: null, departLocal: null, arriveLocal: null }
		]
	});

	it('gives every terminal and every service a card of its own', () => {
		const [first] = tripDays(withLegs());
		expect(first.fixedStart.map((w) => w.name)).toEqual([
			'Roma Termini',
			'FR 9612',
			'Milano Centrale',
			'Malpensa',
			'FR 8012',
			'Stansted',
			base.hotelName
		]);
	});

	it('draws the leaving journey after the hotel and the airport', () => {
		const days = tripDays(withLegs());
		const last = days[days.length - 1];
		expect(last.fixedEnd.map((w) => w.name)).toEqual([
			base.hotelName,
			'Stansted',
			'FR 8013',
			'Ciampino'
		]);
	});

	it('marks which cards are terminals and which are the service', () => {
		const [first] = tripDays(withLegs());
		expect(first.fixedStart.map((w) => w.kind)).toEqual([
			'terminal',
			'service',
			'terminal',
			'terminal',
			'service',
			'terminal',
			'hotel'
		]);
	});

	it('draws a station changed at only once, not once per leg', () => {
		const t = withLegs();
		// Arriving into Milano Centrale and leaving from it again.
		t.arrivalLegs[1].from = { name: 'Milano Centrale', lat: 45.4, lng: 9.2, kind: 'train' };
		const [first] = tripDays(t);
		expect(first.fixedStart.filter((w) => w.name === 'Milano Centrale')).toHaveLength(1);
	});

	it('costs no travel: the whole journey sits at the terminal it ends on', () => {
		const [first] = tripDays(withLegs());
		const journey = first.fixedStart.filter((w) => w.kind !== 'hotel');
		expect(journey.every((w) => w.at.lat === 51.886 && w.at.lng === 0.2389)).toBe(true);
		expect(journey.every((w) => w.dwellMin === 0)).toBe(true);
	});

	it('says the route when the ticket has no number on it', () => {
		const t = withLegs();
		t.arrivalLegs = [{ ...t.arrivalLegs[1], service: null }];
		const [first] = tripDays(t);
		expect(first.fixedStart.map((w) => w.name)).toEqual([
			'Malpensa',
			'Malpensa → Stansted',
			'Stansted',
			base.hotelName
		]);
	});

	it('falls back to the plain terminal when there is no journey', () => {
		const [first] = tripDays({ ...withLegs(), arrivalLegs: [] });
		expect(first.fixedStart.map((w) => w.name)).toEqual(['Stansted', base.hotelName]);
	});
});

describe('journey cards carry the times off the ticket', () => {
	const timed = (): Trip => ({
		...base,
		arrivalPoint: { name: 'Stansted', at: { lat: 51.886, lng: 0.2389 } },
		departurePoint: null,
		arrivalLegs: [
			{
				from: { name: 'Roma Termini', lat: 41.9, lng: 12.5, kind: 'train' },
				to: { name: 'Milano Centrale', lat: 45.4, lng: 9.2, kind: 'train' },
				service: 'FR 9612',
				bookingRef: null,
				departLocal: '2026-04-10T08:00',
				arriveLocal: '2026-04-10T11:10'
			}
		],
		departureLegs: []
	});

	it('shows when you leave, the span in between, and when you land', () => {
		const [first] = tripDays(timed());
		expect(first.fixedStart.map((w) => w.timeLabel ?? null)).toEqual([
			'08:00',
			'08:00–11:10',
			'11:10',
			null // the hotel runs on the trip's own clock
		]);
	});

	it('says nothing rather than half a span when only one time is known', () => {
		const t = timed();
		t.arrivalLegs[0].arriveLocal = null;
		const [first] = tripDays(t);
		expect(first.fixedStart[1].timeLabel).toBe('08:00');
		expect(first.fixedStart[2].timeLabel).toBeNull();
	});

	it('leaves a journey with no times to the planner clock', () => {
		const t = timed();
		t.arrivalLegs[0].departLocal = null;
		t.arrivalLegs[0].arriveLocal = null;
		const [first] = tripDays(t);
		expect(first.fixedStart.every((w) => !w.timeLabel)).toBe(true);
	});
});

describe('reinterpret', () => {
	it('keeps the clock reading and moves the instant', () => {
		// 15:45 in Rome, meant as 15:45 in London: an hour later in real time.
		const stored = fromLocalInput('2026-04-10T15:45', 'Europe/Rome');
		const fixed = reinterpret(stored, 'Europe/Rome', 'Europe/London');
		expect(toLocalInput(fixed, 'Europe/London')).toBe('2026-04-10T15:45');
		expect(new Date(fixed).getTime() - new Date(stored).getTime()).toBe(60 * 60_000);
	});

	it('does nothing when the zone is already right', () => {
		const stored = fromLocalInput('2026-04-10T15:45', 'Europe/London');
		expect(reinterpret(stored, 'Europe/London', 'Europe/London')).toBe(stored);
	});

	it('crosses a date line without losing the day', () => {
		const stored = fromLocalInput('2026-04-10T09:00', 'Europe/Rome');
		const fixed = reinterpret(stored, 'Europe/Rome', 'Asia/Tokyo');
		expect(toLocalInput(fixed, 'Asia/Tokyo')).toBe('2026-04-10T09:00');
	});
});
