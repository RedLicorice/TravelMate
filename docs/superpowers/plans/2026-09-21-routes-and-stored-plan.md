# Real Transit Times and the Stored Plan — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ordering runs on real timetabled transit times, and the plan becomes a stored artifact that Regenerate produces rather than a view that recomputes on every page load.

**Architecture:** A `travel` Edge Function holds `GOOGLE_MAPS_KEY` and answers all-pairs travel for one day at a time via `computeRouteMatrix`, caching every element in Postgres. The client resolves a day's matrix before planning and hands the planner a plain table, exactly as busyness already works. Regenerate then writes `plan_stops`; every view reads it.

**Tech Stack:** Supabase Edge Functions (Deno), Postgres, SvelteKit 2 / Svelte 5, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-21-providers-and-handoff-design.md`

## Global Constraints

- `GOOGLE_MAPS_KEY` and `FOURSQUARE_KEY` live in Supabase Edge Function secrets and must never reach the browser, the repository, or a migration.
- Migration SQL is stored in `supabase_migrations.schema_migrations` as well as in git, and this repository is public. No secret goes in one.
- The planner stays pure and synchronous. Anything networked resolves ahead of it.
- Every provider chain ends in something local that always answers. A provider being down degrades the plan; it never breaks it.
- Transit matrices are capped at 100 elements. One day at a time keeps every request inside that by construction.
- Existing behaviour must survive: 151 tests pass today and must still pass.

## Prerequisites (human, once)

1. Google Cloud: enable **Routes API** and **Places API (New)**. Restrict the key to those two. No IP restriction — Edge Functions have no stable egress IP.
2. Set a budget alert and per-API quota caps.

---

### Task 1: Schema

**Files:**
- Create: `supabase/migrations/0010_travel_and_plan.sql`

**Interfaces:**
- Produces: tables `travel_cache`, `plan_stops`; both RLS'd to trip members.

- [ ] **Step 1: Write the migration**

```sql
-- Cached travel between two points, for one mode, at one departure band.
--
-- Keyed by rounded coordinates rather than place ids: the same journey is the
-- same journey whether its endpoints are a POI, a hotel or an airport, and
-- anchors have no poi row to key on.
create table travel_cache (
  from_key      text not null,          -- "51.51083,-0.13952"
  to_key        text not null,
  mode          text not null check (mode in ('walk','bike','transit','car','carshare')),
  -- Local hour band the journey starts in, or 'any' for modes whose duration
  -- does not depend on when you set off.
  depart_bucket text not null,
  minutes       int not null check (minutes >= 0),
  km            numeric not null check (km >= 0),
  source        text not null check (source in ('google','valhalla')),
  observed_at   timestamptz not null default now(),
  expires_at    timestamptz not null,
  primary key (from_key, to_key, mode, depart_bucket)
);

-- Readable by any signed-in traveller: it is derived public geography, not
-- anybody's trip. Writes come from the Edge Function under the service role,
-- which bypasses RLS, so no write policy is granted here.
alter table travel_cache enable row level security;
create policy travel_cache_read on travel_cache
  for select to authenticated using (true);

create index travel_cache_expiry on travel_cache (expires_at);

-- The plan itself: what Regenerate produced.
create table plan_stops (
  id           uuid primary key default gen_random_uuid(),
  trip_id      uuid not null references trips on delete cascade,
  day_index    int not null,
  order_index  int not null,
  -- Null for anchors: the hotel and the terminals are not wishlist rows.
  poi_id       uuid references pois on delete cascade,
  name         text not null,
  lat          double precision not null,
  lng          double precision not null,
  anchor       boolean not null default false,

  starts_at    timestamptz not null,
  -- Not always starts_at + duration: a meal waits for its window, and the end
  -- of the day truncates.
  ends_at      timestamptz not null,
  duration_min int not null default 0,
  -- A time the traveller fixed. The planner honours it rather than moving it.
  pinned       boolean not null default false,

  leg_mode     text,
  leg_minutes  int,
  leg_km       numeric,
  leg_detail   jsonb,
  warnings     jsonb not null default '[]'::jsonb,

  generated_at timestamptz not null default now(),
  constraint plan_stops_ordered check (ends_at >= starts_at)
);

