import type { JourneyLeg } from './journey';

export type LatLng = { lat: number; lng: number };
export type Place = { name: string; at: LatLng };

/**
 * A fixed point in a day's route. `dwellMin` is time spent there, not
 * travelling. `kind` exists so the mode chooser can tell an airport transfer
 * from a walk back to the hotel -- nobody walks 25km from a terminal.
 */
export type Waypoint = {
	name: string;
	at: LatLng;
	dwellMin: number;
	/**
	 * 'service' is the flight, train or sailing itself rather than a place: it
	 * sits at the terminal's own coordinates so it costs no travel, and takes
	 * no time in the day because it happens outside the day's window.
	 */
	/** 'chore' is time the trip spends on itself: getting ready, bags. */
	kind: 'hotel' | 'terminal' | 'service' | 'chore';
	/**
	 * A wall-clock time to show instead of the planner's own, for a card whose
	 * real time is on a ticket rather than on the trip's clock. The journey
	 * costs the day nothing, so every one of its cards would otherwise read the
	 * same minute.
	 */
	timeLabel?: string | null;
};

export type Trip = {
	hotelName: string;
	hotel: LatLng;
	/** IANA zone of the destination city, e.g. 'Europe/Rome'. */
	timezone: string;
	/** ISO instants. Arrival is when the plane lands, not when sightseeing starts. */
	arrivalAt: string;
	departureAt: string;
	arrivalPoint: Place | null;
	departurePoint: Place | null;
	/** The journey in and the journey out, shown alongside their terminals. */
	arrivalLegs: JourneyLeg[];
	departureLegs: JourneyLeg[];
	/**
	 * Waking and getting out of the door. Shown as a card so the morning is
	 * visibly accounted for; it costs the plan nothing because `dayStart` has
	 * already been pushed past it.
	 */
	prep: { wakeAt: string; prepMin: number } | null;
	arrivalBufferMin: number;
	departureBufferMin: number;
	bagDropMin: number;
	/** Local wall-clock 'HH:MM' in `timezone`. */
	dayStart: string;
	dayEnd: string;
};

export type Day = {
	/** YYYY-MM-DD in the trip's timezone. */
	date: string;
	start: Date;
	end: Date;
	fixedStart: Waypoint[];
	fixedEnd: Waypoint[];
	/** Minutes between start and end. Never negative. */
	usableMin: number;
};

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

/**
 * Milliseconds to add to a UTC instant to get the wall-clock reading in `tz`.
 * Intl is the only timezone database available without a dependency.
 */
function tzOffsetMs(at: Date, tz: string): number {
	const parts = new Intl.DateTimeFormat('en-CA', {
		timeZone: tz,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hour12: false
	}).formatToParts(at);
	const g = (t: string) => Number(parts.find((p) => p.type === t)!.value);
	// Some ICU versions render midnight as hour 24; Date.UTC wants 0.
	return (
		Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute'), g('second')) -
		at.getTime()
	);
}

/** The YYYY-MM-DD a given instant falls on, in `tz`. */
function zonedDate(at: Date, tz: string): string {
	return new Intl.DateTimeFormat('en-CA', {
		timeZone: tz,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit'
	}).format(at);
}

/**
 * The instant at which local wall-clock `date`T`time` occurs in `tz`.
 * Two passes: guess at UTC, correct by the offset there, then re-measure in
 * case the correction itself crossed a DST boundary.
 * ponytail: a wall-clock time skipped by a spring-forward resolves to the
 * instant after the jump. Upgrade to Temporal.ZonedDateTime when it ships.
 */
export function zonedInstant(date: string, time: string, tz: string): Date {
	const naive = new Date(`${date}T${time}:00Z`).getTime();
	let at = new Date(naive);
	for (let i = 0; i < 2; i++) at = new Date(naive - tzOffsetMs(at, tz));
	return at;
}

/**
 * All YYYY-MM-DD strings from `from` to `to` inclusive.
 *
 * Pure calendar arithmetic in UTC, which has no DST, so +24h is always exactly
 * one calendar day. Walking real instants in the trip's zone instead drifts by
 * the offset across a clock change and silently drops the final day.
 */
function dateRange(from: string, to: string): string[] {
	const out: string[] = [];
	const [fy, fm, fd] = from.split('-').map(Number);
	const [ty, tm, td] = to.split('-').map(Number);
	const limit = Date.UTC(ty, tm - 1, td);
	for (let t = Date.UTC(fy, fm - 1, fd); t <= limit; t += DAY) {
		out.push(new Date(t).toISOString().slice(0, 10));
	}
	return out;
}

/**
 * The days of a trip, with the journeys in and out drawn onto the first and
 * the last.
 *
 * Only the journeys. The hotel a day starts and ends at, the half hour spent
 * getting out of the door, the bags: those are the traveller's to place, and
 * are placements like every stop -- draggable, removable, and addable as often
 * as they like. This used to draw them, which is why they could not be moved.
 */
