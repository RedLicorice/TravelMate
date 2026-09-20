export type LatLng = { lat: number; lng: number };
export type Place = { name: string; at: LatLng };

/**
 * A fixed point in a day's route. `dwellMin` is time spent there, not
 * travelling. `kind` exists so the mode chooser can tell an airport transfer
 * from a walk back to the hotel -- nobody walks 25km from a terminal.
 */
export type Waypoint = { name: string; at: LatLng; dwellMin: number; kind: 'hotel' | 'terminal' };

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
function zonedInstant(date: string, time: string, tz: string): Date {
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
			fixedStart.push(placeStop(trip.arrivalPoint));
			// You cannot drag a suitcase around the Colosseum.
			if (trip.bagDropMin > 0) fixedStart.push(hotelStop(trip.bagDropMin));
		} else {
			fixedStart.push(hotelStop(0));
		}

		const fixedEnd: Waypoint[] = [];
		if (i === lastIndex && trip.departurePoint) {
			if (trip.bagDropMin > 0) fixedEnd.push(hotelStop(trip.bagDropMin));
			fixedEnd.push(placeStop(trip.departurePoint));
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
