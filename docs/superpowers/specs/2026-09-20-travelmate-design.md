# TravelMate — Design

Date: 2026-09-20
Status: Approved (brainstorming phase complete)

## Purpose

A PWA for someone visiting a city for a few days. They tell it where they're
arriving, which hotel they're in and when they fly out; they add the places they
want to see; it turns that pile of pins into a day-by-day schedule that
minimises movement and doesn't send them to a museum that's closed.

Serverless: Supabase for data and auth, static build on GitHub Pages.

## Scope

In build order, each phase independently shippable:

1. Skeleton, auth, trip CRUD
2. Map, POI search and capture
3. Planner and timeline
4. PWA and offline
5. Read-only share link
6. Realtime collaborative editing
7. Real routing via Edge Function
8. Live crowd data

Phases 1-5 are a complete product. Phase 6 onward are each droppable without
touching anything before them.

Out of scope: bookings, tickets, flights, budgets, reviews, photos, social
features.

## Stack

| Concern | Choice | Why |
| --- | --- | --- |
| Framework | SvelteKit, `adapter-static`, SPA fallback | Emits plain files; GitHub Pages serves them |
| UI | Svelte 5 runes, Tailwind v4 | |
| Map | Leaflet + OSM raster tiles | No API key, no account, ~40KB |
| Backend | Supabase (Postgres, Auth, Realtime, Edge Functions) | |
| Auth | Magic link email | No passwords stored; trips survive a cache clear |
| POI data | Nominatim (search), Overpass (category browse) | Free, keyless |
| Opening hours | `opening_hours.js` | The OSM format is not hand-parseable |
| PWA | `vite-plugin-pwa` | Generates manifest and service worker |

Four runtime dependencies through phase 6: `leaflet`, `opening_hours.js`,
`@supabase/supabase-js`, `vite-plugin-pwa`. The planner has none.

### POI provider seam

All POI lookup goes through one interface in `src/lib/poi/index.ts`:

```ts
search(query: string, near: LatLng): Promise<PoiResult[]>
browse(category: string, bbox: BBox): Promise<PoiResult[]>
```

Nominatim/Overpass implement it now. Swapping in Google Places later means one
new file and a changed import. No caller changes. Nominatim's usage policy caps
requests at roughly 1/sec, so search input is debounced 500ms and results are
cached per query string for the session.

## Data model

Two tables.

```sql
create table trips (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users on delete cascade,
  name          text not null,
  city          text not null,

  hotel_name    text not null,
  hotel_lat     double precision not null,
  hotel_lng     double precision not null,

  arrival_at    timestamptz not null,
  departure_at  timestamptz not null,

  -- Airport, station, port. Null means the trip simply starts at the hotel.
  arrival_point_name    text,
  arrival_point_lat     double precision,
  arrival_point_lng     double precision,
  departure_point_name  text,
  departure_point_lat   double precision,
  departure_point_lng   double precision,

  arrival_buffer_min    int not null default 45,   -- immigration, baggage
  departure_buffer_min  int not null default 120,  -- check-in, security
  bag_drop_min          int not null default 30,   -- 0 = travelling light

  allowed_modes text[] not null default '{walk,transit}',
  day_start     time not null default '09:00',
  day_end       time not null default '19:00',

  share_token   uuid unique,
  created_at    timestamptz not null default now(),

  check (departure_at > arrival_at),
  check (allowed_modes <@ '{walk,bike,transit,car,carshare}'::text[]),
  check (array_length(allowed_modes, 1) >= 1),
  check (num_nonnulls(arrival_point_lat, arrival_point_lng) <> 1),
  check (num_nonnulls(departure_point_lat, departure_point_lng) <> 1)
);

create table pois (
  id            uuid primary key default gen_random_uuid(),
  trip_id       uuid not null references trips on delete cascade,
  name          text not null,
  lat           double precision not null,
  lng           double precision not null,
  category      text,
  duration_min  int not null default 60,
  opening_hours text,
  osm_id        text,
  notes         text,
  day_index     int,
  order_index   int,
  created_at    timestamptz not null default now()
);

create index on pois (trip_id, day_index, order_index);
```

Decisions worth stating explicitly:

**A POI is its own plan assignment.** `day_index` and `order_index` live on the
POI row; `null` means unassigned, which is the wishlist. There is no
`plan_items` table because there is nothing a third table would hold that these
two columns don't.

