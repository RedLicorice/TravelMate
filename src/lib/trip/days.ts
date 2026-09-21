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
	kind: 'hotel' | 'terminal' | 'service';
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
	const placeStop = (p: Place): Waypoint => ({
		name: p.name,
		at: p.at,
		dwellMin: 0,
		kind: 'terminal'
	});

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
	const journeyStops = (legs: JourneyLeg[], at: LatLng): Waypoint[] => {
		const out: Waypoint[] = [];
		const push = (
			name: string | null | undefined,
			kind: 'terminal' | 'service',
			timeLabel: string | null = null
		) => {
			if (!name) return;
			// A connection names the same station twice -- arriving on one leg
			// and leaving on the next. It is one card, and it keeps the earlier
			// arrival time rather than being redrawn with the later departure.
			if (out[out.length - 1]?.name === name) return;
			out.push({ name, at, dwellMin: 0, kind, timeLabel });
		};

		for (const leg of legs) {
			push(leg.from?.name, 'terminal', clockOf(leg.departLocal));
			const route = [leg.from?.name, leg.to?.name].filter(Boolean).join(' → ');
			push(leg.service ?? (route || null), 'service', span(leg));
			push(leg.to?.name, 'terminal', clockOf(leg.arriveLocal));
		}
		return out;
	};

	return dates.map((date, i) => {
		const windowStart = zonedInstant(date, trip.dayStart, tz);
		const windowEnd = zonedInstant(date, trip.dayEnd, tz);

		// The first day cannot begin before the traveller is out of the airport;
		// the last cannot run past the moment they must leave for it.
		const start =
			i === 0
				? new Date(Math.max(windowStart.getTime(), arrival.getTime() + trip.arrivalBufferMin * MIN))
				: windowStart;
		const rawEnd =
			i === lastIndex
				? new Date(
						Math.min(windowEnd.getTime(), departure.getTime() - trip.departureBufferMin * MIN)
					)
				: windowEnd;
		// A 07:00 flight leaves a day of negative length. Clamp to empty: the
		// planner should schedule nothing, not schedule backwards.
		const end = new Date(Math.max(start.getTime(), rawEnd.getTime()));

		const fixedStart: Waypoint[] = [];
		if (i === 0 && trip.arrivalPoint) {
			const journey = journeyStops(trip.arrivalLegs, trip.arrivalPoint.at);
			// The journey already ends at the terminal the traveller landed at,
			// so adding it again would draw the airport twice.
			if (journey.length) fixedStart.push(...journey);
			else fixedStart.push(placeStop(trip.arrivalPoint));
			// You cannot drag a suitcase around the Colosseum.
			if (trip.bagDropMin > 0) fixedStart.push(hotelStop(trip.bagDropMin));
		} else {
			fixedStart.push(hotelStop(0));
		}

		const fixedEnd: Waypoint[] = [];
		if (i === lastIndex && trip.departurePoint) {
			if (trip.bagDropMin > 0) fixedEnd.push(hotelStop(trip.bagDropMin));
			const journey = journeyStops(trip.departureLegs, trip.departurePoint.at);
			if (journey.length) fixedEnd.push(...journey);
			else fixedEnd.push(placeStop(trip.departurePoint));
		} else {
			fixedEnd.push(hotelStop(0));
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

/** The inverse: a `datetime-local` value read as wall-clock time in `tz`. */
export function fromLocalInput(value: string, tz: string): string {
	const [date, time] = value.split('T');
	return zonedInstant(date, time.slice(0, 5), tz).toISOString();
}
