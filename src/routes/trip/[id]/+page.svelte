<script lang="ts">
	import { onMount } from 'svelte';
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
		updateHotel,
		type TripRow
	} from '$lib/trip/repo';
	import {
		addPoi,
		listPois,
		removePoi,
		saveAssignments,
		toPlanPoi,
		updatePoi,
		type PoiRow
	} from '$lib/trip/pois';
	import { describe as describeJourney } from '$lib/trip/journey';
	import {
		loadMeals,
		mealKey,
		resetMeal,
		saveMeal,
		toMealPlan,
		type MealSlotRow
	} from '$lib/trip/meals';
	import { tripDays, zonedInstant, type Day } from '$lib/trip/days';
	import {
		replan,
		schedule,
		REASON_TEXT,
		type PlanResult,
		type PlannedDay,
		type PlannedStop,
		PLANNER_VERSION,
		type Unplaced,
		type UnplacedReason
	} from '$lib/plan/planner';
	import {
		loadPlan,
		savePlan,
		staleCount,
		tableFromPlan,
		toPlannedDays,
		type PlanStopRow
	} from '$lib/trip/plan';
	import {
		effectiveDayStart,
		isMeal,
		latestPrep,
		latestReady,
		MEAL_LABEL,
		MEAL_NAMES,
		slotAt,
		slotsFrom,
		tightest,
		type MealName,
		type MealWindows
	} from '$lib/plan/meals';
	import { resolveCurves, type CrowdCurves } from '$lib/plan/crowd';
	import { routeShape } from '$lib/plan/route';
	import { firstOf, resolveTravel, type TravelTable } from '$lib/plan/travel';
	import { refineTrip } from '$lib/plan/refine';
	import { BLOCK_CATEGORY } from '$lib/plan/planner';
	import { pool } from '$lib/pool';
	import { avatarDataUri } from '$lib/avatar';
	import {
		displayName,
		loadTripProfiles,
		removeMember,
		saveMyProfile,
		setMemberRole,
		type Profile
	} from '$lib/profile.svelte';
	import type { Mode } from '$lib/plan/modes';
	import Autocomplete from '$lib/Autocomplete.svelte';
	import Stars from '$lib/Stars.svelte';
	import LegDetail from '$lib/LegDetail.svelte';
	import { dayTruncated, dayUrl, routePoints } from '$lib/maps';
	import { createDrag, insertInto, reorder } from '$lib/dnd.svelte';
	import { cardTimes } from '$lib/board';
	import { haversineKm } from '$lib/plan/geo';
	import { longPress } from '$lib/longpress.svelte';
	import PlanBoard from '$lib/PlanBoard.svelte';
	import StopCard from '$lib/StopCard.svelte';
	import DayLine from '$lib/DayLine.svelte';
	import TimeGap from '$lib/TimeGap.svelte';
	import TripAvatar from '$lib/TripAvatar.svelte';
	import { supabase } from '$lib/supabase';
	import { session } from '$lib/session.svelte';
	import { zoneAt } from '$lib/trip/timezone';
	import TripMap from '$lib/GoogleMap.svelte';
	import { poi as provider, type City } from '$lib/poi';

	const tripId = page.params.id!;

	let row = $state<TripRow | null>(null);
	/** Sharing, editing and the picture are the owner's; the policies say so
	    too, and a control the server will refuse is a control that lies. */
	const isOwner = $derived(!!row && row.user_id === session.user?.id);
	let pois = $state<PoiRow[]>([]);
	let loading = $state(true);
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
	let carded = $state<PoiRow | null>(null);

	// A sheet opened for one slot should not still be filtered by what was
	// typed into the last one.
	$effect(() => {
		void slot;
		slotQuery = '';
	});
	let allowanced = $state<{ kind: Allowance; name: string; minutes: number } | null>(null);
	/** A meal container the traveller is holding down on. */
	let mealed = $state<{ day: number; meal: MealName; name: string; poiId: string | null } | null>(
		null
	);

	/** Meals this day has no container for: skipped, or never offered. */
	const missingMeals = $derived.by(() => {
		if (!slot || !row) return [] as MealName[];
		const day = (fresh ?? toPlannedDays(stored, days))[slot.day];
		const present = new Set(
			(day?.stops ?? [])
				.filter((st) => st.anchorKind === 'meal')
				.map((st) => mealFor(st))
				.filter(Boolean)
		);
		return MEAL_NAMES.filter((m) => !present.has(m));
	});

	/** A meal container dragged to a new time on the board. */
	async function moveMeal(stop: PlannedStop, dayIdx: number, minutes: number) {
		const meal = mealFor(stop);
		if (!meal || !row) return;
		const at = zonedInstant(
			days[dayIdx].date,
			`${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`,
			row.timezone
		);
		await sayMeal(dayIdx, meal, { at: at.toISOString() });
	}

	async function sayMeal(
		dayIdx: number,
		meal: MealName,
		change: { poiId?: string | null; skipped?: boolean; at?: string | null } | 'reset'
	) {
		mealed = null;
		slot = null;
		busy = true;
		try {
			if (change === 'reset') await resetMeal(tripId, dayIdx, meal);
			else await saveMeal(tripId, { dayIndex: dayIdx, meal, ...change });

			// The slot holds it; it needs no day of its own. Unpinned, because a
			// pinned meal is one placed outside a slot and this one is in one.
			if (change !== 'reset' && change.poiId) {
				await saveAssignments([{ id: change.poiId, dayIndex: null, orderIndex: null }]);
				await updatePoi(change.poiId, { pinned: false, pinned_at: null });
				pois = await listPois(tripId);
			}

			mealRows = await loadMeals(tripId);
			await restore();
		} catch (e) {
			error = (e as Error).message;
		} finally {
			busy = false;
		}
	}

	const ALLOWANCE_HINT: Record<Allowance, string> = {
		prep: 'Waking and getting out of the door. Yours, on every trip.',
		bags: 'At the hotel on arrival, and again before leaving.',
		out: 'Passport queues and baggage reclaim at the airport you land at.',
		checkin: 'Standing in the terminal before you leave.'
	};

	/** Which allowance a card stands for, if it stands for one. */
	function allowanceOf(stop: PlannedStop, dayIdx: number): Allowance | null {
		if (stop.anchorKind === 'chore') return stop.name === 'Getting ready' ? 'prep' : 'bags';
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
		const meal = mealFor(stop);
		if (meal) {
			mealed = { day: dayIdx, meal, name: MEAL_LABEL[meal], poiId: stop.poiId };
		}
	}

	function holdAllowance(stop: PlannedStop, dayIdx: number) {
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

	async function setAllowance(kind: Allowance, minutes: number) {
		if (!row) return;
		allowanced = null;
		busy = true;
		try {
			if (kind === 'prep') {
				await saveMyProfile({ prep_min: minutes });
				people = await loadTripProfiles(tripId);
			} else {
				const patch =
					kind === 'bags'
						? { bag_drop_min: minutes }
						: kind === 'out'
							? { arrival_buffer_min: minutes }
							: { departure_buffer_min: minutes };
				await updateAllowance(tripId, patch);
				row = { ...row, ...patch };
			}
			await restore();
		} catch (e) {
			error = (e as Error).message;
		} finally {
			busy = false;
		}
	}

	/**
	 * A quick edit from the card: applied where the traveller is looking, and
	 * the day re-timed around it, rather than sending them to another screen
	 * and back to see what it did.
	 */
	async function editCarded(patch: {
		duration_min?: number;
		priority?: number;
		pinned?: boolean;
		notes?: string | null;
	}) {
		const held = carded;
		if (!held) return;
		busy = true;
		try {
			const updated = await updatePoi(held.id, {
				...patch,
				...(patch.pinned === false ? { pinned_at: null } : {})
			});
			pois = pois.map((p) => (p.id === held.id ? updated : p));
			carded = updated;
			// Nothing else. An edit changes the thing edited; Replan is what
			// takes a new rating or a new length and rebuilds the day from it.
			// Re-timing here moves the plan under someone who asked for none of
			// it.
		} catch (e) {
			error = (e as Error).message;
		} finally {
			busy = false;
		}
	}

	async function forget(poiId: string) {
		carded = null;
		busy = true;
		try {
			await removePoi(poiId);
			pois = pois.filter((p) => p.id !== poiId);
			await restore();
		} catch (e) {
			error = (e as Error).message;
			pois = await listPois(tripId);
		} finally {
			busy = false;
		}
	}

	async function unpin(poiId: string) {
		carded = null;
		busy = true;
		try {
			await updatePoi(poiId, { pinned: false, pinned_at: null });
			pois = pois.map((p) => (p.id === poiId ? { ...p, pinned: false, pinned_at: null } : p));
			await restore();
		} catch (e) {
			error = (e as Error).message;
		} finally {
			busy = false;
		}
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
			const ext = file.name.split('.').pop()?.toLowerCase() ?? 'png';
			const path = `${tripId}/${crypto.randomUUID()}.${ext}`;
			const { error: upErr } = await supabase.storage
				.from('trip-images')
				.upload(path, file, { upsert: true, contentType: file.type });
			if (upErr) throw new Error(upErr.message);
			const { data } = supabase.storage.from('trip-images').getPublicUrl(path);
			await setTripImage(tripId, data.publicUrl);
			if (row) row = { ...row, image_url: data.publicUrl };
		} catch (e) {
			error = (e as Error).message;
		} finally {
			picking = false;
			input.value = '';
		}
	}

	async function clearImage() {
		try {
			await setTripImage(tripId, null);
			if (row) row = { ...row, image_url: null };
		} catch (e) {
			error = (e as Error).message;
		}
	}
	let dayIndex = $state(0);
	let view = $state<'plan' | 'board' | 'map' | 'wishlist'>('plan');
	let showDetails = $state(false);
	/** The day with its own line drawn behind the cards. */
	let expanded = $state(false);
	let visible = $state(new Set<number>());
	/** Unassigned stops are their own layer on the map, not a day. */
	let showUnassigned = $state(true);
	let seeded = false;
	let shareUrl = $state<string | null>(null);
	let copied = $state(false);
	let bbox = $state<ReturnType<typeof cityBBox>>(null);
	let people = $state<Profile[]>([]);

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
	let stored = $state<PlanStopRow[]>([]);
	/** What the traveller has said about particular meals. */
	let mealRows = $state<MealSlotRow[]>([]);
	const mealPlan = $derived(toMealPlan(mealRows));
	let planAt = $state<string | null>(null);
	/**
	 * A plan this session has just produced. It wins over `stored` until the
	 * page is next loaded: the traveller should see a drag land immediately
	 * rather than after the write has been read back.
	 */
	let fresh = $state<PlannedDay[] | null>(null);

	/**
	 * Real travel times, arriving after the fact.
	 *
	 * The refiner routes the legs the plan guessed at and writes each answer
	 * onto the stop it belongs to. This is how an open plan hears about it: the
	 * row is merged into the stored plan, the day is re-walked on the better
	 * figure, and the star beside the leg goes out. Nothing is reordered --
	 * only the clock moves, and only by the difference.
	 *
	 * Also how a fellow traveller's edit reaches this screen, which it never
	 * did before.
	 */
	function watchPlan() {
		const channel = supabase
			.channel(`plan:${tripId}`)
			.on(
				'postgres_changes',
				{ event: '*', schema: 'public', table: 'plan_stops', filter: `trip_id=eq.${tripId}` },
				({ new: changed }) => {
					const incoming = changed as PlanStopRow | null;
					if (!incoming?.id) return;
					const held = stored.find((r) => r.id === incoming.id);
					// Our own write coming back. Re-walking on it would write
					// again, which would come back again.
					if (
						held &&
						held.leg_minutes === incoming.leg_minutes &&
						held.leg_km === incoming.leg_km &&
						held.leg_source === incoming.leg_source
					) {
						return;
					}
					stored = held
						? stored.map((r) => (r.id === incoming.id ? { ...r, ...incoming } : r))
						: [...stored, incoming];
					// Not while a card is in the air: the plan under the finger is
					// the traveller's, and it can take the better figure when they
					// put it down.
					if (drag.state.id || busy) return;
					const input = planInput();
					if (input) fresh = schedule({ ...input, travel: known() }).days;
				}
			)
			.subscribe();
		return () => {
			void supabase.removeChannel(channel);
		};
	}

	// Its own onMount: an async one cannot hand back a cleanup.
	onMount(watchPlan);

	onMount(async () => {
		try {
			[row, pois, people, stored, mealRows] = await Promise.all([
				getTrip(tripId),
				listPois(tripId),
				loadTripProfiles(tripId),
				loadPlan(tripId),
				loadMeals(tripId)
			]);
			if (!row) return;
			planAt = row.plan_generated_at;
			// Coming back from adding into a slot: open on the day it landed on.
			const asked = Number(page.url.searchParams.get('day'));
			if (Number.isInteger(asked) && asked >= 0) dayIndex = asked;
			if (row.share_token) shareUrl = linkFor(row.share_token);
			bbox = cityBBox(row);
			// Trips saved before the city box -- and before the country code --
			// was captured. One geocode fills in whichever is missing.
			if (!bbox || !row.country_code) {
				const [match] = await provider.searchCities(row.city);
				if (match?.bbox && !bbox) {
					bbox = match.bbox;
					await updateCityBBox(tripId, match.bbox);
				}
				if (match?.countryCode && !row.country_code) {
					row = { ...row, country_code: match.countryCode };
					await updateCountryCode(tripId, match.countryCode);
				}
			}
		} catch (e) {
			error = (e as Error).message;
		} finally {
			loading = false;
		}
	});

	const linkFor = (token: string) => `${window.location.origin}${base}/shared/${token}`;

	/** The latest anyone on this trip is out of the door. */
	const ready = $derived(latestReady(people.map((p) => ({ wakeAt: p.wakeAt, prepMin: p.prepMin }))));

	/** Whoever is ready last, and their own hours -- wake time and prep. */
	const prep = $derived(latestPrep(people.map((p) => ({ wakeAt: p.wakeAt, prepMin: p.prepMin }))));

	const days = $derived<Day[]>(
		row
			? tripDays({
					...toTrip(row),
					// The day opens when the party wakes, not when they are dressed:
					// getting ready is a card on the plan that spends the half
					// hour, rather than half an hour the plan never mentions.
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
	async function refreshTravel() {
		if (!row || !days.length) return;
		const modes = row.allowed_modes as Mode[];

		const perDay = days.map((day, i) => {
			const anchors = [...day.fixedStart, ...day.fixedEnd].map((w) => w.at);
			const stops = pois
				.filter((p) => p.day_index === i)
				.flatMap((p) =>
					// Both ends of a stop you leave from somewhere else: the matrix
					// is asked about legs out of the exit as well as in to the entrance.
					p.exit_lat !== null && p.exit_lng !== null
						? [
								{ lat: p.lat, lng: p.lng },
								{ lat: p.exit_lat, lng: p.exit_lng }
							]
						: [{ lat: p.lat, lng: p.lng }]
				);

			const seen = new Set<string>();
			const points = [...anchors, ...stops].filter((p) => {
				const key = `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;
				if (seen.has(key)) return false;
				seen.add(key);
				return true;
			});
			return { points, departAt: day.start.toISOString() };
		});

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
		const loose = pois.filter((p) => p.day_index === null).map((p) => ({ lat: p.lat, lng: p.lng }));
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
		refreshCurves();
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
		new Set((fresh ?? toPlannedDays(stored, days)).flatMap((d) => d.stops.map((s) => s.poiId)))
	);

	const unplaced = $derived<Unplaced[]>(
		pois
			.filter((p) => !planned.has(p.id))
			.map((p) => ({ poi: toPlanPoi(p), reason: reasonFor(p) }))
	);

	/**
	 * The plan on screen is the plan that was stored, not one re-derived on
	 * load. Re-running the scheduler here would silently re-time a settled trip
	 * whenever a provider answered differently or the page was opened on
	 * another day.
	 */
	const result = $derived<PlanResult | null>(
		row && days.length
			? { days: fresh ?? toPlannedDays(stored, days), unplaced }
			: null
	);

	/** How far the plan is behind the wishlist. */
	const stale = $derived(planAt ? staleCount(pois, planAt) : 0);

	const current = $derived(result?.days[dayIndex] ?? null);

	/**
	 * When the held card would land, while it is being held over a stop.
	 *
	 * The stop it is dropped onto is the moment it takes: that is what the
	 * mark on the line says, before anything is written.
	 */
	const dropAt = $derived.by(() => {
		const target = drag.state.target;
		if (!target || target.kind !== 'stop' || !current) return null;
		return current.stops.find((st) => st.poiId === target.id)?.arrive ?? null;
	});

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
	 * A manual move runs steps 3-5 only -- the traveller has just stated the
	 * assignment and the order, and re-clustering would undo the drag.
	 */
	async function applyMove(draggedId: string, target: Parameters<typeof reorder>[2]) {
		if (draggedId.startsWith(SLOT_DRAG)) return moveSlot(draggedId, target);

		// Order the move the way the traveller sees it. A stop's stored order is
		// what the planner was last given, not what it decided: the day on
		// screen has since been routed, re-timed and threaded with meals. Read
		// in stored order, a drop onto the third card landed in some unrelated
		// place -- which is what made moving a card look random.
		const seen = new Map<string, { day: number; rank: number }>();
		(result?.days ?? []).forEach((d, day) => {
			let rank = 0;
			for (const st of d.stops) if (st.poiId) seen.set(st.poiId, { day, rank: rank++ });
		});

		const rows = reorder(
			pois.map((p) => ({
				id: p.id,
				dayIndex: seen.get(p.id)?.day ?? p.day_index,
				orderIndex: seen.get(p.id)?.rank ?? p.order_index
			})),
			draggedId,
			target
		);
		if (!rows.length) return;

		// Held by the drag. Dropped onto a card that states an order and nothing
		// more: minting a time from where the card happened to land would stop
		// the next refinement sliding the stop when a leg turns out longer, and
		// it would warn about a time nobody chose.
		//
		// Dropped into an opened gap it is different: the gap is drawn to scale,
		// so letting go two thirds of the way down a free afternoon is the
		// traveller saying when, and the plan should hold it there.
		const held =
			target?.kind === 'gap' ? { pinned: true, pinned_at: target.at } : { pinned: true };

		// Follow the stop to its new day. Without this it simply vanishes from
		// the day on screen and the move looks like a deletion.
		const landedOn = rows.find((r) => r.id === draggedId)?.dayIndex;
		if (landedOn !== null && landedOn !== undefined) dayIndex = landedOn;

		const byId = new Map(rows.map((r) => [r.id, r]));
		pois = pois.map((p) => ({
			...p,
			...(byId.has(p.id)
				? { day_index: byId.get(p.id)!.dayIndex, order_index: byId.get(p.id)!.orderIndex }
				: {}),
			...(p.id === draggedId ? held : {})
		}));

		// Show the move now, from what is already known. The same scheduler the
		// round trips will run, on the travel times already in hand: the card
		// lands under the finger instead of after a write, a re-time and a call
		// to a routing service.
		const input = planInput();
		if (input) fresh = schedule({ ...input, travel: known() }).days;

		try {
			await saveAssignments(rows);
			await updatePoi(draggedId, held);
			// Refine in the background: real road times may shift the day by a
			// few minutes, and that is not worth a frozen screen.
			await restore();
		} catch (e) {
			error = (e as Error).message;
			pois = await listPois(tripId);
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
	async function moveSlot(draggedId: string, target: Parameters<typeof reorder>[2]) {
		if (!target || target.kind !== 'stop') return;
		const [, rawDay, meal] = draggedId.split(':');
		const day = Number(rawDay);
		const landed = result?.days[day]?.stops.find((st) => st.poiId === target.id);
		if (!landed) return;
		await sayMeal(day, meal as MealName, { at: landed.arrive.toISOString() });
	}

	/**
	 * Re-time the plan after a manual move -- steps 3-5 only, since the
	 * traveller has just stated the assignment and the order. The stored plan
	 * is the plan of record, so a drag has to be written back to it or the
	 * move survives only until the page reloads.
	 */
	/**
	 * One re-time at a time.
	 *
	 * Two of these overlapping is what duplicated every stop on the plan: both
	 * read the same state, both wrote it, and the second wrote a plan built
	 * from what the first had already changed. A second caller waits for the
	 * first and then runs on the settled state.
	 */
	let timing: Promise<void> | null = null;

	async function restore(opts: { hold?: string } = {}): Promise<void> {
		const previous = timing;
		const mine = (async () => {
			if (previous) await previous.catch(() => {});
			await retime(opts);
		})();
		timing = mine;
		try {
			await mine;
		} finally {
			if (timing === mine) timing = null;
		}
	}

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

	/** The trip as the scheduler wants it told. */
	function planInput() {
		if (!row || !days.length) return null;
		return {
			pois: pois.map(toPlanPoi),
			days,
			allowedModes: row.allowed_modes as Mode[],
			timezone: row.timezone,
			mealWindows: agreed.windows,
			curves,
			meals: mealPlan
		};
	}

	async function retime(opts: { hold?: string } = {}) {
		const input = planInput();
		if (!input) return;
		// Scheduled on what is already known, and written straight away. The
		// legs this invents are estimates, marked as such on screen; the real
		// times are asked for afterwards and arrive on their own.
		const next = schedule({ ...input, travel: known() });
		fresh = next.days;
		planAt = await savePlan(tripId, next, stored);

		// A stop the day could not reach has to give up its day, or it belongs
		// to neither place: absent from the plan because it did not fit, and
		// absent from the wishlist because it still claims a day. That is how
		// a restaurant added to a full evening disappeared without a word.
		// Whatever the traveller just moved keeps the moment the plan gave it.
		if (opts.hold) {
			const at = next.days
				.flatMap((d) => d.stops)
				.find((st) => st.poiId === opts.hold)?.arrive;
			if (at) {
				await updatePoi(opts.hold, { pinned: true, pinned_at: at.toISOString() });
				pois = pois.map((p) =>
					p.id === opts.hold ? { ...p, pinned: true, pinned_at: at.toISOString() } : p
				);
			}
		}

		const stranded = next.unplaced
			.filter((u) => !u.poi.pinned)
			.filter((u) => pois.find((p) => p.id === u.poi.id)?.day_index !== null)
			.map((u) => ({ id: u.poi.id, dayIndex: null, orderIndex: null }));
		if (stranded.length) {
			await saveAssignments(stranded);
			pois = await listPois(tripId);
		}
		stored = await loadPlan(tripId);
		// The plan is the traveller's; how long its journeys take is the
		// server's to find out. Not awaited: the answers come back through the
		// subscription below, whether or not this tab is still open.
		void refineTrip(tripId);
	}

	/** What a meal container is called while it is being dragged. */
	const SLOT_DRAG = 'meal:';

	const drag = createDrag((id, target) => applyMove(id, target));

	/**
	 * A stop that has a day but no place in the stored plan -- added into a slot
	 * on the last screen. Re-time once so it appears where it was put, without
	 * making the traveller tap Replan for a stop they have already placed.
	 */
	let retimed = false;
	$effect(() => {
		if (retimed || busy || !row || !days.length || !stored.length) return;

		// A plan made by an older planner. Asking the traveller to tap Replan
		// because the app changed underneath them is the app's problem.
		const stale = (row.plan_version ?? 0) < PLANNER_VERSION;

		const inPlan = new Set(stored.map((r) => r.poi_id).filter(Boolean));
		const placedButUnplanned = pois.some((p) => p.day_index !== null && !inPlan.has(p.id));

		if (!stale && !placedButUnplanned) return;
		retimed = true;
		restore().catch((e) => (error = (e as Error).message));
	});

	async function togglePin(poiId: string) {
		const current = pois.find((p) => p.id === poiId);
		if (!current) return;
		const next = !current.pinned;
		pois = pois.map((p) => (p.id === poiId ? { ...p, pinned: next } : p));
		try {
			await updatePoi(poiId, { pinned: next });
		} catch (e) {
			error = (e as Error).message;
			pois = pois.map((p) => (p.id === poiId ? { ...p, pinned: !next } : p));
		}
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
		if (!row || !zoneShouldBe) return;
		busy = true;
		try {
			row = await repairTimezone(row, zoneShouldBe);
		} catch (e) {
			error = (e as Error).message;
		} finally {
			busy = false;
		}
	}

	const pinnedIds = $derived(new Set(pois.filter((p) => p.pinned).map((p) => p.id)));

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
			(fresh ?? toPlannedDays(stored, days)).flatMap((d) =>
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
		const day = (fresh ?? toPlannedDays(stored, days))[here.day];
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
		if (!slot || !row || !blockName.trim()) return;
		const target = slot;
		const name = blockName.trim();
		const minutes = blockMin;
		slot = null;
		blockName = '';
		busy = true;
		try {
			const created = await addPoi(tripId, {
				name,
				label: '',
				// The coordinates are a formality: the planner puts a block
				// wherever the traveller already is. The hotel is the honest
				// stand-in for a day that has not started yet.
				lat: row.hotel_lat,
				lng: row.hotel_lng,
				category: BLOCK_CATEGORY,
				durationMin: minutes,
				openingHours: null,
				website: null,
				phone: null,
				osmId: null
			});
			pois = [...pois, created];
			// Pinned: the traveller put it at a particular point in the day, and
			// a block has no geography for Regenerate to reason about.
			await updatePoi(created.id, { pinned: true });
			await placeInto(created.id, target);
		} catch (e) {
			error = (e as Error).message;
			busy = false;
		}
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
		busy = true;

		if (!source || !dayOfPoi.has(poiId)) {
			await placeInto(poiId, target);
			return;
		}

		try {
			const copy = await addPoi(tripId, {
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
			pois = [...pois, copy];
			await placeInto(copy.id, target);
		} catch (e) {
			error = (e as Error).message;
			busy = false;
		}
	}

	async function placeInto(
		poiId: string,
		target: { day: number; before: string | null; at?: string }
	) {
		try {
			const rows = insertInto(
				pois.map((p) => ({ id: p.id, dayIndex: p.day_index, orderIndex: p.order_index })),
				poiId,
				target.day,
				target.before
			);
			await saveAssignments(rows);
			// Pinned before the plan is worked out, not after: the scheduler has
			// to already know this one is the traveller's, or it drops it for not
			// fitting and the reconciliation then takes its day away -- which is
			// how a restaurant placed into a full evening vanished again.
			//
			// Dropped into an opened gap, it is pinned to the moment that was
			// touched: the gap is drawn to scale, so the tap said a time and not
			// merely a position in the order.
			await updatePoi(poiId, target.at ? { pinned: true, pinned_at: target.at } : { pinned: true });
			pois = await listPois(tripId);
			dayIndex = target.day;
			await restore({ hold: poiId });
		} catch (e) {
			error = (e as Error).message;
		} finally {
			busy = false;
		}
	}

	/**
	 * The day and order replan settled, written back onto the stops so the
	 * second pass re-times that same plan rather than reshuffling it.
	 */
	function assignedFrom(planned: PlanResult) {
		const placed = new Map(
			planned.days.flatMap((d) =>
				d.stops
					.filter((s) => s.poiId)
					.map((s, i) => [s.poiId!, { dayIndex: d.index, orderIndex: i }] as const)
			)
		);
		return pois.map((p) => ({
			...toPlanPoi(p),
			dayIndex: placed.get(p.id)?.dayIndex ?? null,
			orderIndex: placed.get(p.id)?.orderIndex ?? null
		}));
	}

	async function doReplan() {
		if (!row || !days.length) return;
		busy = true;
		error = null;
		try {
			const input = {
				pois: pois.map(toPlanPoi),
				days,
				allowedModes: row.allowed_modes as Mode[],
				timezone: row.timezone,
				mealWindows: agreed.windows,
				curves,
				meals: mealPlan
			};
			// The matrix prices every pair the ordering might need. This is the
			// one thing worth paying for up front: which stops share a day, and
			// in what order, cannot be decided on guesses.
			step = 'Measuring…';
			await refreshTravel();

			const ordered = replan({ ...input, travel });

			step = 'Saving…';
			const next = schedule({
				...input,
				pois: assignedFrom(ordered),
				travel: known()
			});

			const assignments = next.days.flatMap((d) =>
				d.stops.filter((s) => s.poiId).map((s, i) => ({ id: s.poiId!, dayIndex: d.index, orderIndex: i }))
			);
			// A pin the clock could not reach keeps its day anyway. Clearing it
			// would quietly undo the pin, and the traveller would find the stop
			// back in the wishlist with no idea why.
			const cleared = next.unplaced
				.filter((u) => !u.poi.pinned)
				.map((u) => ({ id: u.poi.id, dayIndex: null, orderIndex: null }));
			await saveAssignments([...assignments, ...cleared]);
			planAt = await savePlan(tripId, next, stored);
			fresh = next.days;
			pois = await listPois(tripId);
			// Without this the stored rows stay a plan behind, and the effect
			// that re-times a newly placed stop fires on a phantom difference.
			stored = await loadPlan(tripId);
			// The legs the ordering ran on are matrix estimates. Ask for the
			// real ones; they arrive on their own.
			void refineTrip(tripId);
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
				await setShareToken(tripId, token);
				shareUrl = linkFor(token);
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
			await setMemberRole(tripId, person.userId, next);
			people = people.map((p) => (p.userId === person.userId ? { ...p, role: next } : p));
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
			await removeMember(tripId, person.userId);
			people = people.filter((p) => p.userId !== person.userId);
		} catch (e) {
			error = (e as Error).message;
		} finally {
			roleBusy = null;
		}
	}

	async function revoke() {
		try {
			await setShareToken(tripId, null);
			shareUrl = null;
		} catch (e) {
			error = (e as Error).message;
		}
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
		try {
			await updateHotel(tripId, h);
			row = await getTrip(tripId);
		} catch (e) {
			error = (e as Error).message;
		}
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
		new Intl.DateTimeFormat(undefined, { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);

	const dayLabel = (iso: string, tz: string) =>
		new Intl.DateTimeFormat(undefined, { timeZone: tz, weekday: 'short', day: 'numeric' }).format(
			new Date(`${iso}T12:00:00Z`)
		);

	const stamp = (iso: string, tz: string) =>
		new Intl.DateTimeFormat(undefined, {
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
						? ['Getting there', describeJourney(row.arrival_legs)]
						: null,
					row.arrival_booking_ref ? ['Arrival booking', row.arrival_booking_ref] : null,
					['Departure', stamp(row.departure_at, row.timezone)],
					describeJourney(row.departure_legs ?? [])
						? ['Getting home', describeJourney(row.departure_legs)]
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
	{#if loading}
		<p class="p-6" style="color: var(--tm-text-faint)">Loading…</p>
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
				<button role="tab" aria-selected={view === 'board'} onclick={() => (view = 'board')}>Board</button>
				<button role="tab" aria-selected={view === 'map'} onclick={() => (view = 'map')}>Map</button>
				<button role="tab" aria-selected={view === 'wishlist'} onclick={() => (view = 'wishlist')}>List</button>
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

		{#if view === 'board'}
			<div class="min-h-0 min-w-0 flex-1 overflow-hidden">
				{#if !pois.length}
					<div class="tm-card m-4" style="background: var(--tm-surface-2)">
						<p class="tm-card__title">Nothing to plan yet</p>
						<p class="tm-card__meta">Add some places and the days will arrange themselves.</p>
					</div>
				{:else if result}
					<PlanBoard
						{days}
						planned={result.days}
						timezone={row.timezone}
						{dayColor}
						{drag}
						pinned={pinnedIds}
						onpick={(id) => (carded = pois.find((p) => p.id === id) ?? null)}
						onhold={(id) => (carded = pois.find((p) => p.id === id) ?? null)}
						onpin={(id) => togglePin(id)}
						onholdanchor={(stop, dayIdx) =>
							stop.anchorKind === 'meal' ? holdMeal(stop, dayIdx) : holdAllowance(stop, dayIdx)}
						onmovemeal={(stop, dayIdx, minutes) => moveMeal(stop, dayIdx, minutes)}
						onfillmeal={(stop, dayIdx) =>
							(slot = { day: dayIdx, before: null, meal: stop.name })}
						onadd={(dayIdx, beforeId) => (slot = { day: dayIdx, before: beforeId })}
					/>
				{/if}
			</div>
		{:else if view === 'map'}
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
						<button
							class="tm-result"
							style="align-items: center; color: inherit"
							onclick={() => (carded = p)}
						>
							<span style="display: flex; gap: 10px; align-items: flex-start">
								<span
									style="width:12px;height:12px;border-radius:50%;margin-top:4px;flex:none;background:{colorOf(p.id)}"
								></span>
								<span>
									<span style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
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
							>
								<DayLine
									day={within ? (result?.days[i] ?? null) : null}
									window={within ? days[i] : null}
									timezone={row.timezone}
									dayColor={dayColor(within ? i : dayIndex)}
									kind={offset === 0 ? 'here' : within ? 'neighbour' : 'stub'}
									label={offset === 0 || !within ? null : dayLabel(days[i].date, row.timezone)}
									lit={drag.state.target?.kind === 'day' && drag.state.target.index === i}
									marker={offset === 0 ? dropAt : null}
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
					{#each current.stops as stop, i (stop.name + i)}
						<!-- A meal container drags as itself: it owns no row in the
						     wishlist, so its name while held is its day and its meal. -->
						{@const grabId = !canEdit
							? null
							: stop.anchorKind === 'meal'
								? `${SLOT_DRAG}${dayIndex}:${mealFor(stop) ?? ''}`
								: stop.poiId}
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
						<div
							class="tm-stop"
							class:tm-stop--anchor={stop.anchor}
							class:tm-stop--terminal={stop.anchorKind === 'terminal'}
							class:tm-stop--service={stop.anchorKind === 'service'}
							class:tm-stop--chore={stop.anchorKind === 'chore'}
							class:tm-stop--meal={stop.anchorKind === 'meal'}
							data-drop-stop={stop.poiId ?? undefined}
							{@attach stop.poiId
								? longPress(() => (carded = pois.find((p) => p.id === stop.poiId) ?? null))
								: stop.anchorKind === 'meal'
									? longPress(() => holdMeal(stop, dayIndex))
									: allowanceOf(stop, dayIndex)
										? longPress(() => holdAllowance(stop, dayIndex))
										: () => {}}
							style={grabId && drag.state.id === grabId
								? 'opacity:0.35'
								: stop.poiId &&
									  drag.state.target?.kind === 'stop' &&
									  drag.state.target.id === stop.poiId
									? 'outline:2px solid var(--tm-primary);outline-offset:-1px'
									: ''}
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
								<span class="tm-stop__from">{t.from}</span>
								<span class="tm-stop__to">{t.to}</span>
							</span>
							<div>
								<p class="tm-stop__name">
									{#if stop.poiId}
										<button
											class="tm-stop__open"
											onclick={() => (carded = pois.find((p) => p.id === stop.poiId) ?? null)}
										>{stop.name}</button>
									{:else if stop.anchorKind === 'meal'}
										{@const after = current.stops.slice(i + 1).find((x) => x.poiId)}
										<button
											class="tm-stop__open"
											onclick={() =>
												(slot = { day: dayIndex, before: after?.poiId ?? null, meal: stop.name })}
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
									{#if stop.poiId}
										{@const held = pinnedIds.has(stop.poiId)}
										<button
											class="tm-pin"
											class:tm-pin--on={held}
											aria-pressed={held}
											title={held ? 'Replan may not move this' : 'Hold this where it is'}
											onclick={() => togglePin(stop.poiId!)}
										>
											<svg width="11" height="11" viewBox="0 0 24 24" fill={held ? 'currentColor' : 'none'}
												stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
												<path d="M12 17v5M9 3h6l-1 6 3 3v2H7v-2l3-3z" />
											</svg>
											{held ? 'Pinned' : 'Pin'}
										</button>
									{/if}
								</p>
								{#each stop.warnings as w (w.kind)}
									<div class="mt-2"><span class="tm-chip tm-chip--warn">{w.message}</span></div>
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
								day={dayIndex}
								before={following?.poiId ?? null}
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
			{@const said = mealPlan.get(mealKey(m.day, m.meal))}
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
							onclick={() => setAllowance(a.kind, m)}
						>
							{m === 0 ? 'none' : m < 60 ? `${m} min` : `${m / 60} h`}
						</button>
					{/each}
				</div>
				<p class="tm-hint mt-2">
					{a.kind === 'prep'
						? 'Changes your own profile, so it carries to every trip.'
						: 'Changes this trip.'}
				</p>
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
				onremove={() => forget(carded!.id)}
				onclose={() => (carded = null)}
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
					<div class="flex flex-col gap-1" style="margin: 0 calc(-1 * var(--tm-space-2))">
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

				<p class="tm-hint mt-4 mb-2">Or a stretch of time</p>
				<div class="tm-field">
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

				{#if missingMeals.length}
					<p class="tm-hint mt-4 mb-2">Or a meal this day has not got</p>
					<div class="flex flex-wrap gap-2">
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
			<div
				aria-hidden="true"
				style="position:fixed;left:{drag.state.x}px;top:{drag.state.y}px;transform:translate(-50%,-140%);
				pointer-events:none;z-index:50;background:var(--tm-surface);border:1px solid var(--tm-primary);
				border-radius:var(--tm-r-md);padding:6px 12px;font:600 var(--tm-text-sm)/1 var(--tm-font);
				box-shadow:0 6px 20px rgba(0,0,0,0.18)"
			>
				{drag.state.id.startsWith(SLOT_DRAG)
					? MEAL_LABEL[drag.state.id.split(':')[2] as MealName]
					: (pois.find((p) => p.id === drag.state.id)?.name ?? 'Moving')}
			</div>
			<p
				class="tm-hint"
				style="position:fixed;left:0;right:0;bottom:84px;text-align:center;z-index:50;pointer-events:none"
			>
				Drop on another stop to reorder, or on a day to move it
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