**Arrival and departure clock times are never stored.** They are a pure function
of anchors, row order, durations and the day window, so the planner derives them
on read. Storing them would create a second source of truth that goes stale the
moment anyone drags a card.

**Arrival and departure are timestamps, not dates.** A traveller landing at
15:00 has a short first day, and one flying out at 10:00 has almost no last day.
Treating them as plain dates would schedule a full day around a flight.

**Airports are trip fields, not POIs.** They are anchors, not things you choose
to visit, and an airport 25km outside the city dropped into the clustering step
would drag a whole day's centroid into a field.

**Modes are a set, not a choice.** `allowed_modes` says what the traveller is
willing to use; the planner picks per leg. See Multimodal below.

### Security

RLS on both tables, owner-only:

- `trips`: `auth.uid() = user_id` for all commands.
- `pois`: same, resolved through `trip_id`.

The share link is deliberately **not** implemented as a
`using (share_token is not null)` select policy. That policy would let any
anonymous client select every shared trip in the database — the token would gate
nothing, because the client chooses its own `where` clause. Instead:

```sql
create function get_shared_trip(token uuid)
returns json
language sql
security definer
set search_path = public
as $$
  select json_build_object(
    'trip', to_json(t),
    'pois', coalesce((select json_agg(p order by p.day_index, p.order_index)
                      from pois p where p.trip_id = t.id), '[]'::json)
  )
  from trips t
  where t.share_token = token;
$$;

revoke all on function get_shared_trip(uuid) from public;
grant execute on function get_shared_trip(uuid) to anon;
```

Read-only, single-token, non-enumerable. The anonymous role is granted execute
on this function and nothing else.

Revoking a share link is setting `share_token` to null.

The Supabase publishable key is baked into the static build. This is how that key is
designed to be used; it identifies the project, it does not authorise anything.
RLS is the actual boundary. The service-role key never appears in the repo, the
build, or CI. Third-party API keys never reach the client at all — see Routing.

## Planner

`src/lib/planner.ts`. Pure: no network, no Supabase, no Svelte imports. Testable
in isolation, and fast enough to recompute on every drag rather than maintaining
incremental state.

```ts
plan(input: {
  pois: Poi[],
  days: Day[],
  allowedModes: Mode[]
}): { days: PlannedDay[], warnings: Warning[] }

type Day = {
  date: string,
  start: Date, end: Date,
  fixedStart: Waypoint[],   // where the day begins, in order
  fixedEnd: Waypoint[]      // where the day ends, in order
}
```

### Day anchors

Every day carries a fixed prefix and suffix. This one concept replaces what
would otherwise be special-cased handling of the first and last days:

| Day | `fixedStart` | `fixedEnd` |
| --- | --- | --- |
| First | arrival point → hotel (`bag_drop_min`) | hotel |
| Middle | hotel | hotel |
| Last | hotel | hotel (`bag_drop_min`) → departure point |

When `arrival_point` is null the first day is shaped like a middle day. Same for
departure.

The clock is clamped at both ends: the first day starts no earlier than
`arrival_at + arrival_buffer_min`, and the last day ends no later than
`departure_at − departure_buffer_min`. A 10:00 flight with a 120-minute buffer
gives a last day ending at 08:00, which schedules nothing — correctly.

Bag drop is mandatory, not optional routing: you cannot drag a suitcase around
the Colosseum. Setting `bag_drop_min` to 0 removes it for travellers with only a
carry-on.

### Two entry points

Steps 1-2 decide what goes where. Steps 3-5 derive everything else from that
decision. They are triggered separately:

| Trigger | Runs |
| --- | --- |
| Replan control | steps 1-5 — full reshuffle, with undo |
| Drag a card, edit a duration, change modes or day window | steps 3-5 only |

On a drag, steps 1-2 must **not** run. The user has just stated the assignment
and the order; re-clustering would undo their drag the moment they made it.

Derivation recomputes wholesale rather than patching. Moving one card changes
every later arrival in that day, the two legs either side of where it left, the
two either side of where it landed, and the warnings on both days — the
incremental version touches nearly everything anyway and adds stale-state bugs
for it. A day holds at most a dozen stops, so a full recompute is microseconds.