export function tripDays(trip: Trip): Day[] {
	const tz = trip.timezone;
	const arrival = new Date(trip.arrivalAt);
	const departure = new Date(trip.departureAt);

	const dates = dateRange(zonedDate(arrival, tz), zonedDate(departure, tz));
	const lastIndex = dates.length - 1;

	const hotelStop = (dwellMin: number): Waypoint => ({
		name: trip.hotelName,
		at: trip.hotel,
		dwellMin,
		kind: 'hotel'
	});
	/** Time the trip spends on itself. Drawn at the hotel, because that is where it happens. */
	const choreStop = (name: string, dwellMin: number, timeLabel: string | null = null): Waypoint => ({
		name,
		at: trip.hotel,
		dwellMin,
		kind: 'chore',
		timeLabel
	});

	const placeStop = (p: Place, dwellMin = 0): Waypoint => ({
		name: p.name,
		at: p.at,
		dwellMin,
		kind: 'terminal'
	});

	/** 'HH:MM' a number of minutes either side of another 'HH:MM'. */
	const shift = (clock: string, minutes: number) => {
		const [h, m] = clock.split(':').map(Number);
		const at = (((h * 60 + m + minutes) % 1440) + 1440) % 1440;
		return `${String(Math.floor(at / 60)).padStart(2, '0')}:${String(at % 60).padStart(2, '0')}`;
	};

	/** 'HH:MM' out of a `YYYY-MM-DDTHH:MM` the traveller typed. */
	const clockOf = (local: string | null) => local?.split('T')[1]?.slice(0, 5) ?? null;

	const span = (leg: JourneyLeg) => {
		const from = clockOf(leg.departLocal);
		const to = clockOf(leg.arriveLocal);
		return from && to ? `${from}–${to}` : (from ?? to);
	};

	/**
	 * The journey, card by card: every terminal it touches and every service
	 * between them. Rome, the train, Milan, the airport, the flight, Stansted.
	 *
	 * All of them sit at `at` -- the terminal where the trip actually begins or
	 * ends -- rather than at their own coordinates. The whole journey happens
	 * outside the day's window, so it must cost the plan nothing; giving Roma
	 * Termini its real position would have the planner cost a leg from Rome to
	 * London and swallow the day whole.
	 */
	const journeyStops = (legs: JourneyLeg[], at: LatLng, lastOutMin = 0): Waypoint[] => {
		const out: Waypoint[] = [];
		const push = (
			name: string | null | undefined,
			kind: 'terminal' | 'service',
			timeLabel: string | null = null,
			dwellMin = 0
		) => {
			if (!name) return;
			// A connection names the same station twice -- arriving on one leg
			// and leaving on the next. It is one card, and it keeps the earlier
			// arrival time rather than being redrawn with the later departure.
			if (out[out.length - 1]?.name === name) return;
			out.push({ name, at, dwellMin, kind, timeLabel });
		};

		legs.forEach((leg, i) => {
			push(leg.from?.name, 'terminal', clockOf(leg.departLocal));
			const route = [leg.from?.name, leg.to?.name].filter(Boolean).join(' → ');
			push(leg.service ?? (route || null), 'service', span(leg));

			// Getting out of the terminal you just reached. Stated per leg, so a
			// connection can be five minutes and an airport an hour; the trip's
			// own allowance stands in on the leg that ends the journey.
			const out_ = leg.outMin ?? (i === legs.length - 1 ? lastOutMin : 0);
			const landed = clockOf(leg.arriveLocal);

			// A terminal you connect through is somewhere you sit for the whole
			// layover, not a moment you pass through: the card runs from landing
			// to the next departure. Only the label, not the dwell -- the wait
			// happens after the traveller has left the city, so it must not eat
			// the day they are leaving.
			const onward = legs[i + 1];
			const connects = onward?.from?.name && onward.from.name === leg.to?.name;
			const leaves = connects ? clockOf(onward.departLocal) : null;

			const ends = leaves ?? (landed && out_ > 0 ? shift(landed, out_) : null);
			push(leg.to?.name, 'terminal', landed && ends ? `${landed}–${ends}` : landed, out_);
		});
		return out;
	};

	return dates.map((date, i) => {
		const windowStart = zonedInstant(date, trip.dayStart, tz);
		// A day that ends before it starts ends tomorrow: 02:00 means two in the
		// morning, after a long evening, not two o'clock fourteen hours before
		// the traveller got up.
		const sameDayEnd = zonedInstant(date, trip.dayEnd, tz);
		const windowEnd =
			sameDayEnd.getTime() > windowStart.getTime()
				? sameDayEnd
				: new Date(sameDayEnd.getTime() + DAY);

		// Getting out of the airport and checking in are real time spent in a
		// real place, so they are dwell on the terminal cards rather than a
		// clamp nobody can see.
		//
		// The first day begins when the traveller lands, not when their usual
		// day begins. Taking the later of the two left a hole between the
		// journey ending and the day starting -- an hour of nothing, after a
		// morning flight, that the plan would not fill and the traveller could
		// not use. Whoever gets in at six is in the city at six.
		const landing = trip.arrivalPoint
			? arrival.getTime()
			: arrival.getTime() + trip.arrivalBufferMin * MIN;
		const start = i === 0 ? new Date(landing) : windowStart;

		// The last day is over when the way out begins. Checking in is the first
		// card of the journey out, so the day ends where that card starts: the
		// allowance before the flight belongs to the terminal, and a stop
		// scheduled inside it is a stop the traveller cannot make.
		//
		// This used to stretch the window by the allowance and clamp at the
		// departure itself, which let the plan put a museum at half past five
		// for a flight at twenty past six -- drawn before the check-in card and
		// timed straight through it.
		const lastMoment = Math.min(
			windowEnd.getTime(),
			departure.getTime() - trip.departureBufferMin * MIN
		);
		const rawEnd = i === lastIndex ? new Date(lastMoment) : windowEnd;
		// A 07:00 flight leaves a day of negative length. Clamp to empty: the
		// planner should schedule nothing, not schedule backwards.
		const end = new Date(Math.max(start.getTime(), rawEnd.getTime()));

		const fixedStart: Waypoint[] = [];
		if (i === 0 && trip.arrivalPoint) {
			// The journey already ends at the terminal the traveller landed at,
			// so adding it again would draw the airport twice.
			const journey = journeyStops(
				trip.arrivalLegs,
				trip.arrivalPoint.at,
				trip.arrivalBufferMin
			);
			if (journey.length) {
				fixedStart.push(...journey);
			} else {
				fixedStart.push(placeStop(trip.arrivalPoint, trip.arrivalBufferMin));
			}
			// You cannot drag a suitcase around the Colosseum. Its own card, so
			// the half hour it costs is visible rather than hidden inside the
			// hotel's.
			// Arriving at the hotel and dropping the bags are one thing, and it
			// is called checking in. Two cards said the traveller went to the
			// hotel, stood there for no time at all, and then spent half an
			// hour dropping bags at it.
		}

		const fixedEnd: Waypoint[] = [];
		if (i === lastIndex && trip.departurePoint) {
			const journey = journeyStops(trip.departureLegs, trip.departurePoint.at);
			if (journey.length) {
				// Checking in happens at the airport they leave from, which is
				// the first card of the journey out. Its stated time is when the
				// flight goes, and the wait runs up to that rather than on from
				// it -- so the card ends on its label, it does not start there.
				const [leaving] = journey;
				if (leaving?.kind === 'terminal') {
					leaving.dwellMin = trip.departureBufferMin;
					if (leaving.timeLabel && trip.departureBufferMin > 0) {
						leaving.timeLabel = `${shift(leaving.timeLabel, -trip.departureBufferMin)}–${leaving.timeLabel}`;
					}
				}
				fixedEnd.push(...journey);
			} else {
				fixedEnd.push(placeStop(trip.departurePoint, trip.departureBufferMin));
			}
		}

		return {
			date,
			start,
			end,
			fixedStart,
			fixedEnd,
			usableMin: Math.round((end.getTime() - start.getTime()) / MIN)
		};
	});
}

