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
	prep: null,
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

	it('opens the first day at the moment of landing', () => {
		// Getting out of the airport is dwell on the terminal card rather than
		// a clamp, so the day itself begins when the wheels touch down.
		expect(hhmm(tripDays(base)[0].start, base.timezone)).toBe('15:00');
	});

	it('spends the arrival buffer standing in the arrival terminal', () => {
		const [first] = tripDays(base);
		expect(first.fixedStart[0].name).toBe('Fiumicino');
		expect(first.fixedStart[0].dwellMin).toBe(base.arrivalBufferMin);
	});

	it('closes the last day when the way out begins', () => {
		// Not at the departure itself: checking in is the first card of the
		// journey out, and a stop scheduled inside it is a stop nobody makes.
		expect(hhmm(tripDays(base).at(-1)!.end, base.timezone)).toBe('16:00');
	});

	it('leaves no room after the way out begins', () => {
		// Nothing may be scheduled inside the journey home: the window closes
		// where the check-in card opens, so a stop cannot be timed through it.
		const last = tripDays(base).at(-1)!;
		const checkIn = new Date(
			Date.parse(base.departureAt) - base.departureBufferMin * 60_000
		);
		expect(last.end.getTime()).toBeLessThanOrEqual(checkIn.getTime());
	});

	it('uses the normal day window for middle days', () => {
		const [, second] = tripDays(base);
		expect(hhmm(second.start, base.timezone)).toBe('09:00');
		expect(hhmm(second.end, base.timezone)).toBe('19:00');
	});

	it('starts the first day on landing, however early that is', () => {
		// Waiting for day_start left an hour of nothing between the journey
		// ending and the day beginning. Whoever gets in at five is in the city
		// at five.
		const early = { ...base, arrivalAt: '2026-04-10T03:00:00Z' }; // 05:00 Rome
		expect(hhmm(tripDays(early)[0].start, base.timezone)).toBe('05:00');
	});

	it('anchors the first day the airport, then checking in', () => {
		// Arriving at the hotel and dropping the bags are one thing, and it is
		// called checking in.
		const [first] = tripDays(base);
		expect(first.fixedStart.map((w) => w.name)).toEqual([
			'Fiumicino',
			'Hotel Artemide check-in'
		]);
		expect(first.fixedStart[1].dwellMin).toBe(30);
		expect(first.fixedStart[1].kind).toBe('hotel');
		expect(first.fixedEnd.map((w) => w.name)).toEqual(['Hotel Artemide']);
	});

	it('anchors the last day bags, hotel, then airport', () => {
		const last = tripDays(base).at(-1)!;
		expect(last.fixedStart.map((w) => w.name)).toEqual(['Hotel Artemide']);
		expect(last.fixedEnd.map((w) => w.name)).toEqual([
			'Hotel Artemide',
			'Collect the bags',
			'Fiumicino'
		]);
		expect(last.fixedEnd[1].dwellMin).toBe(30);
		// Checking in is time spent in the terminal, not a clamp.
		expect(last.fixedEnd[2].dwellMin).toBe(base.departureBufferMin);
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

	it('checks in in no time when nothing is said about the bags', () => {
		const [first] = tripDays({ ...base, bagDropMin: 0 });
		expect(first.fixedStart.map((w) => w.name)).toEqual([
			'Fiumicino',
			'Hotel Artemide check-in'
		]);
		expect(first.fixedStart[1].dwellMin).toBe(0);
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
			  service: 'FR 9612', bookingRef: null, departLocal: null, arriveLocal: null, outMin: null },
			{ from: { name: 'Malpensa', lat: 45.6, lng: 8.7, kind: 'airport' },
			  to: { name: 'Stansted', lat: 51.886, lng: 0.2389, kind: 'airport' },
			  service: 'FR 8012', bookingRef: null, departLocal: null, arriveLocal: null, outMin: null }
		],
		departureLegs: [
			{ from: { name: 'Stansted', lat: 51.886, lng: 0.2389, kind: 'airport' },
			  to: { name: 'Ciampino', lat: 41.8, lng: 12.6, kind: 'airport' },
			  service: 'FR 8013', bookingRef: null, departLocal: null, arriveLocal: null, outMin: null }
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
			`${base.hotelName} check-in`
		]);
	});

	it('draws the leaving journey after the hotel and the airport', () => {
		const days = tripDays(withLegs());
		const last = days[days.length - 1];
		expect(last.fixedEnd.map((w) => w.name)).toEqual([
			base.hotelName,
			'Collect the bags',
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
		const journey = first.fixedStart.filter((w) => w.kind === 'terminal' || w.kind === 'service');
		expect(journey.every((w) => w.at.lat === 51.886 && w.at.lng === 0.2389)).toBe(true);
		// All but the airport they landed at, which holds the time it takes to
		// get out of it.
		expect(journey.slice(0, -1).every((w) => w.dwellMin === 0)).toBe(true);
		expect(journey.at(-1)!.dwellMin).toBe(base.arrivalBufferMin);
	});

	it('says the route when the ticket has no number on it', () => {
		const t = withLegs();
		t.arrivalLegs = [{ ...t.arrivalLegs[1], service: null }];
		const [first] = tripDays(t);
		expect(first.fixedStart.map((w) => w.name)).toEqual([
			'Malpensa',
			'Malpensa → Stansted',
			'Stansted',
			`${base.hotelName} check-in`
		]);
	});

	it('falls back to the plain terminal when there is no journey', () => {
		const [first] = tripDays({ ...withLegs(), arrivalLegs: [] });
		expect(first.fixedStart.map((w) => w.name)).toEqual([
			'Stansted',
			`${base.hotelName} check-in`
		]);
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
				arriveLocal: '2026-04-10T11:10',
				outMin: null
			}
		],
		departureLegs: []
	});

	it('shows when you leave, the span in between, and when you land', () => {
		const [first] = tripDays(timed());
		expect(first.fixedStart.map((w) => w.timeLabel ?? null)).toEqual([
			'08:00',
			'08:00–11:10',
			// Landing at 11:10 and 45 minutes to get out of the airport.
			'11:10–11:55',
			null // checking in runs on the trip's own clock
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

describe('the morning is accounted for', () => {
	const withPrep = (): Trip => ({ ...base, prep: { wakeAt: '08:00', prepMin: 30 } });

	it('gives getting ready a card of its own', () => {
		const days = tripDays(withPrep());
		// Not the arrival day: on that one the traveller is at an airport.
		const middle = days[1];
		expect(middle.fixedStart.map((w) => w.name)).toEqual(['Hotel Artemide', 'Getting ready']);
	});

	it('spends real time on it, so the day opens at the wake time', () => {
		// The caller passes the wake time as dayStart; the half hour after it is
		// this card, not a window the plan silently starts late.
		const ready = tripDays(withPrep())[1].fixedStart[1];
		expect(ready.dwellMin).toBe(30);
		expect(ready.kind).toBe('chore');
	});

	it('says nothing when nobody has set a wake time', () => {
		expect(tripDays(base)[1].fixedStart.map((w) => w.name)).toEqual(['Hotel Artemide']);
	});
});

describe('the departure day', () => {
	const leaving = (): Trip => ({
		...base,
		arrivalPoint: null,
		arrivalLegs: [],
		departurePoint: { name: 'Stansted', at: { lat: 51.886, lng: 0.2389 } },
		departureBufferMin: 120,
		bagDropMin: 30,
		departureLegs: [
			{
				from: { name: 'Stansted', lat: 51.886, lng: 0.2389, kind: 'airport' },
				to: { name: 'Ciampino', lat: 41.8, lng: 12.6, kind: 'airport' },
				service: 'FR 8013',
				bookingRef: null,
				departLocal: '2026-04-13T06:55',
				arriveLocal: '2026-04-13T09:50',
				outMin: null
			}
		]
	});

	it('goes back to the hotel and then collects the bags, in that order', () => {
		const last = tripDays(leaving()).at(-1)!;
		expect(last.fixedEnd.slice(0, 2).map((w) => w.name)).toEqual([
			'Hotel Artemide',
			'Collect the bags'
		]);
	});

	it('runs check-in up to the flight, not on from it', () => {
		// Two hours before a 06:55 departure is 04:55. Showing 06:55-08:55 had
		// the traveller checking in after the plane had gone.
		const last = tripDays(leaving()).at(-1)!;
		const airport = last.fixedEnd.find((w) => w.name === 'Stansted')!;
		expect(airport.timeLabel).toBe('04:55–06:55');
		expect(airport.dwellMin).toBe(120);
	});

	it('leaves the service itself reading as the flight', () => {
		const last = tripDays(leaving()).at(-1)!;
		const flight = last.fixedEnd.find((w) => w.kind === 'service')!;
		expect(flight.timeLabel).toBe('06:55–09:50');
	});

	it('runs the arrival queue on from the landing, the mirror of check-in', () => {
		const t: Trip = {
			...base,
			arrivalPoint: { name: 'Stansted', at: { lat: 51.886, lng: 0.2389 } },
			arrivalBufferMin: 45,
			arrivalLegs: [
				{
					from: { name: 'Ciampino', lat: 41.8, lng: 12.6, kind: 'airport' },
					to: { name: 'Stansted', lat: 51.886, lng: 0.2389, kind: 'airport' },
					service: 'FR 8012',
					bookingRef: null,
					departLocal: '2026-04-10T13:00',
					arriveLocal: '2026-04-10T15:00',
				outMin: null
				}
			]
		};
		const airport = tripDays(t)[0].fixedStart.find((w) => w.name === 'Stansted')!;
		expect(airport.timeLabel).toBe('15:00–15:45');
	});

	it('crosses midnight backwards without a negative clock', () => {
		const t = leaving();
		t.departureLegs[0].departLocal = '2026-04-13T00:30';
		const airport = tripDays(t).at(-1)!.fixedEnd.find((w) => w.name === 'Stansted')!;
		expect(airport.timeLabel).toBe('22:30–00:30');
	});
});

describe('getting out is per terminal', () => {
	const connecting = (outMin: number | null, lastOut: number | null): Trip => ({
		...base,
		arrivalPoint: { name: 'Stansted', at: { lat: 51.886, lng: 0.2389 } },
		arrivalBufferMin: 45,
		arrivalLegs: [
			{
				from: { name: 'Roma Termini', lat: 41.9, lng: 12.5, kind: 'train' },
				to: { name: 'Milano Centrale', lat: 45.4, lng: 9.2, kind: 'train' },
				service: 'FR 9612',
				bookingRef: null,
				departLocal: '2026-04-10T08:00',
				arriveLocal: '2026-04-10T11:10',
				outMin
			},
			{
				from: { name: 'Malpensa', lat: 45.6, lng: 8.7, kind: 'airport' },
				to: { name: 'Stansted', lat: 51.886, lng: 0.2389, kind: 'airport' },
				service: 'FR 8012',
				bookingRef: null,
				departLocal: '2026-04-10T14:30',
				arriveLocal: '2026-04-10T15:45',
				outMin: lastOut
			}
		]
	});

	const named = (t: Trip, name: string) =>
		tripDays(t)[0].fixedStart.find((w) => w.name === name)!;

	it('lets a connection have its own allowance', () => {
		const milan = named(connecting(10, null), 'Milano Centrale');
		expect(milan.dwellMin).toBe(10);
		expect(milan.timeLabel).toBe('11:10–11:20');
	});

	it('gives a connection none by default: a platform change is not an airport', () => {
		const milan = named(connecting(null, null), 'Milano Centrale');
		expect(milan.dwellMin).toBe(0);
		expect(milan.timeLabel).toBe('11:10');
	});

	it("falls back to the trip's allowance on the leg that ends the journey", () => {
		expect(named(connecting(null, null), 'Stansted').dwellMin).toBe(45);
	});

	it('prefers the terminal it was set on over the trip default', () => {
		const stansted = named(connecting(null, 90), 'Stansted');
		expect(stansted.dwellMin).toBe(90);
		expect(stansted.timeLabel).toBe('15:45–17:15');
	});
});

describe('a terminal you connect through', () => {
	const viaMalpensa = (): Trip => ({
		...base,
		arrivalPoint: null,
		arrivalLegs: [],
		departurePoint: { name: 'Stansted', at: { lat: 51.886, lng: 0.2389 } },
		departureLegs: [
			{
				from: { name: 'Stansted', lat: 51.886, lng: 0.2389, kind: 'airport' },
				to: { name: 'Malpensa', lat: 45.63, lng: 8.72, kind: 'airport' },
				service: 'FR 8012',
				bookingRef: null,
				departLocal: '2026-04-13T07:00',
				arriveLocal: '2026-04-13T10:15',
				outMin: null
			},
			{
				from: { name: 'Malpensa', lat: 45.63, lng: 8.72, kind: 'airport' },
				to: { name: 'Reggio Calabria', lat: 38.07, lng: 15.65, kind: 'airport' },
				service: 'FR 4471',
				bookingRef: null,
				departLocal: '2026-04-13T14:40',
				arriveLocal: '2026-04-13T16:20',
				outMin: null
			}
		]
	});

	const card = (t: Trip, name: string) =>
		tripDays(t).at(-1)!.fixedEnd.find((w) => w.name === name)!;

	it('runs from landing to the next departure, not a moment', () => {
		// Four hours sitting in Malpensa is four hours in Malpensa, not a gap.
		expect(card(viaMalpensa(), 'Malpensa').timeLabel).toBe('10:15–14:40');
	});

	it('is one card, not one per leg', () => {
		const last = tripDays(viaMalpensa()).at(-1)!;
		expect(last.fixedEnd.filter((w) => w.name === 'Malpensa')).toHaveLength(1);
	});

	it('does not charge the layover to the day being left', () => {
		// The wait happens after the traveller has gone; spending it out of the
		// departure day would compress the morning for no reason.
		expect(card(viaMalpensa(), 'Malpensa').dwellMin).toBe(0);
	});

	it('still ends on its own allowance when nothing follows', () => {
		const t = viaMalpensa();
		t.departureLegs[1].outMin = 30;
		expect(card(t, 'Reggio Calabria').timeLabel).toBe('16:20–16:50');
	});
});

describe('a day that runs past midnight', () => {
	const nightOwl: Trip = { ...base, dayStart: '09:00', dayEnd: '02:00' };

	it('ends at two in the morning, not at two in the afternoon', () => {
		const [, second] = tripDays(nightOwl);
		expect(second.end.getTime()).toBeGreaterThan(second.start.getTime());
		expect(hhmm(second.end, base.timezone)).toBe('02:00');
	});

	it('gives the day seventeen hours, not a negative one', () => {
		const [, second] = tripDays(nightOwl);
		expect(second.usableMin).toBe(17 * 60);
	});

	it('leaves an ordinary day alone', () => {
		const [, second] = tripDays(base);
		expect(hhmm(second.end, base.timezone)).toBe('19:00');
		expect(second.usableMin).toBe(10 * 60);
	});
});