### Steps

1. **Split POIs into days.** k-means on latitude/longitude, `k` = number of
   days. Seeded by farthest-point initialisation, not randomly — with random
   seeding, tapping Replan twice produces two different trips, which users read
   as a bug. Then rebalance **by available free minutes per day**, not by equal
   stop counts: a last day with ninety usable minutes must not be handed five
   stops because the count said so.
2. **Order each day.** Nearest-neighbour from the end of `fixedStart`, then
   2-opt until no improving swap remains. This is an **open path with fixed
   endpoints**, not a closed loop; the anchors are excluded from swaps. On ten
   stops this is microseconds.
3. **Choose a mode per leg.** See Multimodal below.
4. **Walk the clock.** From the day's start, add the travel leg, then the stop's
   `duration_min`, and repeat through the suffix.
5. **Check constraints.** Each stop's `opening_hours` is evaluated against its
   computed arrival. Anything closed on arrival, or landing past the day's end,
   produces a warning.

### Multimodal

`allowed_modes` is a set of what the traveller will use. The planner picks a
mode for each leg independently, by distance:

| Leg distance | Mode chosen |
| --- | --- |
| < 1.2 km | walk |
| 1.2 – 5 km | bike if allowed, else transit |
| > 5 km | transit, else car or carshare |
| any airport transfer | transit or car, never walk or bike |

Falling back down the list to whatever `allowed_modes` permits; walk is always
the final fallback so a leg always has an answer.

Speeds, each multiplied by a 1.3 detour factor because streets are not straight
lines: walk 4.5, bike 13, transit 18, car 25 km/h. Transit carries a flat
6-minute wait penalty; below roughly 1.2km that penalty is what makes walking
win, which is why the threshold sits there rather than being tuned.

The chosen mode is **derived, never stored** — it falls out of geometry and
`allowed_modes`, so persisting it would be another stale-data trap.

**Ordering barely depends on routing precision.** Whether a leg is 11 or 14
minutes almost never changes which stop should come next. Real routing (phase 7)
improves the displayed schedule; it does not change the plan. This is why
estimates are correct for v1 and not a placeholder to be apologised for.

### Crowd avoidance

Crowd data lives behind a provider chain, not in the planner. See Crowd service
below for the seam. The default and permanent fallback is a per-category curve —
roughly twenty lines and a lookup table, no key, no billing, and no provider
that can deprecate it. Crowding at tourist sites is overwhelmingly predictable
from category and clock, and the planner never needs a headcount, only a
relative preference to nudge a stop earlier or later:

| Category | Busy | Preferred |
| --- | --- | --- |
| Museum, gallery | 11:00-15:00 | opening, or the last two hours |
| Landmark, viewpoint | sunset +/- 90min | early morning |
| Restaurant | 13:00-14:00, 20:00-21:30 | the shoulders |
| Market | Saturday morning | weekday morning |
| Church | Sunday service hours | any weekday |

Applied as a soft cost on each candidate arrival time during step 4, never as a
hard constraint: a crowded Colosseum still beats no Colosseum. It competes with
travel time and loses when avoiding a crowd would cost more movement than it
saves queueing.

Where a heuristic genuinely loses: one-off events, a cruise ship docking, a
strike, school holidays. Real data catches those and a table never will, which
is what phase 8 buys.

### Known ceilings

Each is marked in code with a `ponytail:` comment naming its upgrade path.

- **Haversine, not routing.** Off by roughly 20% in cities cut by rivers, hills
  or one-way systems. Upgrade: phase 7 replaces the single `travelTime()`
  function. Nothing else moves.
- **Mode choice is distance thresholds, not comparison.** It doesn't check
  whether a bike is actually available or the metro runs at that hour.
- **Crowd curves are heuristics, not measurements.** Blind to events, strikes,
  school holidays and cruise ships. Upgrade: add a measured provider above the
  table in the crowd chain; the table stays as fallback.
- **Clustering is geographic only.** It doesn't know the Louvre wants a morning.
  Upgrade: weight k-means by `duration_min`.
- **2-opt finds a local optimum.** At twelve or fewer stops per day the gap to
  optimal is negligible.
- **Offline writes are last-write-wins.** No merge, no vector clocks. Correct
  for single-user editing, which is the only case phases 1-5 support.