/**
 * An ISO instant rendered as a `datetime-local` value (YYYY-MM-DDTHH:mm) in
 * the trip's zone, not the browser's. A traveller entering "15:00 arrival"
 * means 15:00 where they land.
 */
export function toLocalInput(iso: string, tz: string): string {
	const parts = new Intl.DateTimeFormat('en-CA', {
		timeZone: tz,
		year: 'numeric', month: '2-digit', day: '2-digit',
		hour: '2-digit', minute: '2-digit', hour12: false
	}).formatToParts(new Date(iso));
	const g = (t: string) => parts.find((p) => p.type === t)!.value;
	return `${g('year')}-${g('month')}-${g('day')}T${String(Number(g('hour')) % 24).padStart(2, '0')}:${g('minute')}`;
}

/**
 * The same wall-clock reading, in a different zone.
 *
 * For fixing a trip that was stored against the wrong timezone. The traveller
 * typed 15:45 off a ticket; that has to stay 15:45 when the trip moves from
 * Europe/Rome to Europe/London, which means moving the instant, not relabelling
 * it.
 */
export function reinterpret(iso: string, fromTz: string, toTz: string): string {
	return fromLocalInput(toLocalInput(iso, fromTz), toTz);
}

/** The inverse: a `datetime-local` value read as wall-clock time in `tz`. */
export function fromLocalInput(value: string, tz: string): string {
	const [date, time] = value.split('T');
	return zonedInstant(date, time.slice(0, 5), tz).toISOString();
}
