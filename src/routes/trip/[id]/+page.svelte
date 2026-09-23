<script lang="ts">
	import { formatter } from '$lib/clock';
	import { onMount, untrack } from 'svelte';
	import { page } from '$app/state';
	import { base } from '$app/paths';
	import { goto } from '$app/navigation';
	import {
		cityBBox,
		getTrip,
		hotelMissing,
		setShareToken,
		toTrip,
		repairTimezone,
		setTripImage,
		updateAllowance,
		updateCityBBox,
		updateCountryCode,
		updateHotel
	} from '$lib/trip/repo';
	import {
		addPoi,
		listPois,
		toPlanPoi,
		updatePoi,
		type PoiRow
	} from '$lib/trip/pois';
	import { describe as describeJourney } from '$lib/trip/journey';
	import { addMeal, chooseMeal, emptyMeal, mealCard, skipMeal } from '$lib/trip/meals';
	import {
		holdPlacement,
		listPlacements,
		place,
		placeAnchor,
		placeMany,
		between,
		moveTo,
		setFurnished,
		setPlacementMinutes,
		nightCards,
		nightOf,
		skipNight,
		unplace as dropPlacement,
		type PlacementRow
	} from '$lib/trip/placements';
	import { tripDays, type Day, type LatLng } from '$lib/trip/days';
	import {
		replan,
		schedule,
		REASON_TEXT,
		type PlanResult,
		type PlannedStop,
		PLANNER_VERSION,
		type PlanPoi,
		type Unplaced,
		type UnplacedReason
	} from '$lib/plan/planner';
	import { loadPlan, savePlan, staleCount, tableFromPlan, toPlannedDays } from '$lib/trip/plan';
	import {
		effectiveDayStart,
		isMeal,
		latestPrep,
		latestReady,
		MEAL_LABEL,
		MEAL_MINUTES,
		MEAL_NAMES,
		slotAt,
		slotsFrom,
		tightest,
		type MealName,
		type MealWindows
	} from '$lib/plan/meals';
	import { resolveCurves, type CrowdCurves } from '$lib/plan/crowd';
	import { routeShape } from '$lib/plan/route';
	import { firstOf, noTravel, resolveTravel, type TravelTable } from '$lib/plan/travel';
	import { BLOCK_CATEGORY } from '$lib/plan/planner';
	import { pool } from '$lib/pool';
	import { avatarDataUri } from '$lib/avatar';
	import {
		displayName,
		removeMember,
		saveMyProfile,
		setMemberRole,
		tripProfiles,
		type Profile
	} from '$lib/profile.svelte';
	import type { Mode } from '$lib/plan/modes';
	import Autocomplete from '$lib/Autocomplete.svelte';
	import Stars from '$lib/Stars.svelte';
	import LegDetail from '$lib/LegDetail.svelte';
	import { dayTruncated, dayUrl, routePoints } from '$lib/maps';
	import { createDrag, measure, placeOf, type DropTarget, type Ruler } from '$lib/dnd.svelte';
	import { cardTimes } from '$lib/cardtime';
	import { haversineKm } from '$lib/plan/geo';
	import { longPress } from '$lib/longpress.svelte';
	import StopCard from '$lib/StopCard.svelte';
	import DayLine from '$lib/DayLine.svelte';
	import TimeGap from '$lib/TimeGap.svelte';
	import TripAvatar from '$lib/TripAvatar.svelte';
	import { session } from '$lib/session.svelte';
	import {
		accept,
		asideFor,
		asideOn,
		mutate,
		reject,
		store,
		upload,
		watchTrip,
		type Mutation,
		type Writer
	} from '$lib/store/store.svelte';
	import Notices from '$lib/Notices.svelte';
	import ConflictSheet from '$lib/ConflictSheet.svelte';
	import { explain } from '$lib/conflict';
	import { track, watching } from '$lib/telemetry';
	import { zoneAt } from '$lib/trip/timezone';
	import TripMap from '$lib/GoogleMap.svelte';
	import { poi as provider, type City } from '$lib/poi';

	const tripId = page.params.id!;

	/** The trip, as this device holds it. Every read below is from the device. */
	const row = $derived(getTrip(tripId));
	/** Sharing, editing and the picture are the owner's; the policies say so
	    too, and a control the server will refuse is a control that lies. */
	const isOwner = $derived(!!row && row.user_id === session.user?.id);
	/** The wishlist: places wanted, each once. */
	const pois = $derived(listPois(tripId));
	/**
	 * Which visit the open card is showing, when it was opened from the plan.
	 * Null when it was opened from the wishlist, where a place has no one
	 * visit to speak for.
	 */
	let cardedVisit = $state<string | null>(null);
	/**
	 * The visits: this place, on this day, in this position. A place may have
	 * as many as the traveller likes, and a place with none is simply on the
	 * wishlist and not yet on the plan.
	 */
	const placements = $derived(listPlacements(tripId));
	const poiById = $derived(new Map(pois.map((p) => [p.id, p])));
	/**
	 * A place on the wishlist that has no visit yet, in the shape the planner
	 * is told about.
	 *
	 * Its id says so: Replan is what turns these into real visits, and until
	 * it has, there is no row to name. Anything that comes back carrying one
	 * of these ids is a visit that needs creating rather than moving.
	 */
	const NEW = 'new:';
	const draftVisit = (p: PoiRow): PlanPoi => ({
		id: `${NEW}${p.id}`,
		poiId: p.id,
		name: p.name,
		lat: p.lat,
		lng: p.lng,
		category: p.category,
		durationMin: p.duration_min,
		priority: p.priority ?? 3,
		dayIndex: null,
		// No clock: it is not on a day yet, and Replan is what gives it one.
		at: '',
		pinned: false,
		pinnedAt: null,
		branches: p.any_branch ? (p.branches ?? []) : null,
		exitAt:
			p.exit_lat !== null && p.exit_lng !== null ? { lat: p.exit_lat, lng: p.exit_lng } : null
	});

	/**
	 * Every visit, in the shape the planner is told about.
	 *
	 * A placement is either a place off the wishlist or a piece of the day's
	 * own furniture -- the hotel, a stretch of time. The furniture has no
	 * wishlist row, so it is described here: it happens at the hotel, it takes
	 * however long it was given or whatever the trip's own allowance says, and
	 * it is held where the traveller put it.
	 */
	const visitOf = (pl: PlacementRow, heldAt: string | null): PlanPoi | null => {
		if (pl.kind === 'stop') {
			const poi = pl.poi_id ? poiById.get(pl.poi_id) : null;
			return poi ? toPlanPoi(poi, pl, heldAt) : null;
		}
		if (!row) return null;
		// A meal at a place the traveller chose is had there, for as long as
		// that place takes; one still to decide is had wherever the day is.
		const venue = pl.kind === 'meal' && pl.poi_id ? poiById.get(pl.poi_id) : undefined;
		return {
			id: pl.id,
			poiId: venue?.id ?? null,
			kind: pl.kind,
			meal: pl.meal,
			skipped: pl.skipped,
			// A hotel card that says what happens there says where, too: the hotel's
			// name goes in front when it is drawn, so it follows a change of hotel.
			name:
				venue?.name ??
				(pl.kind === 'hotel' && pl.name ? `${row.hotel_name}: ${pl.name}` : pl.name) ??
				(pl.meal ? MEAL_LABEL[pl.meal] : row.hotel_name),
			lat: venue?.lat ?? row.hotel_lat,
			lng: venue?.lng ?? row.hotel_lng,
			category: venue?.category ?? null,
			durationMin: pl.skipped ? 0 : (pl.minutes ?? venue?.duration_min ?? allowanceFor(pl)),
			priority: 3,
			dayIndex: pl.day_index,
			at: pl.at,
			// Held in place by being an anchor, not by a pin. A pin would also
			// hold the moment -- whatever the clock said last time -- and a
			// time that is wrong once would then stay wrong for ever.
			pinned: pl.pinned,
			pinnedAt: pl.pinned ? heldAt : null,
			branches: venue?.any_branch ? (venue.branches ?? []) : null,
			exitAt:
				venue && venue.exit_lat !== null && venue.exit_lng !== null ? { lat: venue.exit_lat, lng: venue.exit_lng } : null
		};
	};

	/**
	 * How long a piece of furniture takes when it has not been told.
	 *
	 * The trip's own sliders answer: the bags on the way in and out, and the
	 * traveller's own getting-ready time, which is theirs across every trip.
	 */
	function allowanceFor(pl: PlacementRow): number {
		if (pl.kind === 'meal') return pl.meal ? MEAL_MINUTES[pl.meal] : 0;
		if (pl.kind !== 'chore' || !row) return 0;
		if (pl.name === 'Getting ready') return prep?.prepMin ?? 0;
		return row.bag_drop_min;
	}
	/** Not on this device, and the server not yet asked for it. */
	const loading = $derived(!row && !store.asked.includes(tripId));
	let error = $state<string | null>(null);
	let busy = $state(false);
	/** What the Replan button is up to, since routing a trip is not instant. */
	let step = $state<string | null>(null);

	/**
	 * What a held-down card is about. A stop is a place; everything else on the
	 * plan is an allowance the trip carries, and the card is exactly where the
	 * traveller notices it is wrong.
	 */
	type Allowance = 'prep' | 'bags' | 'out' | 'checkin';
	/** The place whose card is open. Read from the device, so an edit shows on it at once. */
	let cardedId = $state<string | null>(null);
	const carded = $derived(cardedId ? (poiById.get(cardedId) ?? null) : null);

	// A sheet opened for one slot should not still be filtered by what was
	// typed into the last one.
	$effect(() => {
		void slot;
		slotQuery = '';
	});
	let allowanced = $state<{
		kind: Allowance;
		name: string;
		minutes: number;
		/** The visit being held, when the card is one of the day's own. */
		placementId?: string | null;
	} | null>(null);
	/** A meal container the traveller is holding down on. */
	let mealed = $state<{ day: number; meal: MealName; name: string; poiId: string | null } | null>(
		null
	);

	/** Meals this day has no container for: skipped, or never offered. */
	const missingMeals = $derived.by(() => {
		if (!slot || !row) return [] as MealName[];
		const day = drawn[slot.day];
		const present = new Set(
			(day?.stops ?? [])
				.filter((st) => st.anchorKind === 'meal')
				.map((st) => mealFor(st))
				.filter(Boolean)
		);
		return MEAL_NAMES.filter((m) => !present.has(m));
	});

	/**
	 * What the traveller says about a sitting, as one edit to its card: a
	 * place for it, skip it, bring it back, move it, or give it back to the
	 * plan -- and the day re-timed around that.
	 */
	async function sayMeal(
		dayIdx: number,
		meal: MealName,
		change: { poiId?: string | null; skipped?: boolean; at?: string | null } | 'reset'
	) {
		mealed = null;
		slot = null;
		// At the meal's own hour: read before the edit changes the day under it.
		const sitting = (result?.days[dayIdx]?.stops ?? []).find(
			(st) => st.anchorKind === 'meal' && mealFor(st) === meal
		);
		const at = (change !== 'reset' && change.at) || (sitting ? sitting.arrive.toISOString() : momentFor({ day: dayIdx, before: null }));
		const label = MEAL_LABEL[meal];
		const name =
			change === 'reset'
				? `Gave ${label.toLowerCase()} back to the plan`
				: change.skipped
					? `Skipped ${label.toLowerCase()}`
					: change.poiId
						? `Said what ${label.toLowerCase()} is`
						: change.skipped === false
							? `Added ${label.toLowerCase()}`
							: `Moved ${label.toLowerCase()}`;
		await edit(name, (w) => {
			if (change === 'reset') emptyMeal(w, tripId, dayIdx, meal);
			else if (change.skipped) skipMeal(w, tripId, dayIdx, meal, at);
			else if (change.poiId) chooseMeal(w, tripId, dayIdx, meal, change.poiId, at);
			else addMeal(w, tripId, dayIdx, meal, at);
			retime(w, [dayIdx]);
		});
	}

	/**
	 * One edit, with the re-time that follows from it inside it: the two land
	 * together or not at all. An edit the device cannot keep is said, never
	 * swallowed.
	 */
	async function edit(name: string, work: (w: Writer) => void): Promise<boolean> {
		try {
			await mutate(name, tripId, work);
			return true;
		} catch (e) {
			error = (e as Error).message;
			return false;
		}
	}

	const ALLOWANCE_HINT: Record<Allowance, string> = {
		prep: 'Waking and getting out of the door. Yours, on every trip.',
		bags: 'Checking in when you arrive, and checking out before you leave.',
		out: 'Passport queues and baggage reclaim at the airport you land at.',
		checkin: 'Standing in the terminal before you leave.'
	};

	/** Which allowance a card stands for, if it stands for one. */
	function allowanceOf(stop: PlannedStop, dayIdx: number): Allowance | null {
		if (stop.anchorKind === 'chore') return stop.name === 'Getting ready' ? 'prep' : 'bags';
		// Checking in is the hotel card on the arrival day: one card for
		// arriving and dropping the bags, because that is one thing.
		if (stop.anchorKind === 'hotel') return stop.durationMin > 0 ? 'bags' : null;
		if (stop.anchorKind !== 'terminal') return null;
		return dayIdx === 0 ? 'out' : dayIdx === days.length - 1 ? 'checkin' : null;
	}

	/** Which meal a container card is, from the name the planner gave it. */
	const mealOf = (name: string) =>
		(MEAL_NAMES.find((m) => MEAL_LABEL[m] === name) ?? null) as MealName | null;

	/**
	 * Which meal a container is. An empty one says so in its name; a filled one
	 * wears the name of what fills it, so its hour answers instead.
	 */
	function mealFor(stop: PlannedStop): MealName | null {
		return mealOf(stop.name) ?? slotAt(stop.arrive, row!.timezone, slotsFrom(agreed.windows));
	}

	function holdMeal(stop: PlannedStop, dayIdx: number) {
		const waiting = conflictOf(stop, dayIdx);
		if (waiting) {
			conflict = waiting;
			return;
		}
		const meal = mealFor(stop);
		if (meal) {
			mealed = { day: dayIdx, meal, name: MEAL_LABEL[meal], poiId: stop.poiId };
		}
	}

	function holdAllowance(stop: PlannedStop, dayIdx: number) {
		const waiting = conflictOf(stop, dayIdx);
		if (waiting) {
			conflict = waiting;
			return;
		}
		// A piece of the day's own furniture: how long it takes is this one's,
		// and it can be taken off the day altogether.
		if (stop.placementId && stop.anchor) {
			allowanced = {
				kind: stop.anchorKind === 'chore' ? 'prep' : 'bags',
				name: stop.name,
				minutes: stop.durationMin,
				placementId: stop.placementId
			};
			return;
		}
		const kind = allowanceOf(stop, dayIdx);
		if (!kind || !row) return;
		const minutes =
			kind === 'prep'
				? (prep?.prepMin ?? 0)
				: kind === 'bags'
					? row.bag_drop_min
					: kind === 'out'
						? row.arrival_buffer_min
						: row.departure_buffer_min;
		allowanced = { kind, name: stop.name, minutes };
	}

	async function setAllowance(kind: Allowance, minutes: number, placementId?: string | null) {
		if (!row) return;
		const name = allowanced?.name ?? 'a card';
		allowanced = null;
		// This card's own length, not the trip's: the traveller is saying how
		// long this afternoon at the hotel is, not redefining every hotel stop
		// on the trip.
		await edit(`Changed how long ${name} takes`, (w) => {
			if (placementId) setPlacementMinutes(w, placementId, minutes);
			else if (kind === 'prep') saveMyProfile(w, { prep_min: minutes });
			else
				updateAllowance(
					w,
					tripId,
					kind === 'bags'
						? { bag_drop_min: minutes }
						: kind === 'out'
							? { arrival_buffer_min: minutes }
							: { departure_buffer_min: minutes }
				);
			// This card's day; a trip's or a traveller's own allowance, every day.
			const day = placementId ? placements.find((pl) => pl.id === placementId)?.day_index : undefined;
			retime(w, day === undefined ? undefined : [day]);
		});
	}

	/**
	 * A quick edit from the card: applied where the traveller is looking, and
	 * the day re-timed around it, rather than sending them to another screen
	 * and back to see what it did.
	 */
	async function editCarded(patch: { duration_min?: number; priority?: number; notes?: string | null }) {
		const held = carded;
		if (!held) return;
		// Written into the plan as well, so a longer visit is a longer card the
		// next time the trip is opened rather than only until the page is
		// closed. Nothing moves: every card holds its own clock, and a re-time
		// writes times without rearranging anything. What it takes to fit the
		// new length is Replan's question.
		await edit(`Changed ${held.name}`, (w) => {
			const days = daysOf(held.id);
			updatePoi(w, held.id, patch);
			retime(w, days);
		});
	}

	/**
	 * Take a place off the plan, leaving it on the wishlist.
	 *
	 * Not the same as deleting it: a stop taken out of a day is one the
	 * traveller does not want on that day, and it used to be removed from the
	 * trip altogether -- the place gone from the wishlist too, with nothing
	 * said. Deleting for good is on the place's own page, behind a
	 * confirmation.
	 */
	async function unplace(placementId: string) {
		const name = carded?.name;
		cardedId = null;
		const card = placements.find((pl) => pl.id === placementId);
		const night = card ? nightOf(tripId, card) : null;
		// The hotel a day ends at, or the one the next starts at, is a night:
		// taking it off says the traveller is not sleeping there, so the night
		// is skipped -- both of its cards -- rather than one card deleted.
		if (night !== null) {
			await edit(`Not sleeping at the hotel after ${days[night] ? dayLabel(days[night].date, row!.timezone) : 'that day'}`, (w) => {
				skipNight(w, tripId, night, true);
				retime(w, [night, night + 1].filter((d) => d < days.length));
			});
			return;
		}
		await edit(`Took ${name ?? 'a card'} off the day`, (w) => {
			const day = card?.day_index;
			dropPlacement(w, placementId);
			retime(w, day === undefined ? undefined : [day]);
		});
	}

	/** The days a place is visited on. */
	const daysOf = (poiId: string) => [
		...new Set(placements.filter((pl) => pl.poi_id === poiId).map((pl) => pl.day_index))
	];

	/** Let Replan have every visit to this place back. */
	async function unpin(poiId: string) {
		const name = carded?.name;
		cardedId = null;
		await edit(`Let Replan move ${name ?? 'a place'} again`, (w) => {
			const days = daysOf(poiId);
			for (const pl of placements) if (pl.poi_id === poiId && pl.pinned) holdPlacement(w, pl.id, false);
			retime(w, days);
		});
	}

	let picking = $state(false);

	/**
	 * Keyed by trip id because that is what the storage policy checks, with a
	 * fresh name each time so a cached old picture cannot linger.
	 */
	async function uploadImage(event: Event) {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		picking = true;
		error = null;
		try {
			// A picture has to reach the server before anyone can see it, so this
			// one thing waits for a connection, and says so when there is none.
			if (!navigator.onLine) throw new Error('Adding a picture needs a connection.');
			const ext = file.name.split('.').pop()?.toLowerCase() ?? 'png';
			const url = await upload('trip-images', `${tripId}/${crypto.randomUUID()}.${ext}`, file);
			await edit('Changed the trip’s picture', (w) => setTripImage(w, tripId, url));
		} catch (e) {
			error = (e as Error).message;
		} finally {
			picking = false;
			input.value = '';
		}
	}

	async function clearImage() {
		await edit('Took the trip’s picture off', (w) => setTripImage(w, tripId, null));
	}
	let dayIndex = $state(0);
	let view = $state<'plan' | 'map' | 'wishlist'>('plan');
	let showDetails = $state(false);
	/** The day with its own line drawn behind the cards. */
	let expanded = $state(false);
	let visible = $state(new Set<number>());
	/** Unassigned stops are their own layer on the map, not a day. */
	let showUnassigned = $state(true);
	let seeded = false;
	const shareUrl = $derived(row?.share_token ? linkFor(row.share_token) : null);
	let copied = $state(false);
	const bbox = $derived(row ? cityBBox(row) : null);
	const people = $derived(tripProfiles(tripId));

	/** What the traveller has typed to find a place in a long wishlist. */
	let hunt = $state('');

	/**
	 * Gaps the traveller has opened, by the stop each one follows.
	 *
	 * Holding a card opens every one of them: the whole point of picking a card
	 * up is to put it somewhere else, and a day that stays shut gives it
	 * nowhere to land.
	 */
	let opened = $state(new Set<string>());
	const gapOpen = (key: string) => !!drag.state.id || opened.has(key);

	function toggleGap(key: string) {
		const next = new Set(opened);
		if (!next.delete(key)) next.add(key);
		opened = next;
	}

	/**
	 * The wishlist, narrowed to what was typed.
	 *
	 * Name, category and the traveller's own notes: a place is as often
	 * remembered by "the one near the station" as by what it is called.
	 */
	const shortlist = $derived.by(() => {
		const needle = hunt.trim().toLowerCase();
		if (!needle) return pois;
		return pois.filter((p) =>
			[p.name, p.category, p.notes].some((field) => field?.toLowerCase().includes(needle))
		);
	});
	/** A share link is a look at the trip. Editing is given by the owner, and
	    the policies enforce it -- so a control that writes is shown to whoever
	    may write and to nobody else. */
	const canEdit = $derived(
		isOwner || people.find((p) => p.userId === session.user?.id)?.role === 'editor'
	);

	let curves = $state<CrowdCurves | undefined>(undefined);
	let travel = $state<TravelTable | undefined>(undefined);

	/** The plan of record, as Regenerate last wrote it. */
	const stored = $derived(loadPlan(tripId));
	/** What the traveller has said about particular meals. */
	const planAt = $derived(row?.plan_generated_at ?? null);
	/**
	 * The plan as stored, which is the plan on screen -- built once here for
	 * every view that draws it.
	 *
	 * Real journey times arrive after the fact: the server routes the legs the
	 * plan guessed at and writes each answer onto its stop, and the screen
	 * shows them as they land. The clocks are not re-walked here on each one.
	 * That re-ran the whole trip through the planner for every leg that came
	 * back, and a Replan on a real trip froze the phone while they did; the
	 * clocks take the better figures at the next edit.
	 */
	const drawn = $derived.by(() => toPlannedDays(stored, days));

	/**
	 * Put the usual furniture on a day nobody has furnished yet.
	 *
	 * Every day starts where the traveller slept, spends half an hour getting
	 * out of the door, and ends back at the hotel -- so that is what a new day
	 * is given. From then on the day is theirs: these are placements, so they
	 * drag, they come off, and more can be added. Nothing here ever runs over
	 * a day again, which is what stops a hotel the traveller removed quietly
	 * reappearing.
	 */
	function furnish() {
		if (!row || !days.length || days.length <= row.furnished_days) return;
		const first = row.furnished_days;
		const wanted: Parameters<typeof placeMany>[1] = [];
		for (let i = first; i < days.length; i++) {
			const last = i === days.length - 1;
			const { start, end } = days[i];
			if (i === 0 && row.arrival_point_name) {
				// Arriving at the hotel and handing over the bags are one thing,
				// and it is called checking in. It happens when the day starts,
				// which on the first day is when the journey in has finished.
				wanted.push({
					kind: 'hotel',
					name: 'Check-In',
					minutes: row.bag_drop_min,
					dayIndex: i,
					at: start.toISOString()
				});
			} else {
				wanted.push({ kind: 'hotel', minutes: 0, dayIndex: i, at: start.toISOString() });
				// A minute later, because two cards at the same instant have no
				// order to be in: waking up and getting ready are one after the
				// other, and the clock has to say so.
				wanted.push({
					kind: 'chore',
					name: 'Getting ready',
					dayIndex: i,
					at: new Date(start.getTime() + 60_000).toISOString()
				});
			}
			// The end of the day is the hotel it is slept in -- that is what
			// ends a day. The last one ends at the station instead.
			if (last && row.departure_point_name) {
				// Checking out is done before the day is over, not at the end of
				// it: the day ends when the traveller has to leave for the
				// station, and standing at the desk then means missing it.
				wanted.push({
					kind: 'chore',
					name: 'Check-out',
					dayIndex: i,
					at: new Date(end.getTime() - row.bag_drop_min * 60_000).toISOString()
				});
			} else {
				wanted.push({ kind: 'hotel', minutes: 0, dayIndex: i, at: end.toISOString() });
			}
		}
		const days_ = days.length;
		void edit('Set out the days', (w) => {
			placeMany(w, wanted, tripId);
			setFurnished(w, tripId, days_);
		});
	}

	// Kept current while it is open: read once from the server, then every
	// change to it as it happens.
	onMount(() => watchTrip(tripId));
	onMount(() => watching(tripId));

	onMount(() => {
		// Coming back from adding into a slot: open on the day it landed on.
		const asked = Number(page.url.searchParams.get('day'));
		if (Number.isInteger(asked) && asked >= 0) dayIndex = asked;
	});

	/**
	 * Furniture for days nobody has furnished, once per opening. Only by
	 * someone who may edit the trip: a viewer's edit would only be refused.
	 */
	let furnished = false;
	$effect(() => {
		if (furnished || !row || !days.length || !canEdit) return;
		furnished = true;
		untrack(furnish);
	});

	/**
	 * Trips saved before the city box -- and before the country code -- was
	 * captured. One geocode fills in whichever is missing, behind the screen
	 * rather than in front of it.
	 */
	let located = false;
	$effect(() => {
		if (located || !row || !canEdit || (bbox && row.country_code)) return;
		located = true;
		const found = row;
		void provider.searchCities(found.city).then((matches) => {
			const match = matches[0];
			if (!match || ((!match.bbox || bbox) && (!match.countryCode || found.country_code))) return;
			void edit('Found the city on the map', (w) => {
				if (match.bbox && !bbox) updateCityBBox(w, tripId, match.bbox);
				if (match.countryCode && !found.country_code) updateCountryCode(w, tripId, match.countryCode);
			});
		}).catch(() => {});
	});

	function linkFor(token: string) {
		return `${window.location.origin}${base}/shared/${token}`;
	}

	/** The latest anyone on this trip is out of the door. */
	const ready = $derived(latestReady(people.map((p) => ({ wakeAt: p.wakeAt, prepMin: p.prepMin }))));

	/** Whoever is ready last, and their own hours -- wake time and prep. */
	const prep = $derived(latestPrep(people.map((p) => ({ wakeAt: p.wakeAt, prepMin: p.prepMin }))));

	const days = $derived<Day[]>(
		row
			? tripDays({
					...toTrip(row),
					// The day opens when the party wakes, not when they are dressed:
					// getting ready is a card on the plan that spends the half hour,
					// rather than half an hour the plan never mentions.
					dayStart: effectiveDayStart(toTrip(row).dayStart, prep?.wakeAt ?? null),
					prep
				})
			: []
	);

	/**
	 * Busyness is resolved here, before the planner runs, and handed in as a
	 * plain table. The planner stays synchronous because it re-runs on every
	 * drag and hundreds of times inside 2-opt.
	 */
	async function refreshCurves() {
		if (!row || !days.length) return;
		curves = await resolveCurves(
			pois.map((p) => ({ id: p.id, category: p.category })),
			days,
			row.timezone
		);
	}

	/**
	 * Real travel times for every pair the planner might consider -- including
	 * the hotel and any terminals, since the airport transfer is the leg the
	 * straight-line model got most wrong.
	 */
	/**
	 * Real travel times, resolved one day at a time.
	 *
	 * Per day rather than per trip for two reasons: a transit matrix is capped
	 * at 100 elements and a day of stops plus anchors fits inside that, and a
	 * transit answer needs the departure time, which is a property of the day.
	 */
	/**
	 * Every point a day's journeys run between: the tickets at either end, and
	 * every card on the day where it is -- the hotel, a meal at its place, both
	 * ends of a stop you leave from somewhere else. What the router is asked
	 * about is what the walk will travel between.
	 */
	function dayPoints(i: number): LatLng[] {
		const day = days[i];
		if (!day) return [];
		const anchors = [...day.fixedStart, ...day.fixedEnd].map((w) => w.at);
		const cards = placements
			.filter((pl) => pl.day_index === i && !pl.skipped)
			.map((pl) => visitOf(pl, null))
			.filter((v): v is PlanPoi => !!v)
			.flatMap((v) => (v.exitAt ? [{ lat: v.lat, lng: v.lng }, v.exitAt] : [{ lat: v.lat, lng: v.lng }]));
		const seen = new Set<string>();
		return [...anchors, ...cards].filter((p) => {
			const key = `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
	}

	async function refreshTravel() {
		if (!row || !days.length) return;
		const modes = row.allowed_modes as Mode[];
		const perDay = days.map((day, i) => ({ points: dayPoints(i), departAt: day.start.toISOString() }));

		// One day's matrix does not depend on another's, so they go out
		// together rather than one trip's worth of round trips in a row.
		const resolved = await pool(
			perDay.filter((d) => d.points.length >= 2),
			4,
			(d) => resolveTravel(d.points, modes, d.departAt)
		);
		const tables: TravelTable[] = [...resolved];

		// Stops not yet on a day have no departure time to ask about, so they
		// resolve without one and fall back to the estimate where that fails.
		// Places with no visit yet: they have no departure time to ask about, so
		// they resolve without one and fall back to the estimate where that
		// fails.
		const onTheTrip = new Set(placements.map((pl) => pl.poi_id));
		const loose = pois
			.filter((p) => !onTheTrip.has(p.id))
			.map((p) => ({ lat: p.lat, lng: p.lng }));
		if (loose.length && days[0]) {
			const anchor = days[0].fixedStart[0]?.at;
			const points = anchor ? [anchor, ...loose] : loose;
			if (points.length >= 2) tables.push(await resolveTravel(points, modes, null));
		}

		travel = tables.length ? firstOf(tables) : undefined;
	}

	/*
	 * Busyness only. Travel used to be resolved here too, and that was the
	 * expensive mistake: an $effect subscribes to every signal read while it
	 * runs, including inside the functions it calls, up to the first await --
	 * and refreshTravel reads day_index, lat, lng and the exit of every stop
	 * before it awaits anything. `void pois.length` narrowed nothing. Every
	 * drag, pin and edit re-ran it, and each run was a paid matrix per day per
	 * mode. Curves are computed on the device and cost nothing, so they can
	 * stay. Travel is resolved where it is actually needed: when Replan is
	 * about to order the days.
	 */
	$effect(() => {
		void pois.length;
		void days.length;
		// Untracked: refreshCurves reads the whole wishlist and every day
		// before it awaits, and tracked that re-ran it on every change to any
		// of them -- which is every change at all.
		untrack(refreshCurves);
	});

	$effect(() => {
		if (!seeded && days.length) {
			visible = new Set(days.map((_, i) => i));
			seeded = true;
		}
	});

	/**
	 * The window that suits everyone on the trip. With one traveller this is
	 * simply their own preference; with collaborators it is the overlap, so a
	 * restaurant is never booked for a time that suits only half the party.
	 */
	const agreed = $derived(tightest(people.map((p) => p.mealWindows)));

	/**
	 * Why a wishlist stop is not on the plan. Derived rather than stored: a
	 * stop with no day is either newer than the plan or was left out by it,
	 * and the trip itself answers the other two cases.
	 */
	const reasonFor = (p: PoiRow): UnplacedReason => {
		if (row && hotelMissing(row)) return 'hotel-unknown';
		if (!days.some((d) => d.usableMin > 0)) return 'no-usable-days';
		if (!planAt || Date.parse(p.created_at) > Date.parse(planAt)) return 'not-planned-yet';
		return 'day-full';
	};

	/**
	 * Anything the plan does not contain, whatever its day column says. Reading
	 * the column alone hid a stop that had been given a day and then dropped by
	 * the scheduler: it showed on no day and on no list.
	 */
	const planned = $derived(
		new Set(drawn.flatMap((d) => d.stops.map((s) => s.poiId)))
	);

	const unplaced = $derived<Unplaced[]>(
		pois
			.filter((p) => !planned.has(p.id))
			.map((p) => ({ poi: draftVisit(p), reason: reasonFor(p) }))
	);

	/**
	 * The plan on screen is the plan that was stored, not one re-derived on
	 * load. Re-running the scheduler here would silently re-time a settled trip
	 * whenever a provider answered differently or the page was opened on
	 * another day.
	 */
	const result = $derived<PlanResult | null>(
		row && days.length
			? { days: drawn, unplaced }
			: null
	);

	/** How far the plan is behind the wishlist. */
	const stale = $derived(planAt ? staleCount(pois, planAt) : 0);

	const current = $derived(result?.days[dayIndex] ?? null);

	/** poi id -> the day it sits on, for colouring the wishlist and the map. */
	const dayOf = $derived(
		new Map<string, number>(
			(result?.days ?? []).flatMap((d) =>
				d.stops.filter((s) => s.poiId).map((s) => [s.poiId!, d.index] as [string, number])
			)
		)
	);
	const reasonOf = $derived(
		new Map<string, UnplacedReason>(
			(result?.unplaced ?? []).map((u) => [u.poi.id, u.reason] as [string, UnplacedReason])
		)
	);

	const dayColor = (i: number) => `var(--tm-day-${Math.min(i + 1, 8)})`;
	const colorOf = (id: string) =>
		dayOf.has(id) ? dayColor(dayOf.get(id)!) : 'var(--tm-day-none)';

	function toggleDay(i: number) {
		const next = new Set(visible);
		if (next.has(i)) next.delete(i);
		else next.add(i);
		visible = next;
	}

	/**
	 * When a drop happened.
	 *
	 * A drop says when, and that is the whole of what it says. A day is its
	 * cards in the order their clocks read, so putting a card somewhere is
	 * setting its clock -- there is no position to write and nothing else to
	 * reconcile. Let go in an opened gap, it happens at the moment the gap was
	 * opened at; let go between two cards, halfway between them, which is a
	 * minute both of them leave free; let go on the day itself, after the last
	 * thing the day does and before the hotel it is slept in.
	 */
	function momentOf(target: DropTarget, draggedId: string): string | null {
		if (!target) return null;
		const minute = (ms: number) => new Date(Math.round(ms / 60_000) * 60_000).toISOString();
		// Read off the rail: exactly the minute the line shows at the finger.
		// Whatever starts then or later is pushed down below it (pushDown), so
		// two cards are never left at the same minute.
		if (target.at) return minute(Date.parse(target.at));
		// A day's tab has no rail: the card is added at the end of that day's
		// activities -- when the last of them is over, before the hotel the day
		// is slept in, which is pushed down to make room.
		const cards = (result?.days[target.day]?.stops ?? []).filter((st) => st.placementId !== draggedId);
		let index = cards.length;
		while (index > 0 && cards[index - 1].anchor) index--;
		const last = cards[index - 1];
		return minute((last?.depart ?? days[target.day]?.start ?? new Date()).getTime());
	}

	/**
	 * The minute between two cards, or beyond the one card there is.
	 *
	 * Halfway into the space beside it: the gap where there is one, and
	 * otherwise between the two clocks themselves, which always leaves the
	 * card between the pair it was put between.
	 */
	function spaceAt(cards: PlannedStop[], index: number, day: number): string {
		const prev = cards[index - 1];
		const next = cards[index];
		if (prev && next) {
			const from = prev.depart < next.arrive ? prev.depart : prev.arrive;
			return between(from, next.arrive);
		}
		// Beyond the one card there is, wherever that falls: the day's window is
		// the automatic plan's to respect, and a card put by hand goes where
		// the traveller put it.
		if (prev) return new Date(prev.depart.getTime() + 15 * 60_000).toISOString();
		if (next) return new Date(next.arrive.getTime() - 60 * 60_000).toISOString();
		return (days[day]?.start ?? new Date()).toISOString();
	}

	/**
	 * When a card added from a slot happens.
	 *
	 * Tapped in an opened gap, the gap is drawn to scale and the tap said a
	 * time: that is the answer. Tapped on the slot above a card, it happens in
	 * the space before that card. With nothing named, it happens after the
	 * last thing the day does and before the hotel it is slept in.
	 */
	function momentFor(target: { day: number; before: string | null; at?: string | null }): string {
		if (target.at) return target.at;
		const cards = result?.days[target.day]?.stops ?? [];
		let index = target.before
			? cards.findIndex((st) => st.poiId === target.before || st.placementId === target.before)
			: -1;
		if (index < 0) {
			index = cards.length;
			while (index > 0 && cards[index - 1].anchor) index--;
		}
		return spaceAt(cards, index, target.day);
	}


	/**
	 * A manual move runs steps 3-5 only -- the traveller has just stated the
	 * assignment and the order, and re-clustering would undo the drag.
	 */
	async function applyMove(draggedId: string, target: DropTarget) {
		track('drag.drop', {
			dragged: draggedId,
			day: target?.day ?? null,
			at: target?.at ?? null
		});
		if (draggedId.startsWith(SLOT_DRAG)) return moveSlot(draggedId, target);

		if (!target) return;
		const day = target.day;
		const when = dropMoment(draggedId, target);
		if (when === null) return;

		// Its old card time is where it used to be, and it is not there any
		// more: the walk about to run decides how the day reads around it.
		justMoved = draggedId;
		// Follow the stop to its new day. Without this it simply vanishes from
		// the day on screen and the move looks like a deletion.
		dayIndex = day;

		// The move and the day re-timed around it, as one edit: the card lands
		// under the finger, walked on the travel times already in hand. Real
		// road times come afterwards, and may shift the day by a few minutes.
		// The day it left and the day it went to: nothing else changed.
		const from = placements.find((pl) => pl.id === draggedId)?.day_index ?? day;
		await edit(`Moved ${nameOf(draggedId) || 'a card'}`, (w) => {
			moveTo(w, draggedId, when, day);
			pushDown(w, draggedId, when, day);
			retime(w, [...new Set([from, day])]);
		});
		// It has a card of its own again, so it is held to that from here.
		justMoved = null;
	}

	/**
	 * Make room below a card that has just been put somewhere.
	 *
	 * A drop sets when the card starts; it ends its own length later. What is
	 * below it on the day and now starts before it ends is pushed down to
	 * start when it ends, and so on down the day, each by only as much as it
	 * has to: the traveller put this card here, and the day gives way.
	 */
	function pushDown(w: Writer, movedId: string, when: string, day: number) {
		// Everything read before the first move: each move changes what the
		// trip reads as.
		const length = (pl: PlacementRow) => (visitOf(pl, null)?.durationMin ?? 0) * 60_000;
		const moved = placements.find((pl) => pl.id === movedId);
		if (!moved) return;
		let end = Date.parse(when) + length(moved);
		const below = placements
			.filter((pl) => pl.day_index === day && pl.id !== movedId && Date.parse(pl.at) >= Date.parse(when))
			.sort((a, b) => a.at.localeCompare(b.at))
			.map((pl) => ({ id: pl.id, at: Date.parse(pl.at), length: length(pl) }));
		for (const pl of below) {
			const start = Math.max(pl.at, end);
			if (start !== pl.at) moveTo(w, pl.id, new Date(start).toISOString());
			end = start + pl.length;
		}
	}

	/**
	 * A meal container is dragged as itself, not as whatever fills it: moving
	 * a slot is moving the meal, and the place inside comes with it.
	 *
	 * It cannot be reordered the way a stop is -- it owns no row in the
	 * wishlist and its whole position is the hour it is told to sit at. So a
	 * drop takes the moment of whatever it landed on. A slot is keyed by its
	 * day and its meal, and a day has one lunch, so it stays on its own day.
	 */
	async function moveSlot(draggedId: string, target: DropTarget) {
		if (!target) return;
		const [, rawDay, meal] = draggedId.split(':');
		const day = Number(rawDay);
		// Dropped in a gap, it happens at the moment it was let go; dropped on a
		// stop, at that stop's moment. A meal is a stop like any other and lands
		// where it was put.
		// Let go in an opened gap it happens at the moment it was let go; let go
		// on a card it happens when that card does. A meal is a stop like any
		// other and lands where it was put.
		const at = dropMoment(draggedId, target);
		if (!at) return;
		await sayMeal(day, meal as MealName, { at });
	}

	/**
	 * The moment a held card would be put at, if it were let go here.
	 *
	 * One function for both: the hour on the card under the finger and the
	 * hour the drop writes are the same number, so what the traveller sees
	 * while holding is what they get.
	 */
	function dropMoment(draggedId: string, target: DropTarget): string | null {
		if (!target) return null;
		if (!draggedId.startsWith(SLOT_DRAG)) return momentOf(target, draggedId);
		// A meal container stays on its own day, and happens at the moment on
		// the rail where it was let go.
		const day = Number(draggedId.split(':')[1]);
		if (target.day !== day || !target.at) return null;
		return new Date(Math.round(Date.parse(target.at) / 60_000) * 60_000).toISOString();
	}

	/** Where the held card would go: the moment, and the day it is on. */
	const held = $derived.by(() => {
		const id = drag.state.id;
		const target = drag.state.target;
		if (!id || !target) return null;
		const at = dropMoment(id, target);
		return at ? { at: new Date(at), day: target.day } : null;
	});

	/** What a card is called, by the id it is dragged by: its place, its meal, or its own name. */
	function nameOf(id: string): string {
		if (id.startsWith(SLOT_DRAG)) return MEAL_LABEL[id.split(':')[2] as MealName];
		for (const d of result?.days ?? []) {
			const card = d.stops.find((st) => st.placementId === id);
			if (card) return card.name;
		}
		return '';
	}

	const heldName = $derived.by(() => (drag.state.id ? nameOf(drag.state.id) : ''));



	/**
	 * Everything known about how long journeys take, best first.
	 *
	 * The stored plan comes first: a leg it has already had routed is a real
	 * answer for a real journey, and survives the cards being moved about --
	 * the scheduler asks by where it is going, not by which stop it is timing.
	 * The matrix behind it is an estimate, and the speed model behind that.
	 */
	const known = () => {
		const tables = [tableFromPlan(stored), ...(travel ? [travel] : [])];
		return firstOf(tables);
	};

	/**
	 * When each stop currently happens, from the card on the plan.
	 *
	 * This is where a stop's time lives. A pin says Replan may not move it; the
	 * card says what it may not be moved from.
	 */
	const cardAt = $derived.by(() => {
		const at = new Map<string, string>();
		for (const day of drawn) {
			// Keyed by the visit, not the place: two coffees at the same cafe
			// are two cards with two times, and keying by what they are of
			// would hold both to whichever was written last.
			for (const st of day.stops) if (st.placementId) at.set(st.placementId, st.arrive.toISOString());
		}
		return at;
	});

	/**
	 * A stop the traveller has just dragged, whose card time is the one it had
	 * before the drag and so must not be held to.
	 */
	let justMoved = $state<string | null>(null);

	/** The trip as the scheduler wants it told. */
	function planInput() {
		if (!row || !days.length) return null;
		return {
			pois: placements
				.map((pl) => {
					// The card just put somewhere starts at the hour it was put at:
					// held there for this walk, as a pin would hold it.
					if (pl.id === justMoved) {
						const v = visitOf(pl, pl.at);
						return v && { ...v, pinned: true, pinnedAt: pl.at };
					}
					return visitOf(pl, cardAt.get(pl.id) ?? null);
				})
				.filter((v): v is NonNullable<typeof v> => !!v),
			days,
			allowedModes: row.allowed_modes as Mode[],
			timezone: row.timezone,
			mealWindows: agreed.windows,
			curves,
			// Where the day sleeps. A day ends at the hotel, and when there is
			// none on it Replan puts one there rather than leaving the evening
			// to trail off.
			hotel: { name: row.hotel_name, lat: row.hotel_lat, lng: row.hotel_lng }
		};
	}

	/**
	 * Re-time the plan, inside the edit that called for it -- steps 3-5 only,
	 * since the traveller has just stated the assignment and the order. The
	 * stored plan is the plan of record, so it is written back too, or the
	 * change would survive only until the page is next opened.
	 */
	/**
	 * Real journey times, worked out after an edit rather than during it.
	 *
	 * An edit is re-timed at once on the phone's own estimate, so a card lands
	 * where it was put without waiting on anything. The days it touched are
	 * then asked of the router, and when the answers are in, the day is walked
	 * again on them: a longer journey pushes the cards after it later, and a
	 * pin that would be pushed stays and the card before it says so. Applied
	 * as its own edit, only if a time actually changes, and never while a card
	 * is in the air -- it waits for the finger to let go.
	 */
	const toRoute = new Set<number>();
	let routing: ReturnType<typeof setTimeout> | null = null;
	/** Set while the routed times are being written, so writing them does not ask again. */
	let applyingRoutes = false;

	function routeSoon(which: number[]) {
		if (applyingRoutes) return;
		for (const d of which) toRoute.add(d);
		if (routing) clearTimeout(routing);
		routing = setTimeout(routeDays, 800);
	}

	async function routeDays() {
		routing = null;
		if (!row || !navigator.onLine || !toRoute.size) return;
		if (drag.state.id || busy) {
			routing = setTimeout(routeDays, 1000);
			return;
		}
		const which = [...toRoute];
		toRoute.clear();
		const modes = row.allowed_modes as Mode[];
		const tables = await pool(which, 2, (i) => {
			const points = dayPoints(i);
			return points.length >= 2
				? resolveTravel(points, modes, days[i]?.start.toISOString() ?? null)
				: Promise.resolve(noTravel);
		});
		travel = firstOf([...tables, ...(travel ? [travel] : [])]);
		// The finger may have come down while the router was answering.
		while (drag.state.id || busy) await new Promise((r) => setTimeout(r, 300));
		const input = planInput();
		if (!input) return;
		const next = schedule({ ...input, travel: known() }, new Set(which));
		const moved = next.days.some((d) =>
			d.stops.some((st) => {
				const now = drawn[d.index]?.stops.find((x) => (st.placementId ? x.placementId === st.placementId : x.name === st.name));
				return (
					!now ||
					now.arrive.getTime() !== st.arrive.getTime() ||
					(now.legIn?.minutes ?? 0) !== (st.legIn?.minutes ?? 0) ||
					(now.legIn?.source ?? null) !== (st.legIn?.source ?? null)
				);
			})
		);
		if (!moved) return;
		applyingRoutes = true;
		try {
			await edit('Worked out the journeys', (w) => retime(w, which));
		} finally {
			applyingRoutes = false;
		}
	}

	function retime(w: Writer, days?: number[]) {
		const input = planInput();
		if (!input) return;
		// Only the days the edit touched, when it says which: the rest of the
		// trip did not change, and walking, saving and sending it again is
		// what made every edit cost as much as the whole trip.
		const next = schedule({ ...input, travel: known() }, days ? new Set(days) : undefined);
		savePlan(w, tripId, next, stored, days);
		// And then, off the finger's path, the real journeys for these days.
		routeSoon(next.days.map((d) => d.index));

		// A longer journey is a later afternoon.
		//
		// A leg is movement, and movement takes time: when a routed leg comes
		// back longer than the estimate the day was built on, the cards after
		// it happen later, and later is now what their clocks say. Only the
		// ones the walk moved are written -- a pinned card and the day's own
		// furniture stay at the minute the traveller gave them, so there is
		// nothing to write for those.
		//
		// Nothing is taken off the plan here. A visit the walk could not seat
		// was still put on that day by the traveller, and deleting it because
		// the planner had an opinion is how a restaurant dragged into a free
		// hour went back to the wishlist with nothing said. Re-timing writes
		// times; it does not decide what is on the trip.
		// Read once, before any of the moves below: each one changes what the
		// trip reads as, and reading it again after each would lay it again.
		const before = new Map(placements.map((pl) => [pl.id, pl]));
		for (const d of next.days) {
			for (const st of d.stops) {
				if (!st.placementId) continue;
				const was = before.get(st.placementId);
				if (was && Date.parse(was.at) !== st.arrive.getTime()) moveTo(w, was.id, st.arrive.toISOString());
			}
		}
	}

	/** What a meal container is called while it is being dragged. */
	const SLOT_DRAG = 'meal:';

	const drag = createDrag(
		(id, target) => applyMove(id, target),
		() => ruler
	);

	/**
	 * The day on screen as a ruler, read off its own cards: a card's top is
	 * its start and its bottom its end (see measure). Measured whenever the
	 * rails show -- once the layout has settled, which takes two frames when a
	 * held card has just opened the day up -- and again when the day, the
	 * gaps or the window change.
	 */
	let railsEl = $state<HTMLElement | null>(null);
	let ruler = $state<Ruler | null>(null);
	$effect(() => {
		const el = railsEl;
		const on = expanded || !!drag.state.id;
		void drawn;
		void dayIndex;
		void opened;
		if (!el || !on) {
			ruler = null;
			return;
		}
		let frame = requestAnimationFrame(() => (frame = requestAnimationFrame(() => (ruler = measure(el)))));
		const watch = new ResizeObserver(() => (ruler = measure(el)));
		watch.observe(el);
		return () => {
			cancelAnimationFrame(frame);
			watch.disconnect();
		};
	});
	/** Where a moment sits on the day on screen's rail, as a percentage. */
	const railPlace = $derived(ruler ? (ms: number) => placeOf(ruler!, ms) * 100 : null);



	/**
	 * A stop that has a day but no place in the stored plan -- added into a slot
	 * on the last screen. Re-time once so it appears where it was put, without
	 * making the traveller tap Replan for a stop they have already placed.
	 */
	let retimed = false;
	$effect(() => {
		if (retimed || busy || !row || !days.length || !stored.length || !canEdit) return;

		// A plan made by an older planner. Asking the traveller to tap Replan
		// because the app changed underneath them is the app's problem.
		const stale = (row.plan_version ?? 0) < PLANNER_VERSION;

		const inPlan = new Set(stored.map((r) => r.placement_id).filter(Boolean));
		// A skipped meal is never in the plan: that is what skipping it means.
		const placedButUnplanned = placements.some((pl) => !pl.skipped && !inPlan.has(pl.id));
		// A card whose visit is gone -- the place was removed from its own page.
		const visits = new Set(placements.map((pl) => pl.id));
		const plannedButGone = stored.some((r) => r.placement_id && !visits.has(r.placement_id));

		if (!stale && !placedButUnplanned && !plannedButGone) return;
		retimed = true;
		untrack(() => void edit('Re-timed the days', (w) => retime(w)));
	});

	/** The put-aside edit whose sheet is open. */
	let conflict = $state<Mutation | null>(null);

	/** The put-aside edit a card on the plan is waiting on, if any. */
	function conflictOf(stop: PlannedStop, dayIdx: number): Mutation | null {
		if (stop.placementId) {
			const own = asideFor('placements', { id: stop.placementId });
			if (own) return own;
		}
		if (stop.poiId) {
			const place = asideFor('pois', { id: stop.poiId });
			if (place) return place;
		}
		return null;
	}

	/** What a put-aside edit would change, in words the traveller uses. */
	const explainIt = (m: Mutation) =>
		explain(m, {
			timezone: row?.timezone ?? 'UTC',
			dayName: (i) => (days[i] && row ? dayLabel(days[i].date, row.timezone) : `day ${i + 1}`),
			placeName: (id) => poiById.get(id)?.name ?? null,
			personName: (id) => {
				const person = people.find((p) => p.userId === id);
				return person ? displayName(person) : 'a traveller';
			}
		});

	async function settle(m: Mutation, keep: 'mine' | 'theirs') {
		conflict = null;
		try {
			if (keep === 'theirs') return await reject(m);
			// The change, and the day re-timed around it, as one edit.
			await accept(m, canEdit ? (w) => retime(w) : undefined);
		} catch (e) {
			error = (e as Error).message;
		}
	}

	/**
	 * Open the card for a visit, or for a place off the wishlist.
	 *
	 * Takes either id: a card on the plan is a visit, a row in the wishlist is
	 * a place, and both open the same card. What differs is whether there is a
	 * visit to take off the plan.
	 */
	function openCard(id: string) {
		const visit = placements.find((pl) => pl.id === id);
		cardedVisit = visit?.id ?? null;
		const poiId = visit?.poi_id ?? id;
		// A card in conflict opens the conflict: what it shows is upstream, and
		// the question in front of the traveller is whether to keep theirs.
		const waiting = asideFor('placements', { id }) ?? asideFor('pois', { id: poiId });
		if (waiting) {
			conflict = waiting;
			return;
		}
		cardedId = pois.some((p) => p.id === poiId) ? poiId : null;
	}

	/** Hold this visit where it is, or let Replan have it back. */
	async function togglePin(placementId: string) {
		const current = placements.find((pl) => pl.id === placementId);
		if (!current) return;
		const next = !current.pinned;
		await edit(next ? 'Held a card where it is' : 'Let Replan move a card again', (w) =>
			holdPlacement(w, placementId, next)
		);
	}

	/**
	 * A trip stored against the wrong zone. The commonest cause is the one this
	 * app used to have: the timezone defaulted to the traveller's own, so a
	 * London trip booked from Rome ran an hour out on every time in it.
	 */
	const zoneShouldBe = $derived(row ? zoneAt(row.hotel_lat, row.hotel_lng) : null);
	const zoneWrong = $derived(
		!!row && !!zoneShouldBe && zoneShouldBe !== row.timezone && !hotelMissing(row)
	);

	async function fixZone() {
		const was = row;
		if (!was || !zoneShouldBe) return;
		const zone = zoneShouldBe;
		await edit(`Moved the trip onto ${zone}`, (w) => repairTimezone(w, was, zone));
	}

	/** Visits being held where they are, by placement. */
	const pinnedIds = $derived(new Set(placements.filter((pl) => pl.pinned).map((pl) => pl.id)));

	/** Where an Add tapped below `stop` should land: above whatever follows it. */
	const slotHref = (dayIdx: number, beforeId: string | null) =>
		`${base}/trip/${tripId}/add?day=${dayIdx}` + (beforeId ? `&before=${beforeId}` : '');

	/**
	 * The slot the traveller tapped, while they choose what goes in it. Most of
	 * the time the place is already on the wishlist waiting for a day, so
	 * searching for it again is the wrong first offer.
	 */
	/**
	 * Where something is being added: which day, above which stop, and -- when
	 * it came from an opened gap -- at what time.
	 */
	let slot = $state<{ day: number; before: string | null; meal?: string; at?: string } | null>(
		null
	);
	/** Narrows the wishlist inside the slot sheet. */
	let slotQuery = $state('');

	/** Which day a place currently sits on, for the ones that sit on one. */
	const dayOfPoi = $derived(
		new Map(
			drawn.flatMap((d) =>
				d.stops.filter((st) => st.poiId).map((st) => [st.poiId!, d.index] as [string, number])
			)
		)
	);

	/**
	 * Everything on the wishlist, not only what has no day yet.
	 *
	 * Offering only the unplanned meant a place already sitting on Thursday
	 * could not be moved to Tuesday from the slot that wanted it -- the
	 * traveller could see it on the plan and not pick it. Waiting places come
	 * first, then, for a meal slot, the ones you could actually eat at.
	 */
	/**
	 * Where the day has the traveller just before the slot being filled, so a
	 * choice can say how far off the path it is.
	 */
	const slotFrom = $derived.by(() => {
		const here = slot;
		if (!here) return null;
		const day = drawn[here.day];
		if (!day) return null;
		const before = here.before
			? day.stops.findIndex((st) => st.poiId === here.before)
			: day.stops.length;
		for (let i = Math.min(before, day.stops.length) - 1; i >= 0; i--) {
			const st = day.stops[i];
			if (st.at) return st;
		}
		return null;
	});

	const detour = (p: PoiRow) =>
		slotFrom ? haversineKm(slotFrom.at, { lat: p.lat, lng: p.lng }).toFixed(1) : null;

	const unassigned = $derived.by(() => {
		const waiting = (p: PoiRow) => (dayOfPoi.has(p.id) ? 1 : 0);
		const food = (p: PoiRow) => (slot?.meal && isMeal(p.category) ? 0 : 1);
		const q = slotQuery.trim().toLowerCase();
		return [...pois]
			.filter(
				(p) =>
					!q ||
					p.name.toLowerCase().includes(q) ||
					(p.category ?? '').toLowerCase().includes(q)
			)
			.sort((a, b) => waiting(a) - waiting(b) || food(a) - food(b));
	});

	let blockName = $state('');
	let blockMin = $state(60);

	/** A named stretch of time with no place: a rest, an errand, a nap. */
	async function addBlock() {
		const trip = row;
		if (!slot || !trip || !blockName.trim()) return;
		const target = slot;
		const name = blockName.trim();
		const minutes = blockMin;
		slot = null;
		blockName = '';
		await edit(`Added ${name}`, (w) => {
			const created = addPoi(w, tripId, {
				name,
				label: '',
				// The coordinates are a formality: the planner puts a block
				// wherever the traveller already is. The hotel is the honest
				// stand-in for a day that has not started yet.
				lat: trip.hotel_lat,
				lng: trip.hotel_lng,
				category: BLOCK_CATEGORY,
				durationMin: minutes,
				openingHours: null,
				website: null,
				phone: null,
				osmId: null
			});
			placeInto(w, created.id, target);
		});
	}

	/**
	 * Put a piece of the day's own furniture where the slot was tapped.
	 *
	 * The same slot that adds a place: where a card goes is one question, and
	 * what kind of card it is is another.
	 */
	async function addFurniture(kind: 'hotel' | 'chore') {
		const target = slot;
		if (!target || !row) return;
		slot = null;
		dayIndex = target.day;
		// Nothing else on the day moves: the new card takes a free minute and
		// the day reads in the order the clocks say.
		// A day with a night away skipped: the hotel added back is that night
		// coming back -- the one the tap is nearer, morning or evening --
		// rather than an afternoon return beside it.
		if (kind === 'hotel') {
			const span = days[target.day];
			const moment = Date.parse(momentFor(target));
			const early = span ? moment < (span.start.getTime() + span.end.getTime()) / 2 : false;
			const { morning, evening } = nightCards(tripId, target.day);
			const night = early && morning?.skipped && target.day > 0 ? target.day - 1 : evening?.skipped ? target.day : null;
			if (night !== null) {
				await edit('Back at the hotel for the night', (w) => {
					skipNight(w, tripId, night, false);
					retime(w, [night, night + 1].filter((d) => d < days.length));
				});
				return;
			}
		}
		await edit(kind === 'chore' ? 'Added time to yourself' : 'Added a return to the hotel', (w) => {
			placeAnchor(w, tripId, kind, target.day, momentFor(target), {
				name: kind === 'chore' ? 'Time to yourself' : null,
				minutes: kind === 'chore' ? 60 : 0
			});
			retime(w, [target.day]);
		});
	}

	/**
	 * Put a place into the slot.
	 *
	 * One that is already on the plan is copied, not moved. The control says
	 * Add, so it adds: taking Monday's coffee away to give Tuesday one is not
	 * what Add means. Moving is what dragging is for.
	 */
	async function placeHere(poiId: string) {
		if (!slot) return;
		// Filling a meal container is not the same as putting a stop on the
		// day: it says what goes in that meal, and the plan builds round it.
		const meal = slot.meal ? mealOf(slot.meal) : null;
		if (meal) {
			await sayMeal(slot.day, meal, { poiId });
			return;
		}
		const target = slot;
		const source = pois.find((p) => p.id === poiId);
		slot = null;
		if (!source) return;

		await edit(`Added ${source.name}`, (w) => {
			if (!dayOfPoi.has(poiId)) {
				placeInto(w, poiId, target);
				return;
			}
			const copy = addPoi(w, tripId, {
				name: source.name,
				label: '',
				lat: source.lat,
				lng: source.lng,
				category: source.category,
				durationMin: source.duration_min,
				openingHours: source.opening_hours,
				website: source.website,
				phone: source.phone,
				// A second helping of a chain still answers with whichever
				// branch is nearest on the day it is had.
				branches: source.any_branch ? source.branches : undefined,
				// Not the same OSM row twice: a copy is deliberately its own
				// place, and the uniqueness index is there for the first one.
				osmId: null
			});
			placeInto(w, copy.id, target);
		});
	}

	/**
	 * When it happens is the whole of where it goes: the minute it was put at,
	 * or the space above the card it was put before. Nothing else on the day
	 * is touched, and the day is re-timed around it in the same edit.
	 */
	function placeInto(
		w: Writer,
		poiId: string,
		target: { day: number; before: string | null; at?: string; hold?: boolean }
	) {
		place(w, tripId, poiId, target.day, momentFor(target));
		dayIndex = target.day;
		retime(w, [target.day]);
	}

	/**
	 * Everything Replan is allowed to arrange: the visits already decided, and
	 * every wishlist place that has none yet.
	 */
	function everyVisit(): PlanPoi[] {
		const visits = placements
			.map((pl) => visitOf(pl, cardAt.get(pl.id) ?? null))
			.filter((v): v is PlanPoi => !!v);
		const placedPois = new Set(placements.map((pl) => pl.poi_id));
		return [...visits, ...pois.filter((p) => !placedPois.has(p.id)).map(draftVisit)];
	}

	async function doReplan() {
		if (!row || !days.length) return;
		error = null;
		// Replan prices real journeys between the places, and that is the one
		// thing the device cannot do on its own. Everything else works without
		// a connection; this says so rather than planning on guesses.
		if (!navigator.onLine) {
			error = 'Replan needs a connection: it looks up real journeys between your places. Everything else works offline.';
			return;
		}
		busy = true;
		try {
			// The matrix prices every pair the ordering might need. This is the
			// one thing worth paying for up front: which stops share a day, and
			// in what order, cannot be decided on guesses.
			step = 'Measuring…';
			await refreshTravel();

			step = 'Arranging…';
			await edit('Replanned the trip', (w) => {
				// Read now, not before the lookup: a collaborator may have added
				// or removed a place while it ran, and a plan built on the trip as
				// it was would name a place that is gone -- and be refused whole.
				const trip = row;
				if (!trip) return;
				// Replan builds around what is pinned: a pinned card keeps the day
				// and the moment its card says, and everything else is arranged to
				// fit before and after it.
				const input = {
					pois: everyVisit(),
					days,
					allowedModes: trip.allowed_modes as Mode[],
					timezone: trip.timezone,
					mealWindows: agreed.windows,
					curves,
							hotel: { name: trip.hotel_name, lat: trip.hotel_lat, lng: trip.hotel_lng }
				};
				const ordered = replan({ ...input, travel });

				// Written back from Replan itself, not from a re-walk of it. The
				// walk is told about stored visits only, so putting one between
				// Replan and the write threw away every card Replan had just
				// invented -- the sittings a day needed, the hotel it ends at --
				// and the day came back with no lunch in it.
				//
				// A stop carrying a draft id is a place off the wishlist that has
				// just been given a day for the first time, so it needs a row of
				// its own; the rest already have one and only move. Anchors
				// included: they are placements too.
				//
				// A restaurant off the wishlist that Replan seated at a mealtime
				// is that sitting: it becomes the day's meal card for it, holding
				// the place, and its own stop card goes -- one card for lunch,
				// not two. Where the day already has the card, the card takes the
				// place; where it has none, one is made.
				for (const d of ordered.days) {
					for (const st of d.stops) {
						if (!st.placementId) continue;
						const at = st.arrive.toISOString();
						const meal = st.anchorKind === 'meal' && st.poiId ? mealFor(st) : null;
						const card = meal ? mealCard(tripId, d.index, meal) : null;
						if (meal && card?.id !== st.placementId) {
							if (card) w.update('placements', { id: card.id }, { poi_id: st.poiId, skipped: false, at });
							else placeAnchor(w, tripId, 'meal', d.index, at, { meal, poiId: st.poiId });
							if (!st.placementId.startsWith(NEW)) dropPlacement(w, st.placementId);
						} else if (st.placementId.startsWith(NEW)) {
							if (st.poiId) place(w, tripId, st.poiId, d.index, at);
						} else {
							moveTo(w, st.placementId, at, d.index);
						}
					}
				}

				// What Replan drew that nothing had placed yet: a sitting it
				// decided the day needed, and the hotel a day ends at when the
				// traveller has not put one there. They become placements like
				// everything else -- they hold a clock, they drag, they come off.
				placeMany(
					w,
					ordered.days.flatMap((d) =>
						d.stops
							.filter((st) => !st.placementId && (st.anchorKind === 'meal' || st.anchorKind === 'hotel'))
							.map((st) => ({
								kind: st.anchorKind === 'meal' ? ('meal' as const) : ('hotel' as const),
								meal: st.anchorKind === 'meal' ? mealFor(st) : null,
								name: st.anchorKind === 'meal' ? null : st.name,
								minutes: st.durationMin,
								dayIndex: d.index,
								at: st.arrive.toISOString()
							}))
					),
					tripId
				);
				// A visit the day could not reach goes back to the wishlist. A
				// pinned one keeps its day whatever happened, or the traveller
				// would find it gone with no idea why.
				for (const u of ordered.unplaced.filter((x) => !x.poi.pinned && !x.poi.id.startsWith(NEW))) {
					dropPlacement(w, u.poi.id);
				}

				// Walked again, now that every stop is a visit with a row of its
				// own. The first walk was told about places off the wishlist that
				// had never been anywhere, and a card drawn from one of those has
				// no visit to name -- which is not something the stored plan can
				// hold, and not something a later drag could move.
				const settled = schedule({ ...input, pois: everyVisit(), travel: known() });
				savePlan(w, tripId, settled, stored);
				track('plan.replan', {
					days: settled.days.length,
					cards: settled.days.reduce((n, d) => n + d.stops.length, 0),
					unplaced: settled.unplaced.length,
					placements: placements.length,
					wishlist: pois.length
				});
			});
		} catch (e) {
			error = (e as Error).message;
		} finally {
			busy = false;
			step = null;
		}
	}

	/** Mints a link the first time, copies it thereafter. Revoking is separate:
	    a button that shares on one tap and unshares on the next is how people
	    kill a link they meant to send. */
	async function share() {
		if (!row) return;
		try {
			if (!shareUrl) {
				const token = crypto.randomUUID();
				if (!(await edit('Made a link to the trip', (w) => setShareToken(w, tripId, token)))) return;
			}
			await copy();
		} catch (e) {
			error = (e as Error).message;
		}
	}

	/** Which traveller's role is mid-flight, so their two chips go quiet. */
	let roleBusy = $state<string | null>(null);

	async function setRole(person: Profile) {
		if (person.role === 'owner') return;
		roleBusy = person.userId;
		try {
			const next = person.role === 'editor' ? 'viewer' : 'editor';
			await mutate(`Made ${displayName(person)} ${next === 'editor' ? 'an editor' : 'a viewer'}`, tripId, (w) =>
				setMemberRole(w, tripId, person.userId, next)
			);
		} catch (e) {
			error = (e as Error).message;
		} finally {
			roleBusy = null;
		}
	}

	async function dropMember(person: Profile) {
		if (person.role === 'owner') return;
		roleBusy = person.userId;
		try {
			await mutate(`Took ${displayName(person)} off the trip`, tripId, (w) =>
				removeMember(w, tripId, person.userId)
			);
		} catch (e) {
			error = (e as Error).message;
		} finally {
			roleBusy = null;
		}
	}

	async function revoke() {
		await edit('Turned the link off', (w) => setShareToken(w, tripId, null));
	}

	async function copy() {
		if (!shareUrl) return;
		try {
			await navigator.clipboard.writeText(shareUrl);
			copied = true;
			setTimeout(() => (copied = false), 1500);
		} catch {
			// Clipboard needs a user gesture and a secure context; the link is on
			// screen either way, so this is a convenience, not the mechanism.
		}
	}

	async function setHotel(h: { name: string; lat: number; lng: number }) {
		await edit(`Moved the hotel to ${h.name}`, (w) => updateHotel(w, tripId, h));
	}

	const city = $derived<City | null>(
		row ? { name: row.city, label: row.city, lat: 0, lng: 0, countryCode: null, bbox } : null
	);

	const centre = $derived(
		row && !hotelMissing(row)
			? { lat: row.hotel_lat, lng: row.hotel_lng }
			: bbox
				? { lat: (bbox.south + bbox.north) / 2, lng: (bbox.west + bbox.east) / 2 }
				: { lat: 51.5074, lng: -0.1278 }
	);

	const hhmm = (d: Date, tz: string) =>
		formatter(undefined, { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);

	const dayLabel = (iso: string, tz: string) =>
		formatter(undefined, { timeZone: tz, weekday: 'short', day: 'numeric' }).format(
			new Date(`${iso}T12:00:00Z`)
		);

	const stamp = (iso: string, tz: string) =>
		formatter(undefined, {
			timeZone: tz, weekday: 'short', day: 'numeric', month: 'short',
			hour: '2-digit', minute: '2-digit', hour12: false
		}).format(new Date(iso));

	/** The trip's own facts. Booking references only appear once entered. */
	const detailRows = $derived<[string, string][]>(
		row
			? ([
					['City', row.city],
					['Hotel', row.hotel_name],
					['Arrival', stamp(row.arrival_at, row.timezone)],
					describeJourney(row.arrival_legs ?? [])
						? ['Arrival journey', describeJourney(row.arrival_legs)]
						: null,
					row.arrival_booking_ref ? ['Arrival booking', row.arrival_booking_ref] : null,
					['Departure', stamp(row.departure_at, row.timezone)],
					describeJourney(row.departure_legs ?? [])
						? ['Departure journey', describeJourney(row.departure_legs)]
						: null,
					row.departure_booking_ref ? ['Departure booking', row.departure_booking_ref] : null,
					['Timezone', row.timezone],
					['Getting around', (row.allowed_modes ?? []).join(', ')]
				].filter(Boolean) as [string, string][])
			: []
	);

	const MODE_ICON: Record<Mode, string> = {
		walk: 'M11 21l2-6-3-3 1-5 3 3 3 1M10 12l-2 9',
		bike: 'M6 17l5-8h5M14 9l4 8',
		transit: 'M5 11h14M8 20l2-4M16 20l-2-4',
		car: 'M3 13l2-5h14l2 5v4h-3M3 17v-4M6 17h9',
		carshare: 'M3 13l2-5h14l2 5v4h-3M3 17v-4M6 17h9'
	};

	const shownDays = $derived((result?.days ?? []).filter((d) => visible.has(d.index)));

	const markers = $derived([
		...shownDays.flatMap((day) =>
			day.stops.map((s, i) => ({
				id: `${day.index}:${s.poiId ?? `anchor-${i}`}`,
				lat: s.at.lat,
				lng: s.at.lng,
				color: s.anchor ? 'var(--tm-text)' : dayColor(day.index),
				glyph: s.anchor ? 'H' : String(day.stops.slice(0, i).filter((x) => !x.anchor).length + 1)
			}))
		),
		...(showUnassigned
			? pois
					.filter((p) => !dayOf.has(p.id))
					.map((p) => ({
						id: `un:${p.id}`,
						lat: p.lat,
						lng: p.lng,
						color: 'var(--tm-day-none)',
						glyph: '?'
					}))
			: [])
	]);

	/**
	 * Real routed geometry, fetched per visible day. Straight lines are drawn
	 * until it arrives, and stay if it never does: a day that cannot be routed
	 * should still show where its stops are.
	 */
	let shapes = $state<Record<string, { lat: number; lng: number }[]>>({});

	$effect(() => {
		const wanted = shownDays;
		if (view !== 'map' || !row) return;
		for (const day of wanted) {
			const points = day.stops.map((st) => st.at);
			if (points.length < 2) continue;
			// Keyed by the stops themselves, so dragging re-routes and merely
			// toggling a day back on reuses what was already fetched.
			const key = `${day.index}:${points.map((q) => `${q.lat.toFixed(4)},${q.lng.toFixed(4)}`).join('|')}`;
			if (shapes[key]) continue;
			const mode = (day.stops.find((st) => st.legIn)?.legIn?.mode ?? 'walk') as Mode;
			routeShape(points, mode).then((shape) => {
				if (shape) shapes = { ...shapes, [key]: shape };
			});
		}
	});

	const routes = $derived(
		shownDays.map((day) => {
			const points = day.stops.map((st) => st.at);
			const key = `${day.index}:${points.map((q) => `${q.lat.toFixed(4)},${q.lng.toFixed(4)}`).join('|')}`;
			return {
				id: String(day.index),
				points: shapes[key] ?? points,
				color: dayColor(day.index)
			};
		})
	);
</script>

<main class="flex h-dvh flex-col">
	{#if loading && !row}
		<!-- The frame, not a word about loading: the trip is on its way and
		     everything around it is already drawable. -->
		<div class="tm-safe-top p-4">
			<a href="{base}/" class="tm-attrib" style="text-decoration: none">← Trips</a>
		</div>
	{:else if !row}
		<div class="tm-safe-top p-6">
			<a href="{base}/" class="tm-attrib" style="text-decoration: none">← Trips</a>
			<div class="tm-card mt-6" style="background: var(--tm-surface-2)">
				<p class="tm-card__title">Trip not found</p>
				<p class="tm-card__meta">It may have been deleted, or belong to another account.</p>
			</div>
		</div>
	{:else}
		<div class="tm-safe-top flex flex-col gap-3 px-4 pb-3" style="border-bottom: 1px solid var(--tm-border)">
			<div class="flex items-start justify-between gap-2">
				<div>
					<a href="{base}/" class="tm-attrib" style="text-decoration: none">← Trips</a>
					<button
						style="background:none;border:none;padding:0;cursor:pointer;color:inherit;display:flex;align-items:center;gap:8px"
						aria-expanded={showDetails}
						onclick={() => (showDetails = !showDetails)}
					>
						<TripAvatar
							imageUrl={row.image_url}
							countryCode={row.country_code}
							city={row.city}
							size={34}
						/>
						<span style="font: 700 var(--tm-text-xl)/1.15 var(--tm-font)">{row.city}</span>
						<span style="color: var(--tm-text-faint); font-size: 12px">{showDetails ? '▴' : '▾'}</span>
					</button>
				</div>
				<div class="flex gap-2">
					{#if canEdit}
						<button
							class="tm-btn tm-btn--secondary"
							style="min-height:36px"
							onclick={doReplan}
							disabled={busy || !pois.length || hotelMissing(row)}
						>
							{busy ? (step ?? 'Planning…') : 'Replan'}
						</button>
					{/if}
					{#if isOwner}
						<button class="tm-btn tm-btn--primary" style="min-height:36px" onclick={share}>
							{copied ? 'Copied' : shareUrl ? 'Copy link' : 'Share'}
						</button>
					{/if}
				</div>
			</div>

			<!-- Said once, not per stop: the wishlist already marks which stop
			     is which. This only has to answer "is the plan behind". -->
			{#if stale > 0}
				<p class="tm-hint" style="margin-top:-4px">
					{stale} change{stale === 1 ? '' : 's'} since this plan was made.
				</p>
			{/if}

			{#if showDetails}
				<div class="tm-card" style="background: var(--tm-surface-2)">
					<dl class="flex flex-col gap-2">
						{#each detailRows as [label, value]}
							<div class="flex items-baseline justify-between gap-4">
								<dt style="font: 400 var(--tm-text-sm)/1.3 var(--tm-font); color: var(--tm-text-faint); white-space: nowrap">{label}</dt>
								<dd style="font: 500 var(--tm-text-base)/1.3 var(--tm-font); text-align: right">{value}</dd>
							</div>
						{/each}
					</dl>

					<div class="mt-3 flex items-center gap-3" style="border-top: 1px solid var(--tm-border); padding-top: 0.75rem">
						<TripAvatar
							imageUrl={row.image_url}
							countryCode={row.country_code}
							city={row.city}
							size={48}
						/>
						{#if isOwner}
							<div class="flex flex-wrap items-center gap-2">
								<label class="tm-btn tm-btn--secondary" style="min-height:34px;cursor:pointer">
									{picking ? 'Uploading…' : row.image_url ? 'Change picture' : 'Add a picture'}
									<input
										type="file"
										accept="image/png,image/jpeg,image/webp,image/gif"
										onchange={uploadImage}
										disabled={picking}
										style="position:absolute;width:1px;height:1px;opacity:0;pointer-events:none"
									/>
								</label>
								{#if row.image_url}
									<button
										class="tm-btn tm-btn--ghost"
										style="min-height:34px"
										onclick={clearImage}
									>
										Use the flag
									</button>
								{/if}
							</div>
						{/if}
					</div>

					<div class="mt-3" style="border-top: 1px solid var(--tm-border); padding-top: 0.75rem">
						<p class="tm-label mb-2">
							{people.length > 1 ? `${people.length} travellers` : 'Just you'}
						</p>
						<div class="flex flex-col gap-1.5">
							{#each people as person (person.userId)}
								<span class="flex items-center gap-1.5">
									<img
										src={person.avatarUrl ?? avatarDataUri(person.avatarSeed)}
										alt=""
										width="22"
										height="22"
										style="width:22px;height:22px;border-radius:50%;object-fit:cover"
									/>
									<span style="font: 500 var(--tm-text-sm)/1 var(--tm-font)">
										{displayName(person)}
									</span>
									<!-- Whoever holds the link can read the trip. Writing it is
									     the owner's to hand over, and to take back. -->
									{#if person.role === 'owner'}
										<span class="tm-chip" style="opacity:0.6">owner</span>
									{:else if isOwner}
										<button
											class="tm-chip"
											onclick={() => setRole(person)}
											disabled={roleBusy === person.userId}
										>
											{person.role === 'editor' ? 'can edit' : 'view only'}
										</button>
										<button
											class="tm-chip tm-chip--warn"
											onclick={() => dropMember(person)}
											disabled={roleBusy === person.userId}
											aria-label="Remove {displayName(person)} from the trip"
										>
											×
										</button>
									{:else}
										<span class="tm-chip" style="opacity:0.6">
											{person.role === 'editor' ? 'can edit' : 'view only'}
										</span>
									{/if}
								</span>
							{/each}
						</div>
						<p class="tm-hint mt-2">
							Out by {ready ?? row.day_start.slice(0, 5)} · breakfast
							{agreed.windows.breakfast.from}–{agreed.windows.breakfast.to} · lunch
							{agreed.windows.lunch.from}–{agreed.windows.lunch.to} · dinner
							{agreed.windows.dinner.from}–{agreed.windows.dinner.to}
							{#if people.length > 1}(the overlap between everyone){/if}
						</p>
						{#if agreed.conflicts.length}
							<span class="tm-chip tm-chip--warn mt-2">
								No shared {agreed.conflicts.join(' or ')} time — using the latest start
							</span>
						{/if}
					</div>

					{#if isOwner}
						<div class="mt-3 flex gap-2">
							<a
								href="{base}/trip/{tripId}/edit"
								class="tm-btn tm-btn--secondary flex-1"
								style="min-height:38px;text-decoration:none"
							>
								Edit trip
							</a>
							{#if shareUrl}
								<button
									class="tm-btn tm-btn--secondary flex-1"
									style="min-height:38px"
									onclick={revoke}
								>
									Stop sharing
								</button>
							{/if}
						</div>
					{/if}
					{#if shareUrl}
						<p class="tm-attrib mt-2" style="word-break: break-all">{shareUrl}</p>
					{/if}
				</div>
			{/if}

			<div class="tm-seg" role="tablist" aria-label="View">
				<button role="tab" aria-selected={view === 'plan'} onclick={() => (view = 'plan')}>Day</button>
				<button role="tab" aria-selected={view === 'map'} onclick={() => (view = 'map')}>Map</button>
				<button role="tab" aria-selected={view === 'wishlist'} onclick={() => (view = 'wishlist')}>Wishlist</button>
			</div>

			{#if view === 'plan' || view === 'map'}
				<div class="flex items-center gap-1.5 overflow-x-auto">
					{#each days as day, i (day.date)}
						{@const on = view === 'map' ? visible.has(i) : i === dayIndex}
						<button
							class="tm-chip"
							data-drop-day={i}
							style={on
								? `background:${dayColor(i)};color:#fff`
								: drag.state.id
									? 'opacity:1;outline:2px dashed var(--tm-border-strong);outline-offset:2px'
									: 'opacity:0.55'}
							onclick={() => (view === 'map' ? toggleDay(i) : (dayIndex = i))}
						>
							{dayLabel(day.date, row.timezone)}
						</button>
					{/each}
					{#if view === 'map'}
						<button
							class="tm-chip"
							style={showUnassigned
								? 'background:var(--tm-day-none);color:#fff;white-space:nowrap'
								: 'opacity:0.55;white-space:nowrap'}
							onclick={() => (showUnassigned = !showUnassigned)}
						>
							Unassigned
						</button>
					{/if}
				</div>
			{/if}

			{#if error}<p class="tm-hint tm-hint--error">{error}</p>{/if}
			<Notices trip={tripId} />
			<!-- Every change of the traveller's that was put aside, whether or
			     not it has a card on the day being looked at. -->
			{#each asideOn(tripId) as m (m.seq)}
				<button
					class="tm-hint"
					style="display:flex;align-items:center;gap:6px;background:none;border:none;padding:0;text-align:left;cursor:pointer;color:inherit"
					onclick={() => (conflict = m)}
				>
					<span class="tm-conflict-mark" aria-hidden="true">!</span>
					<span>“{m.name}” was put aside: someone changed the same thing. Tap to decide.</span>
				</button>
			{/each}
		</div>

		{#if zoneWrong}
			<div class="tm-card m-4" style="background: var(--tm-warn-soft); border-color: transparent">
				<p class="tm-card__title" style="color: var(--tm-warn-ink)">Wrong timezone</p>
				<p class="tm-card__meta" style="color: var(--tm-warn-ink)">
					This trip runs on {row.timezone}, but {row.city} is on {zoneShouldBe}. Every time in
					it is out by the difference. Fixing keeps the times you typed and moves the trip onto
					{zoneShouldBe}; tap Replan afterwards.
				</p>
				<button
					class="tm-btn tm-btn--secondary tm-btn--block mt-3"
					disabled={busy}
					onclick={fixZone}
				>
					Use {zoneShouldBe}
				</button>
			</div>
		{/if}

		{#if hotelMissing(row)}
			<div class="tm-card m-4" style="background: var(--tm-warn-soft); border-color: transparent">
				<p class="tm-card__title" style="color: var(--tm-warn-ink)">Hotel location missing</p>
				<p class="tm-card__meta" style="color: var(--tm-warn-ink)">
					This trip was saved before hotels were searchable, so the planner has nothing to
					measure from.
				</p>
				<div class="mt-3">
					<Autocomplete
						label="Hotel"
						placeholder="Hotels in {row.city}"
						search={(q, signal) => provider.searchHotels(q, city!, signal)}
						onpick={(h) => setHotel(h)}
					/>
				</div>
			</div>
		{/if}

		{#if view === 'map'}
			<div class="flex-1"><TripMap {markers} {routes} center={centre} /></div>
		{:else if view === 'wishlist'}
			<div class="flex-1 overflow-y-auto p-4">
				{#if !pois.length}
					<div class="tm-card" style="background: var(--tm-surface-2)">
						<p class="tm-card__title">Wishlist is empty</p>
						<p class="tm-card__meta">Add places and they will be arranged into days.</p>
					</div>
				{:else}
					<!-- type=search, so a phone offers the right keyboard and its own
					     clear button rather than one drawn here. -->
					<input
						class="tm-input mb-3"
						type="search"
						bind:value={hunt}
						placeholder="Find a place"
						aria-label="Filter the wishlist"
					/>
					{#if !shortlist.length}
						<p class="tm-hint">Nothing matches “{hunt.trim()}”.</p>
					{/if}
					{#each shortlist as p (p.id)}
						{@const assigned = dayOf.has(p.id)}
						{@const waiting = asideFor('pois', { id: p.id })}
						<button
							class="tm-result"
							class:tm-result--conflict={!!waiting}
							style="align-items: center; color: inherit"
							onclick={() => (waiting ? (conflict = waiting) : (cardedId = p.id))}
						>
							<span style="display: flex; gap: 10px; align-items: flex-start">
								<span
									style="width:12px;height:12px;border-radius:50%;margin-top:4px;flex:none;background:{colorOf(p.id)}"
								></span>
								<span>
									<span style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
										{#if waiting}<span class="tm-conflict-mark" aria-label="A change of yours is waiting">!</span>{/if}
										<span class="tm-result__name">{p.name}</span>
										<Stars value={p.priority} size={9} label="Wanted" />
									</span>
									<span class="tm-result__meta" style="display:block">
										{p.category ?? 'place'} · {p.duration_min} min
										{#if isMeal(p.category)} · meal{/if}
										{#if assigned}
											· {dayLabel(days[dayOf.get(p.id)!].date, row.timezone)}
										{:else}
											· {REASON_TEXT[reasonOf.get(p.id) ?? 'not-planned-yet']}
										{/if}
									</span>
								</span>
							</span>
							<span style="color: var(--tm-text-faint)">›</span>
						</button>
					{/each}
					<p class="tm-hint mt-3">
						Tap any place for busyness, booking and how long to stay.
					</p>
				{/if}
			</div>
		{:else}
			<div class="flex-1 overflow-y-auto p-4" style="--tm-stop-day: {dayColor(dayIndex)}">
				{#if current && pois.length}
					<div class="mb-3 flex justify-end">
						<button
							class="tm-chip"
							aria-pressed={expanded}
							style={expanded
								? 'background: var(--tm-sky-soft); color: var(--tm-sky-ink)'
								: 'opacity: 0.6'}
							onclick={() => (expanded = !expanded)}
						>
							{expanded ? 'Hide the day' : 'Show the day'}
						</button>
					</div>
				{/if}

				<div
					class="tm-rails"
					data-ruler
					data-from={days[dayIndex]?.start.getTime()}
					data-to={days[dayIndex]?.end.getTime()}
					bind:this={railsEl}
					class:tm-rails--on={expanded || !!drag.state.id}
					class:tm-rails--drag={!!drag.state.id}
				>
					{#if (expanded || drag.state.id) && current}
						<!-- Three days standing side by side: the one before, the one
						     on screen, the one after. The middle line is behind the
						     cards, so where a card covers it there is something
						     planned and where it shows through there is not. The
						     neighbours are drop targets -- leaning a card onto one
						     moves it to that day without leaving the day you are
						     reading. -->
						{#each [-1, 0, 1] as offset}
							{@const i = dayIndex + offset}
							{@const within = i >= 0 && i < days.length}
							<div
								class="tm-rails__rail tm-rails__rail--{offset === -1
									? 'prev'
									: offset === 0
										? 'here'
										: 'next'}"
								data-drop-day={within ? i : undefined}
								data-ruler-here={offset === 0 ? '' : undefined}
							>
								<DayLine
									day={within ? (result?.days[i] ?? null) : null}
									window={within ? days[i] : null}
									timezone={row.timezone}
									dayColor={dayColor(within ? i : dayIndex)}
									kind={offset === 0 ? 'here' : within ? 'neighbour' : 'stub'}
									label={offset === 0 || !within ? null : dayLabel(days[i].date, row.timezone)}
									lit={offset !== 0 && held?.day === i}
									marker={offset !== 0 && held?.day === i ? held.at : null}
									place={offset === 0 ? railPlace : null}
								/>
							</div>
						{/each}
					{/if}

				{#if !pois.length}
					<div class="tm-card" style="background: var(--tm-surface-2)">
						<p class="tm-card__title">Nothing to plan yet</p>
						<p class="tm-card__meta">Add some places and the days will arrange themselves.</p>
					</div>
				{:else if current}
					{#each current.stops as stop, i (stop.id ?? `${stop.name}:${i}`)}
						<!-- A meal container drags as itself: it owns no row in the
						     wishlist, so its name while held is its day and its meal. -->
						<!-- A card is dragged as the visit it is, not as the place it
						     is of: the same cafe can be on the day twice, and "the
						     cafe" cannot say which of them is being moved. -->
						{@const grabId = !canEdit
							? null
							: stop.anchorKind === 'meal' && !stop.placementId
								? `${SLOT_DRAG}${dayIndex}:${mealFor(stop) ?? ''}`
								: stop.placementId}
						<!-- An empty meal container is a question: what are you eating?
						     The whole card asks it, not the four words of its name. -->
						{@const emptyMeal = stop.anchorKind === 'meal' && !stop.poiId}
						{@const after = emptyMeal
							? current.stops.slice(i + 1).find((x) => x.poiId)
							: undefined}
						{@const t = cardTimes(
							stop.timeLabel,
							hhmm(stop.arrive, row.timezone),
							stop.durationMin
						)}
						<!-- A leg of no length is two cards standing in the same
						     place: the journey chain, where nothing is travelled. -->
						{#if stop.legIn && stop.legIn.minutes > 0 && i > 0}
							{@const previous = current.stops[i - 1]}
							<LegDetail
								from={previous.exitAt ?? previous.at}
								to={stop.at}
								mode={stop.legIn.mode}
								departAt={previous.depart.toISOString()}
								timezone={row.timezone}
								estimate={{ minutes: stop.legIn.minutes, km: stop.legIn.km }}
								source={stop.legIn.source}
							/>
						{/if}
						<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
						<div
							class="tm-stop"
							data-start={stop.arrive.getTime()}
							data-card={stop.placementId ?? ''}
							data-end={stop.depart.getTime()}
							class:tm-stop--anchor={stop.anchor}
							class:tm-stop--terminal={stop.anchorKind === 'terminal'}
							class:tm-stop--service={stop.anchorKind === 'service'}
							class:tm-stop--chore={stop.anchorKind === 'chore'}
							class:tm-stop--meal={stop.anchorKind === 'meal'}
							class:tm-stop--blocked={stop.warnings.some((w) => w.kind === 'blocked')}
							class:tm-stop--conflict={!!conflictOf(stop, dayIndex)}
							{@attach stop.poiId
								? longPress(() => openCard(stop.placementId ?? stop.poiId!))
								: stop.anchorKind === 'meal'
									? longPress(() => holdMeal(stop, dayIndex))
									: stop.placementId || allowanceOf(stop, dayIndex)
										? longPress(() => holdAllowance(stop, dayIndex))
										: () => {}}
							style={grabId && drag.state.id === grabId ? 'opacity:0.35' : ''}
							role={emptyMeal ? 'button' : undefined}
							tabindex={emptyMeal ? 0 : undefined}
							onclick={emptyMeal
								? () => (slot = { day: dayIndex, before: after?.poiId ?? null, meal: stop.name })
								: undefined}
							onkeydown={emptyMeal
								? (e: KeyboardEvent) => {
										if (e.key !== 'Enter' && e.key !== ' ') return;
										e.preventDefault();
										slot = { day: dayIndex, before: after?.poiId ?? null, meal: stop.name };
									}
								: undefined}
						>
							<!-- The time is the handle. It is the part of a card that is
							     about when, which is what dragging one changes, and it
							     saves a glyph nobody could find. -->
							<span
								class="tm-stop__time"
								class:tm-stop__time--grab={!!grabId}
								data-grab={grabId ? 'yes' : undefined}
								{@attach grabId ? (node: HTMLElement) => drag.handle(node, grabId) : () => {}}
							>
								<!-- One time when it takes no time. A card that starts and
								     ends at the same minute wore that minute twice, with a
								     rule between them. -->
								{#if t.to === t.from}
									<span class="tm-stop__at">{t.from}</span>
								{:else}
									<span class="tm-stop__from">{t.from}</span>
									<span class="tm-stop__to">{t.to}</span>
								{/if}
							</span>
							<div>
								<p class="tm-stop__name">
									<!-- The card that does not fit wears a mark. Something
									     has to move and the plan is not allowed to choose
									     which, so the traveller is told which card the day
									     breaks on rather than left to find it. -->
									{#if stop.warnings.some((w) => w.kind === 'blocked')}
										<span class="tm-stop__blocked" aria-label="Does not fit">!</span>
									{/if}
									<!-- A change of the traveller's that was put aside: the card
									     draws what the trip says, and the mark opens the
									     choice between that and theirs. -->
									{#if conflictOf(stop, dayIndex)}
										<button
											class="tm-conflict-mark"
											aria-label="A change of yours was put aside"
											onclick={() => (conflict = conflictOf(stop, dayIndex))}
										>!</button>
									{/if}
									{#if stop.poiId}
										<button
											class="tm-stop__open"
											onclick={() => openCard(stop.placementId ?? stop.poiId!)}
										>{stop.name}</button>
									{:else if stop.anchorKind === 'meal'}
										{@const after = current.stops.slice(i + 1).find((x) => x.poiId)}
										<button
											class="tm-stop__open"
											onclick={() => {
												const waiting = conflictOf(stop, dayIndex);
												if (waiting) conflict = waiting;
												else slot = { day: dayIndex, before: after?.poiId ?? null, meal: stop.name };
											}}
										>{stop.name}</button>
									{:else}{stop.name}{/if}
								</p>
								<p class="tm-stop__sub" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
									<span>
										{#if stop.anchorKind === 'meal'}
											{MEAL_LABEL[mealFor(stop) ?? 'lunch']} · {stop.durationMin} min{stop.poiId
												? ''
												: ' · nothing chosen yet'}
										{:else if stop.anchorKind === 'service'}
											your journey
										{:else if stop.durationMin}
											{stop.durationMin} min
										{:else if stop.anchorKind === 'terminal'}
											terminal
										{:else if stop.anchorKind === 'hotel'}
											your hotel
										{:else}
											{stop.durationMin} min
										{/if}
									</span>
									{#if stop.exitAt}
										<span class="tm-chip tm-chip--sky" style="font-size:10px">
											ends elsewhere
										</span>
									{/if}
									{#if stop.placementId}
										{@const held = pinnedIds.has(stop.placementId)}
										<button
											class="tm-pin"
											class:tm-pin--on={held}
											aria-pressed={held}
											title={held ? 'Replan may not move this' : 'Hold this where it is'}
											onclick={() => togglePin(stop.placementId!)}
										>
											<svg width="11" height="11" viewBox="0 0 24 24" fill={held ? 'currentColor' : 'none'}
												stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
												<path d="M12 17v5M9 3h6l-1 6 3 3v2H7v-2l3-3z" />
											</svg>
											{held ? 'Pinned' : 'Pin'}
										</button>
									{/if}
								</p>
								<!-- Keyed by what it says, not by what sort it is: two
								     warnings of one sort on a card used to take the whole
								     screen down rather than draw one of them. -->
								{#each stop.warnings as w (w.kind + w.message)}
									<div class="mt-2">
										<!-- A day that cannot be walked is not a remark about
										     the weather: the card it names is one the plan is
										     not allowed to move, so the traveller has to say
										     what gives. -->
										<span
											class="tm-chip"
											class:tm-chip--error={w.kind === 'blocked'}
											class:tm-chip--warn={w.kind !== 'blocked'}
										>
											{w.message}
										</span>
									</div>
								{/each}
							</div>
						</div>
						<!-- The gap under this stop: the time between it and whatever
						     comes next, drawn to scale once it is opened. Whatever is
						     added here lands above the next real stop, at the moment
						     the traveller touched.

						     Not offered inside the journey: a museum between two
						     airports is not a thing, and the journey's own steps
						     are added on the trip's edit screen. -->
						{#if stop.anchorKind !== 'terminal' && stop.anchorKind !== 'service' && i < current.stops.length - 1}
							{@const following = current.stops.slice(i + 1).find((x) => x.poiId)}
							{@const next = current.stops[i + 1]}
							{@const key = `${dayIndex}:${i}`}
							<TimeGap
								start={stop.depart}
								end={new Date(+next.arrive - (next.legIn?.minutes ?? 0) * 60_000)}
								timezone={row.timezone}
								open={gapOpen(key)}
								forced={!!drag.state.id}
								fillable={canEdit}
								ontoggle={() => toggleGap(key)}
								onpick={(at) =>
									(slot = {
										day: dayIndex,
										before: following?.poiId ?? null,
										at: at.toISOString()
									})}
							/>
						{/if}
					{/each}
				{/if}
				</div>
			</div>
		{/if}

		{#if mealed}
			{@const m = mealed}
			{@const said = mealCard(tripId, m.day, m.meal)}
			<div
				role="presentation"
				style="position:fixed;inset:0;z-index:60;background:rgba(0,0,0,0.35)"
				onclick={() => (mealed = null)}
			></div>
			<div class="tm-sheet" style="position:fixed;z-index:61">
				<div class="tm-sheet__grip"></div>
				<p class="tm-card__title">{m.name}</p>
				<p class="tm-card__meta">
					{said?.poi_id
						? 'You chose what goes here.'
						: 'Nothing chosen: the plan fills it with somewhere suitable nearby.'}
				</p>

				<button
					class="tm-btn tm-btn--primary tm-btn--block mt-3"
					onclick={() => {
						mealed = null;
						slot = { day: m.day, before: null, meal: m.name };
					}}
				>
					{said?.poi_id ? 'Change the place' : 'Choose a place'}
				</button>

				{#if said?.poi_id}
					<button
						class="tm-btn tm-btn--secondary tm-btn--block mt-2"
						disabled={busy}
						onclick={() => sayMeal(m.day, m.meal, 'reset')}
					>
						Let the plan choose
					</button>
				{/if}

				<button
					class="tm-btn tm-btn--block mt-2"
					style="background: var(--tm-danger-soft); color: var(--tm-danger-ink)"
					disabled={busy}
					onclick={() => sayMeal(m.day, m.meal, { skipped: true })}
				>
					Skip {m.name.toLowerCase()} this day
				</button>
				<button class="tm-btn tm-btn--ghost tm-btn--block mt-2" onclick={() => (mealed = null)}>
					Cancel
				</button>
			</div>
		{/if}

		{#if allowanced}
			{@const a = allowanced}
			<div
				role="presentation"
				style="position:fixed;inset:0;z-index:60;background:rgba(0,0,0,0.35)"
				onclick={() => (allowanced = null)}
			></div>
			<div class="tm-sheet" style="position:fixed;z-index:61">
				<div class="tm-sheet__grip"></div>
				<p class="tm-card__title">{a.name}</p>
				<p class="tm-card__meta">{ALLOWANCE_HINT[a.kind]}</p>
				<div class="mt-3 flex flex-wrap gap-2">
					{#each [0, 15, 30, 45, 60, 90, 120, 180] as m}
						<button
							class="tm-chip"
							aria-pressed={a.minutes === m}
							style={a.minutes === m
								? 'background: var(--tm-lilac-soft); color: var(--tm-lilac-ink)'
								: 'opacity: 0.6'}
							disabled={busy}
							onclick={() => setAllowance(a.kind, m, a.placementId)}
						>
							{m === 0 ? 'none' : m < 60 ? `${m} min` : `${m / 60} h`}
						</button>
					{/each}
				</div>
				<p class="tm-hint mt-2">
					{a.placementId
						? 'This card only.'
						: a.kind === 'prep'
							? 'Changes your own profile, so it carries to every trip.'
							: 'Changes this trip.'}
				</p>
				{#if a.placementId}
					<button
						class="tm-btn tm-btn--secondary tm-btn--block mt-3"
						disabled={busy}
						onclick={() => unplace(a.placementId!)}
					>
						Take it off this day
					</button>
				{/if}
				<button
					class="tm-btn tm-btn--ghost tm-btn--block mt-3"
					onclick={() => (allowanced = null)}
				>
					Cancel
				</button>
			</div>
		{/if}

		{#if carded}
			<StopCard
				poi={carded}
				{tripId}
				hotel={row ? { lat: row.hotel_lat, lng: row.hotel_lng, name: row.hotel_name } : null}
				{people}
				{busy}
				onedit={(patch) => editCarded(patch)}
				placementId={cardedVisit}
				pinned={!!cardedVisit && pinnedIds.has(cardedVisit)}
				onunplace={(id) => unplace(id)}
				onrelease={(id) => togglePin(id)}
				onclose={() => ((cardedId = null), (cardedVisit = null))}
			/>
		{/if}

		{#if conflict}
			{@const m = conflict}
			<ConflictSheet
				name={m.name}
				lines={explainIt(m)}
				onaccept={() => settle(m, 'mine')}
				onreject={() => settle(m, 'theirs')}
				onclose={() => (conflict = null)}
			/>
		{/if}

		{#if slot}
			{@const target = slot}
			<div
				role="presentation"
				style="position:fixed;inset:0;z-index:60;background:rgba(0,0,0,0.35)"
				onclick={() => (slot = null)}
			></div>
			<div class="tm-sheet" style="position:fixed;z-index:61;max-height:76vh;overflow-y:auto">
				<div class="tm-sheet__grip"></div>
				<p class="tm-label mb-2">
					{target.meal
						? `Somewhere for ${target.meal.toLowerCase()}`
						: `Add to ${dayLabel(days[target.day].date, row.timezone)}`}
				</p>

				{#if missingMeals.length}
					<p class="tm-hint mb-2">A meal this day has not got</p>
					<div class="mb-3 flex flex-wrap gap-2">
						{#each missingMeals as meal}
							<button
								class="tm-chip"
								style="background: var(--tm-blush-soft); color: var(--tm-blush-ink)"
								disabled={busy}
								onclick={() =>
									sayMeal(target.day, meal, {
										skipped: false,
										// Where they tapped. Without a time a meal whose window
										// the day never reached simply would not appear again.
										at: (slotFrom?.depart ?? days[target.day].start).toISOString()
									})}
							>
								{MEAL_LABEL[meal]}
							</button>
						{/each}
					</div>
				{/if}

				<!-- Not everything on a day is a place on the wishlist. Going back
				     to the hotel in the afternoon and an hour doing nothing are
				     things the day is made of, and they go in the same way. -->
				{#if !target.meal}
					<div class="mb-3 flex flex-wrap gap-2">
						<button class="tm-chip" disabled={busy} onclick={() => addFurniture('hotel')}>
							+ back to {row.hotel_name}
						</button>
						<button class="tm-chip" disabled={busy} onclick={() => addFurniture('chore')}>
							+ time to yourself
						</button>
					</div>
				{/if}

				<!-- Folded: most of the time what goes in a gap is a place or a meal. -->
				<details class="mb-3">
					<summary class="tm-hint" style="cursor:pointer">Or a stretch of time</summary>
				<div class="tm-field mt-2">
					<input
						class="tm-input"
						bind:value={blockName}
						placeholder="Rest, shopping, a nap…"
						aria-label="What the time is for"
					/>
					<div class="flex flex-wrap gap-2">
						{#each [30, 60, 90, 120] as m}
							<button
								class="tm-chip"
								aria-pressed={blockMin === m}
								style={blockMin === m
									? 'background: var(--tm-peach-soft); color: var(--tm-peach-ink)'
									: 'opacity: 0.6'}
								onclick={() => (blockMin = m)}
							>
								{m < 60 ? `${m} min` : `${m / 60} h`}
							</button>
						{/each}
					</div>
					<button
						class="tm-btn tm-btn--secondary tm-btn--block"
						disabled={!blockName.trim() || busy}
						onclick={addBlock}
					>
						Add {blockName.trim() || 'a block'}
					</button>
					<span class="tm-hint">
						No place of its own: it happens wherever the day has you at the time, and stays
						where you put it.
					</span>
				</div>
				</details>

				<div class="tm-search mb-2">
					<svg
						width="15"
						height="15"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2.2"
						stroke-linecap="round"
					>
						<circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" />
					</svg>
					<input
						bind:value={slotQuery}
						placeholder="Find it on your wishlist"
						aria-label="Filter your wishlist"
					/>
					{#if slotQuery}
						<button
							onclick={() => (slotQuery = '')}
							aria-label="Clear"
							style="background:none;border:none;cursor:pointer;color:var(--tm-text-faint);font-size:18px;line-height:1;padding:0 2px"
						>
							&times;
						</button>
					{/if}
				</div>

				{#if unassigned.length}
					<p class="tm-hint mb-2">
						{target.meal ? 'From your wishlist, places to eat first' : 'From your wishlist'}
					</p>
					<!-- About four at a time, and the rest a scroll away: the sheet
					     stays a sheet, not a list that pushes everything off it. -->
					<div
						class="flex flex-col gap-1"
						style="margin: 0 calc(-1 * var(--tm-space-2)); max-height: 16rem; overflow-y: auto; border: 1px solid var(--tm-border); border-radius: var(--tm-r-md)"
					>
						{#each unassigned as p (p.id)}
							{@const same = unassigned.filter((o) => o.name === p.name).length}
							<button class="tm-result" onclick={() => placeHere(p.id)}>
								<span>
									<span class="tm-result__name">
										{p.name}{#if same > 1}<span class="tm-count">&times;{same}</span>{/if}
									</span>
									<span class="tm-result__meta" style="display:block">
										{p.category ?? 'place'} · {p.duration_min} min
										{#if detour(p)}
											· {detour(p)} km from {slotFrom?.name}
										{/if}
										{#if dayOfPoi.has(p.id)}
											· another, as well as {dayLabel(
												days[dayOfPoi.get(p.id)!].date,
												row.timezone
											)}
										{/if}
									</span>
								</span>
								<span class="tm-add" aria-hidden="true">+</span>
							</button>
						{/each}
					</div>
				{:else}
					<p class="tm-hint mb-2">
						{slotQuery.trim()
							? `Nothing on your wishlist matches “${slotQuery.trim()}”.`
							: 'Nothing on your wishlist yet.'}
					</p>
				{/if}

				<a
					class="tm-btn tm-btn--primary tm-btn--block mt-4"
					style="text-decoration:none"
					href={slotHref(target.day, target.before) +
						(slotQuery.trim() ? `&q=${encodeURIComponent(slotQuery.trim())}` : '')}
				>
					{slotQuery.trim() ? `Search for “${slotQuery.trim()}”` : 'Find a new place'}
				</a>
			</div>
		{/if}

		{#if drag.state.id}
			<!-- Under the finger, not beside it, and see-through, so the day it
			     is moving over reads through it. The hour is on the rail, at the
			     finger's height: that is what the rails are for. -->
			<div
				aria-hidden="true"
				style="position:fixed;left:{drag.state.x}px;top:{drag.state.y}px;transform:translate(-50%,-50%);
				pointer-events:none;z-index:50;opacity:0.75;background:var(--tm-surface);border:1px solid var(--tm-primary);
				border-radius:var(--tm-r-md);padding:6px 12px;font:600 var(--tm-text-sm)/1 var(--tm-font);
				box-shadow:0 6px 20px rgba(0,0,0,0.18);white-space:nowrap"
			>
				{heldName}
			</div>
			<!-- The hour the card would be put at, at the finger's height on the
			     day's line: bigger than anything around it, and above all of it. -->
			{#if held && held.day === dayIndex}
				<div
					aria-hidden="true"
					style="position:fixed;left:0;right:0;top:{drag.state.y}px;height:0;border-top:2px solid var(--tm-primary);
					pointer-events:none;z-index:60"
				>
					<span
						style="position:absolute;left:50%;top:0;transform:translate(-50%,-50%);padding:4px 12px;border-radius:999px;
						background:var(--tm-primary);color:var(--tm-primary-ink);font:700 17px/1.2 var(--tm-font-num);
						box-shadow:0 2px 10px rgba(0,0,0,0.3);white-space:nowrap"
					>{hhmm(held.at, row.timezone)}</span>
				</div>
			{/if}
			<p
				class="tm-hint"
				style="position:fixed;left:0;right:0;bottom:84px;text-align:center;z-index:50;pointer-events:none"
			>
				Let go where the line shows the hour you want, or on another day’s line
			</p>
		{/if}

		<div class="tm-safe-bottom flex items-center justify-between px-4 pt-3" style="border-top: 1px solid var(--tm-border)">
			{#if view === 'plan' && current && current.stops.length > 1}
				{@const url = dayUrl(routePoints(current.stops), (current.stops.find((s) => s.legIn)?.legIn?.mode ?? 'walk') as Mode)}
				{#if url}
					<a
						class="tm-btn tm-btn--secondary"
						style="min-height:38px;text-decoration:none"
						href={url}
						target="_blank"
						rel="noopener noreferrer"
						title={dayTruncated(routePoints(current.stops))
							? 'Maps takes nine stops; the rest are trimmed'
							: 'Open the whole day in Maps'}
					>
						Day in Maps
					</a>
				{/if}
			{:else if result?.unplaced.length}
				<button class="tm-chip tm-chip--warn" onclick={() => (view = 'wishlist')}>
					{result.unplaced.length} unplaced
				</button>
			{:else}
				<span class="tm-chip tm-chip--mint">{pois.length} stops</span>
			{/if}
			{#if canEdit}
				<a
					href="{base}/trip/{tripId}/add"
					class="tm-btn tm-btn--primary"
					style="min-height:38px;text-decoration:none"
				>
					Add places
				</a>
			{/if}
		</div>
	{/if}
</main>