### Warnings are shown, never auto-fixed

A closed museum surfaces as "Closed Mondays — arriving 10:40" on the card, with
a tap to move it to another day. The app proposes and the traveller decides.
Silently rearranging someone's holiday is how a planner loses their trust.

### Tests

One file, `planner.test.ts`, assert-based:

- fixed input produces a stable day split across repeated runs
- 2-opt beats plain nearest-neighbour on a route with a known crossing
- a stop closed at its arrival time raises a warning
- a day that overruns `day_end` raises a warning
- zero POIs returns empty days rather than crashing
- a single-day trip yields exactly one cluster
- arrival day begins at `arrival_at + arrival_buffer_min`, not `day_start`
- departure day ends at `departure_at − departure_buffer_min`
- a departure day with no usable time schedules nothing and does not crash
- airport legs never select walk or bike
- mode selection respects `allowed_modes` and always terminates at walk
- rebalancing gives a short day fewer stops than a full day
- a museum lands outside 11:00-15:00 when the day has room for it
- crowd cost never overrides a hard opening-hours constraint
- crowd cost loses to travel time when avoiding a crowd costs more movement
- the provider chain returns the first non-null answer
- the chain still resolves when every non-table provider throws or returns null

This is the only non-trivial logic in the application, so it is the only code
with tests.

## Routing (phases 7-8)

### The constraint

There is no free, keyless source for public-transport routing, live traffic, or
visit/crowd data. Walking, cycling and driving routing have free options; those
three do not. Every provider requires a key plus billing.

A key cannot live in a static GitHub Pages build. It would be world-readable and
someone would spend the quota.

### The resolution

A **Supabase Edge Function** is the single egress point for anything keyed. Still
serverless, still free-tier, already in the stack. The browser calls the Edge
Function; the function holds the key; results cache in a `route_cache` table
keyed by `(from, to, mode, time_bucket)`. Replanning hits the same legs
repeatedly, so the cache absorbs most requests and keeps usage inside free
tiers. The client never sees a key, and nothing about the GitHub Pages
deployment changes.

### Phase 7 — real per-mode routing

Replaces `travelTime()` with a cached Edge Function call. OpenRouteService has a
free keyed tier covering foot, bike and car; transit needs Navitia or Google
Directions. **Verify current free-tier terms at implementation** rather than
designing against a remembered number.

Bike-share and car-share availability are the exception in this tier: **GBFS is
a genuinely free and open standard**, per-city, no key, giving station-level
availability. This is what makes the bike mode honest — "3 bikes at Piazza
Navona" rather than an assumption.

### Phase 8 — live crowd data

Road traffic is explicitly **not** planned. It only affects car legs, which are
the minority in a walkable city centre, and it changes arrival times by minutes
that the ordering does not depend on.

Crowd data is different: it changes the plan. Phase 8 adds measured providers to
the chain described in Crowd service. The heuristic table stays underneath them
permanently as the terminal fallback; it is not replaced.

Provider reality:

- **Google's Popular Times is not available through any official API.** It
  renders in Google Maps and appears in the Places response payload
  unofficially, which is why scraper libraries exist. Those violate Google's
  terms and break when the payload shifts. Not a foundation.
- **BestTime.app** is the closest legitimate fit — forecast curves plus live
  foot traffic, per venue, licensed for this use. Paid.
- **Foursquare** exposes venue popularity, believed to be a single score rather
  than an hourly curve.

**Verify both at implementation.** Free-tier terms and response shapes move.

This belongs behind the same Edge Function and the same cache as phase 7.

## Crowd service

External crowd data is resolved through a provider chain in
`src/lib/crowd/`, independent of the planner.

```ts
interface CrowdProvider {
  name: string
  // 0..1 busyness, or null when this provider has nothing for that venue
  busyness(venue: VenueRef, at: Date): Promise<number | null>
}
```

Providers are tried in order and the first non-null answer wins.

**The category table is the terminal provider and never returns null.** The
chain therefore always resolves, and the planner never handles a missing value.
This is what makes the fallback real rather than aspirational: a provider going
down degrades quality, never correctness. There is no configuration in which the
app has no crowd signal.

### Resolution happens before planning, not inside it

The planner is pure and synchronous — its derivation half re-runs on every
drag — and providers are async. So the chain resolves first and hands the planner plain data:

