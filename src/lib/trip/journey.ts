import type { TerminalKind } from '$lib/poi';
import { fromLocalInput } from './days';

export type JourneyPoint = {
	name: string;
	lat: number;
	lng: number;
	kind: TerminalKind;
};

/**
 * One hop of the way in or the way out. Rome to Milan by train and Milan to
 * London by air are two legs of one arrival.
 *
 * Times are local wall clock at the station they are read from -- which is how
 * a ticket reads, and the only honest way to store them without carrying a
 * timezone per leg. Only the leg that touches the destination city is ever
 * converted to an instant, and that one is in the trip's own zone.
 */
/**
 * How a leg is travelled. It decides which fields the leg is asked for.
 * 'transit' is public transport in town: a bus, a tram, a metro line.
 */
export type JourneyMode = 'flight' | 'train' | 'coach' | 'ferry' | 'transit' | 'car';

export type JourneyLeg = {
	/**
	 * This leg's own identity, for as long as the form is open.
	 *
	 * The list used to be drawn by position, so adding a connection in the
	 * middle tore down every box below it and built it again -- which is what
	 * a card "not opening instantly" actually was.
	 */
	id?: string;
	from: JourneyPoint | null;
	to: JourneyPoint | null;
	/**
	 * Absent on legs stored before modes existed, and on a fresh leg until the
	 * traveller says otherwise; `modeOf` reads those from the terminals instead,
	 * so an old row keeps looking the way it always did.
	 */
	mode?: JourneyMode;
	/** Flight, train or sailing number, as printed on the ticket. Never set on a car leg. */
	service: string | null;
	bookingRef: string | null;
	/** `YYYY-MM-DDTHH:MM`, local to `from`. */
	departLocal: string | null;
	/** `YYYY-MM-DDTHH:MM`, local to `to`. */
	arriveLocal: string | null;
	/**
	 * Minutes to get out of `to` -- passport queues, baggage reclaim, the walk
	 * to the exit. Per terminal, because Stansted and a village station are not
	 * the same errand. Null falls back to the trip's own allowance on the leg
	 * that lands in the destination city, and to nothing on a connection.
	 */
	outMin: number | null;
};

export const emptyLeg = (): JourneyLeg => ({
	id: crypto.randomUUID(),
	from: null,
	to: null,
	service: null,
	bookingRef: null,
	departLocal: null,
	arriveLocal: null,
	outMin: null
});

const MODE_OF_KIND: Record<TerminalKind, JourneyMode> = {
	airport: 'flight',
	train: 'train',
	bus: 'coach',
	ferry: 'ferry',
	// Journeys were flights before anything else could be said, so an unknown
	// terminal keeps reading as one rather than changing under old trips.
	other: 'flight'
};

/**
 * The mode a leg is travelled by. A declared mode wins; otherwise it is read
 * off whichever end the traveller has named, since a leg out of an airport is
 * a flight until they say it is a coach.
 */
export const modeOf = (leg: JourneyLeg): JourneyMode =>
	leg.mode ?? MODE_OF_KIND[leg.from?.kind ?? leg.to?.kind ?? 'other'];

/**
 * What the planner needs from a journey.
 *
 * Only the endpoints matter: day one starts wherever the traveller finally
 * lands, and the last day ends when they first set off. The legs in between
 * are the traveller's own record -- a connection in Milan changes what they
 * are doing at 11am on a travel day, not what the plan does in the destination
 * city.
 *
 * `arrival` reads the last leg that names a destination; `departure` the first
 * that names an origin. A half-filled journey summarises to nothing rather
 * than to a point it only half knows.
 */
export function endpointOf(
	legs: JourneyLeg[],
	direction: 'arrival' | 'departure'
): { point: JourneyPoint; local: string | null } | null {
	const ordered = direction === 'arrival' ? [...legs].reverse() : legs;
	for (const leg of ordered) {
		const point = direction === 'arrival' ? leg.to : leg.from;
		if (point) {
			return { point, local: direction === 'arrival' ? leg.arriveLocal : leg.departLocal };
		}
	}
	return null;
}

/**
 * The trip columns a journey implies. Returned rather than applied, so the
 * caller decides whether a journey that says nothing about its time should
 * overwrite a time the traveller set by hand.
 */
export function summaryOf(
	legs: JourneyLeg[],
	direction: 'arrival' | 'departure',
	timezone: string
): { name: string | null; lat: number | null; lng: number | null; kind: string | null; at: string | null } {
	const end = endpointOf(legs, direction);
	if (!end) return { name: null, lat: null, lng: null, kind: null, at: null };
	return {
		name: end.point.name,
		lat: end.point.lat,
		lng: end.point.lng,
		kind: end.point.kind,
		at: end.local ? fromLocalInput(end.local, timezone) : null
	};
}

/** Legs with both ends named, in order, for describing the journey in a line. */
export const describe = (legs: JourneyLeg[]): string =>
	legs
		.filter((l) => l.from || l.to)
		.map((l) => {
			const hop = `${l.from?.name ?? '?'} → ${l.to?.name ?? '?'}`;
			return l.service ? `${hop} (${l.service})` : hop;
		})
		.join(', ');