create index plan_stops_trip_day on plan_stops (trip_id, day_index, order_index);

alter table plan_stops enable row level security;
create policy plan_stops_member_all on plan_stops
  for all using (is_trip_member(trip_id)) with check (is_trip_member(trip_id));

-- When the plan was last produced, so the app can say how far behind it is.
alter table trips add column plan_generated_at timestamptz;
```

- [ ] **Step 2: Apply and verify**

Run: `supabase db push --dry-run` then `supabase db push --yes`
Then verify RLS denies an anonymous reader:

```bash
curl -s -w " [%{http_code}]\n" "$URL/rest/v1/plan_stops?select=id" -H "apikey: $KEY" -H "Authorization: Bearer $KEY"
```
Expected: `[] [200]` — filtered, not errored.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0010_travel_and_plan.sql
git commit -m "feat: travel cache and stored plan schema"
```

---

### Task 2: The travel Edge Function

**Files:**
- Create: `supabase/functions/travel/index.ts`, `supabase/functions/_shared/cors.ts`

**Interfaces:**
- Consumes: `GOOGLE_MAPS_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (both from the function environment).
- Produces: `POST /functions/v1/travel` taking `{ points: LatLng[], mode, departAt }` and returning `{ cells: { from, to, minutes, km, source }[] }`.

- [ ] **Step 1: Write the shared CORS header**

```ts
// supabase/functions/_shared/cors.ts
export const cors = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
```

- [ ] **Step 2: Write the function**

```ts
// supabase/functions/travel/index.ts
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { cors } from '../_shared/cors.ts';

type LatLng = { lat: number; lng: number };
type Mode = 'walk' | 'bike' | 'transit' | 'car' | 'carshare';

const MATRIX = 'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix';

/** Google's travel modes. carshare is a car you do not own. */
const TRAVEL_MODE: Record<Mode, string> = {
	walk: 'WALK', bike: 'BICYCLE', transit: 'TRANSIT', car: 'DRIVE', carshare: 'DRIVE'
};

/** Transit is capped at 100 elements; road modes at 625. */
const MAX_ELEMENTS: Record<string, number> = { TRANSIT: 100 };
const DEFAULT_MAX_ELEMENTS = 625;

const key = (p: LatLng) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;

/**
 * Journeys are cached per departure hour, because a transit journey at 08:00
 * is a different journey from the same one at 23:00. Modes that do not care
 * share one bucket rather than storing 24 identical rows.
 */
const bucketOf = (mode: Mode, departAt: string | null) =>
	mode === 'transit' && departAt ? `h${new Date(departAt).getUTCHours()}` : 'any';

const TTL_DAYS: Record<string, number> = { transit: 7, default: 30 };

