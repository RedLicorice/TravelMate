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
export type JourneyLeg = {
	from: JourneyPoint | null;
	to: JourneyPoint | null;
	/** Flight, train or sailing number, as printed on the ticket. */
	service: string | null;
	bookingRef: string | null;
	/** `YYYY-MM-DDTHH:MM`, local to `from`. */
	departLocal: string | null;
	/** `YYYY-MM-DDTHH:MM`, local to `to`. */
	arriveLocal: string | null;
};

export const emptyLeg = (): JourneyLeg => ({
	from: null,
	to: null,
	service: null,
	bookingRef: null,
	departLocal: null,
	arriveLocal: null
});

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