```ts
const curves = await resolveCrowd(pois, days)   // async, cached, chained
plan({ pois, days, allowedModes, curves })      // pure, sync, instant
```

Purity and testability survive, the drag interaction stays instant, and tests
inject a fake curve map with no mocking. Putting the lookup inside `plan()`
would make the planner async and take the drag interaction with it.

### Caching

`crowd_cache`, keyed by `(venue, weekday, hour)`. Weekly patterns are stable, so
the TTL is weeks rather than minutes. Live "busy right now" readings are a
separate short-TTL field that only phase 8 providers populate; the heuristic
provider has no live component and claims none.

### Provider ranking

1. **Category table** — always present, terminal, zero cost.
2. **BestTime.app** (phase 8) — licensed forecast curves plus live foot traffic.
   Paid. The provider to reach for first.
3. **Scraper** (optional, discouraged) — parses an undocumented Google payload.
   Three problems: it breaks without warning when that payload changes, it
   violates Google's terms, and running from an Edge Function means a datacenter
   IP, which Google blocks aggressively. Expect flakiness that presents as a bug
   in this app.

The chain is what makes ranking a cheap decision. A provider is one file; when
it starts returning null the chain falls through to the table automatically and
nothing else notices.

### Where this abstraction stops

Two concrete chains — `CrowdProvider` now, `TravelTimeProvider` in phase 7 —
sharing a shape. Not a generic `EnrichmentProvider<T>` with a registry and a
config schema. Two interfaces that happen to rhyme are cheaper than the
framework that would unify them, and nothing yet needs a third.

## Screens

| Route | Contents |
| --- | --- |
| `/login` | One email field, magic link |
| `/` | Trip list: city, dates, stop count |
| `/trip/new` | Wizard: city and hotel, arrival point and time, departure point and time, day window, allowed modes |
| `/trip/[id]` | The application. Segmented Map / Plan over shared state |
| `/shared/[token]` | Read-only plan. No map, no auth |

### `/trip/[id]`

**Map view.** Leaflet with a search field on top. Results appear as tappable
pins; tap-and-hold drops a custom stop. Pins are tinted by assigned day,
unassigned stops are grey. Hotel and arrival/departure points have their own
markers.

**Plan view.** A vertical timeline per day. Each stop is a card showing time,
name and duration, with a travel leg between cards reading "12 min on foot" or
"8 min by bike", carrying the mode's icon. Dragging a card reorders it or moves
it to another day; on drop the planner re-runs and the clock re-derives.
Warnings appear as amber chips on the offending card. A Replan control
re-clusters from scratch, with undo.

Mobile-first: primary controls sit within thumb reach at the bottom of the
viewport.

### Visual direction

The basemap is plain raster tiles, so the character has to come from the
interface around it: view transitions between map and plan, spring physics on
drag, a coherent day-colour palette, the route line drawing itself as a day
opens, a small celebratory beat when a day fills.

Applied sparingly. This app gets used on a hot pavement on 8% battery, and being
fast is the feature that matters most. The `frontend-design` skill sets the
aesthetic direction at implementation time rather than being guessed at here.

## Offline

`vite-plugin-pwa` with `registerType: 'autoUpdate'`.

- The app shell is precached.
- OSM tiles are runtime-cached CacheFirst, capped at roughly 300 tiles.
- The current trip's rows are mirrored into IndexedDB.

Opening the app with no signal shows the full plan and the last-seen tiles —
the exact moment abroad when it is needed. Edits made offline queue and flush on
reconnect, last-write-wins.

## Deployment

GitHub Actions: build, then `actions/deploy-pages`.

- `404.html` is copied from `index.html` for SPA fallback.
- `base` is set to the repository subpath.
- `PUBLIC_SUPABASE_URL` and `PUBLIC_SUPABASE_PUBLISHABLE_KEY` are injected from
  repository secrets at build time.
- From phase 7, Edge Function deploys are a separate CI step; third-party keys
  live in Supabase function secrets, never in the Pages build.

## Phase 6 note

Realtime collaborative editing needs a `trip_members` table, membership-based
RLS, a join-by-token RPC and presence UI — comparable in size to phases 1-5
combined. It is scoped after the complete product precisely so it can be dropped
without touching anything above it.