Deno.serve(async (req) => {
	if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

	try {
		const { points, mode, departAt } = await req.json() as {
			points: LatLng[]; mode: Mode; departAt: string | null;
		};

		if (!Array.isArray(points) || points.length < 2) {
			return json({ cells: [] });
		}
		const travelMode = TRAVEL_MODE[mode] ?? 'WALK';
		const cap = MAX_ELEMENTS[travelMode] ?? DEFAULT_MAX_ELEMENTS;
		// Refusing is better than truncating: a partial matrix would look like
		// a complete one and quietly mis-order a day.
		if (points.length * points.length > cap) {
			return json({ cells: [], error: 'too_many_points' });
		}

		const bucket = bucketOf(mode, departAt);
		const db = createClient(
			Deno.env.get('SUPABASE_URL')!,
			Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
		);

		// 1. What do we already know?
		const keys = points.map(key);
		const { data: cached } = await db
			.from('travel_cache')
			.select('from_key,to_key,minutes,km,source')
			.eq('mode', mode)
			.eq('depart_bucket', bucket)
			.gt('expires_at', new Date().toISOString())
			.in('from_key', keys)
			.in('to_key', keys);

		const have = new Map((cached ?? []).map((c) => [`${c.from_key}>${c.to_key}`, c]));
		const complete = keys.every((f) => keys.every((t) => f === t || have.has(`${f}>${t}`)));
		if (complete) return json({ cells: [...have.values()].map(shape) });

		// 2. Ask Google for the whole matrix. Asking for only the missing pairs
		//    would cost the same -- billing is per element requested -- and a
		//    full matrix keeps the cache coherent.
		const body: Record<string, unknown> = {
			origins: points.map((p) => ({ waypoint: { location: { latLng: { latitude: p.lat, longitude: p.lng } } } })),
			destinations: points.map((p) => ({ waypoint: { location: { latLng: { latitude: p.lat, longitude: p.lng } } } })),
			travelMode
		};
		// departureTime is required for TRANSIT and meaningless without it.
		// routingPreference is a DRIVE-only field and is rejected on TRANSIT.
		if (travelMode === 'TRANSIT') body.departureTime = departAt ?? new Date().toISOString();

		const res = await fetch(MATRIX, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Goog-Api-Key': Deno.env.get('GOOGLE_MAPS_KEY')!,
				'X-Goog-FieldMask': 'originIndex,destinationIndex,duration,distanceMeters,condition'
			},
			body: JSON.stringify(body)
		});
		if (!res.ok) {
			// The caller has a fallback chain. Saying so beats a 500 that stops
			// the trip rendering.
			return json({ cells: [...have.values()].map(shape), error: `routes_${res.status}` });
		}

		const elements = await res.json() as {
			originIndex: number; destinationIndex: number;
			duration?: string; distanceMeters?: number; condition?: string;
		}[];

		const ttl = TTL_DAYS[mode] ?? TTL_DAYS.default;
		const expires = new Date(Date.now() + ttl * 86400_000).toISOString();

		const rows = elements
			.filter((e) => e.condition === 'ROUTE_EXISTS' && e.originIndex !== e.destinationIndex)
			.map((e) => ({
				from_key: keys[e.originIndex],
				to_key: keys[e.destinationIndex],
				mode,
				depart_bucket: bucket,
				minutes: Math.round(Number(String(e.duration ?? '0s').replace('s', '')) / 60),
				km: Math.round((e.distanceMeters ?? 0) / 100) / 10,
				source: 'google',
				expires_at: expires
			}))
			.filter((r) => r.minutes > 0);

		if (rows.length) await db.from('travel_cache').upsert(rows);
		return json({ cells: rows.map(shape) });
	} catch (error) {
		return json({ cells: [], error: String(error) });
	}
});

const shape = (r: { from_key: string; to_key: string; minutes: number; km: number; source?: string }) =>
	({ from: r.from_key, to: r.to_key, minutes: r.minutes, km: Number(r.km), source: r.source ?? 'google' });

const json = (body: unknown) =>
	new Response(JSON.stringify(body), { headers: { ...cors, 'Content-Type': 'application/json' } });
```

- [ ] **Step 3: Deploy and smoke-test**

Run: `supabase functions deploy travel`
Then, with a signed-in anon key:

```bash
curl -s -X POST "$URL/functions/v1/travel" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"points":[{"lat":51.8860,"lng":0.2389},{"lat":51.5145,"lng":-0.1270}],"mode":"transit","departAt":"2026-04-10T08:00:00Z"}'
```
Expected: a `cells` array with one entry each way, `minutes` around 60–90 — not 222.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions
git commit -m "feat: travel edge function on Routes API, cached per departure hour"
```

---

### Task 3: Client uses the function

**Files:**
- Modify: `src/lib/plan/travel.ts`
- Modify: `src/routes/trip/[id]/+page.svelte`
- Test: `src/lib/plan/travel.test.ts`

**Interfaces:**
- Produces: `resolveTravel(points, modes, departAt)` unchanged in shape, Google-first.

- [ ] **Step 1: Write the failing test**

```ts
it('prefers a Google cell over the local estimate', async () => {
	const table = tableFrom([{ from: '51.88600,0.23890', to: '51.51450,-0.12700', minutes: 65, km: 57.2, source: 'google' }]);
	expect(table.get({ lat: 51.886, lng: 0.2389 }, { lat: 51.5145, lng: -0.127 }, 'transit'))
		.toEqual({ minutes: 65, km: 57.2 });
});

it('does not apply the transit band to a Google transit answer', async () => {
	// Google already routed the train. Running transitFrom over it would add a
	// connection allowance to a figure that already includes the connections.
	const table = tableFrom([{ from: '51.88600,0.23890', to: '51.51450,-0.12700', minutes: 65, km: 57.2, source: 'google' }]);
	expect(table.get({ lat: 51.886, lng: 0.2389 }, { lat: 51.5145, lng: -0.127 }, 'transit')!.minutes).toBe(65);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/lib/plan/travel.test.ts`
Expected: FAIL — `tableFrom` is not exported.

- [ ] **Step 3: Implement**

Export `tableFrom(cells)` building a `TravelTable` from function cells, and have `resolveTravel` call the Edge Function first, falling back to the existing Valhalla matrix and then to `haversineLeg`. The transit band in `transitFrom` applies only to the Valhalla path — a Google transit figure already includes its connections.

- [ ] **Step 4: Resolve per day in the page**

`refreshTravel()` currently pools every point in the trip. Change it to resolve one matrix per day, passing that day's start as `departAt`, which keeps every request inside the 100-element transit cap by construction and removes the 20-point fallback.

- [ ] **Step 5: Verify and commit**

Run: `npm test && npx svelte-check --tsconfig ./tsconfig.json`

---

### Task 4: The plan is stored

**Files:**
- Create: `src/lib/trip/plan.ts`, `src/lib/trip/plan.test.ts`
- Modify: `src/routes/trip/[id]/+page.svelte`, `src/routes/shared/[token]/+page.svelte`

**Interfaces:**
- Produces:
  - `type PlanStopRow`
  - `savePlan(tripId, result, days): Promise<void>` — replaces the trip's plan in one transaction-shaped write
  - `loadPlan(tripId): Promise<PlanStopRow[]>`
  - `toPlannedDays(rows): PlannedDay[]` — pure, tested
  - `staleCount(pois, planGeneratedAt): number` — pure, tested

- [ ] **Step 1: Write the failing tests**

```ts
describe('toPlannedDays', () => {
	it('groups rows into days in order', () => { /* ... */ });
	it('rebuilds the leg that led into each stop', () => { /* ... */ });
	it('returns nothing for a trip with no stored plan', () => {
		expect(toPlannedDays([])).toEqual([]);
	});
});

describe('staleCount', () => {
	it('counts places added since the plan was made', () => { /* ... */ });
	it('counts a place edited since the plan was made', () => { /* ... */ });
	it('is zero when the plan is newer than everything', () => { /* ... */ });
	it('treats a trip with no plan as entirely stale', () => { /* ... */ });
});
```

- [ ] **Step 2: Implement, then switch the views to read stored rows**

Regenerate writes `plan_stops` and `trips.plan_generated_at`; the Day, Board, Map and shared views all read them. `schedule()` stops running on page load — which is what removes the silent re-timing.

- [ ] **Step 3: Staleness indicator**

Show `staleCount` once, beside Regenerate: *"3 changes since this plan was made"*. Not per stop — the wishlist already says that per stop.

- [ ] **Step 4: Verify and commit**

---

### Task 5: Rename Replan to Regenerate

**Files:**
- Modify: `src/routes/trip/[id]/+page.svelte`, `src/lib/plan/planner.ts` (REASON_TEXT)

- [ ] **Step 1: Rename the control and every user-facing mention**

`REASON_TEXT['not-planned-yet']` says "Tap Replan to fit it in" and must change with it.

- [ ] **Step 2: Verify no user-facing "Replan" remains**

Run: `grep -rn "Replan" src/ --include=*.svelte --include=*.ts`
Expected: no matches.

---

## Done when

- A transit leg from an airport reads in the 60–90 minute range, not 222.
- Opening a trip does not change its times; only Regenerate does.
- A trip with more than 20 points still gets real travel times.
- The staleness line appears after adding a place and clears after Regenerate.
- `npm test` and `svelte-check` pass; the Pages deploy is green.

## Deliberately not in this plan

- Tier 2 per-leg itinerary detail (lines, departure times).
- Foursquare busyness.
- Maps handoff buttons, pinned times, live adjustment.
- The local scraper.
