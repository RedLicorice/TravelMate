# Providers, busyness and handoff — Design

Date: 2026-09-21
Status: Approved (brainstorming phase complete)
Supersedes the routing sections of `2026-09-20-travelmate-design.md`.

## What this corrects

The app drifted into trying to be a routing engine. It is not one. The shape
of the product is three steps:

1. Create the trip.
2. Add places you want to see to the wishlist.
3. Tap **Regenerate** to get an updated plan.

Estimates exist to **order stops**. They do not exist to navigate, and the app
should not pretend otherwise. Navigation is handed to an app that already does
it well.

The second correction is about money. Earlier work treated "no API key" as a
constraint to engineer around, and the result was a two-band transit heuristic
dressed up as routing — right to within minutes on one leg by luck, not by
construction. Paid providers are now in scope, and the heuristics become
fallbacks rather than the answer.

## Providers

Every external source is a **cached provider**. The principle does not change
per vendor:

- The key lives in a Supabase Edge Function. It never reaches the browser.
- Responses are cached in Postgres with a TTL.
- A miss goes to the provider; a hit never does.
- Anything still missing falls back to something local that always answers.

Three providers, three jobs:

| Provider | Answers | Key |
| --- | --- | --- |
| Google Routes API | travel time and distance, including real transit | `GOOGLE_MAPS_KEY` |
| Google Places API | places OSM does not know | `GOOGLE_MAPS_KEY` |
| Foursquare Places | `popularity` and `hours_popular` | `FOURSQUARE_KEY` |
| Photon (free) | search and reverse geocode | none |
| Local scraper (deferred) | busyness for places Foursquare has never heard of | none |

### Google Cloud: enable exactly two APIs

**Routes API** (`computeRouteMatrix` for all-pairs times, `computeRoutes` for
transit against real timetables) and **Places API (New)** (places OSM lacks).

Everything else stays off: Distance Matrix and Directions are legacy and
superseded by Routes; Geocoding is covered by Photon and Places; Maps
JavaScript and Static Maps are unused because the app renders Leaflet on OSM
tiles.

Restrict the key to those two APIs. Do not add an IP restriction -- Supabase
Edge Functions have no stable egress IP, so it would only break. The real
backstop against a loop in this code running up a bill is a budget alert plus
per-API quota caps, set in Cloud Console.

### Why Google for routing

No free keyless service routes public transport. Valhalla's public instance
rejects `multimodal` — it has no GTFS — and the OSRM demo answers every
profile with the same car route, so its "walking" times are driving times.
Routes API does real transit against real timetables, which is the difference
between "an express probably averages 60km/h" and "the 09:43 from Stansted".

Valhalla stays as the fallback for road and foot geometry, and the haversine
model stays beneath that. Neither is removed: a provider being down must
degrade the plan, never break it.

### Two tiers of routing

Routing serves two different jobs, at different shapes and costs.

**Tier 1 — ordering, a matrix per day.** `computeRouteMatrix` supports
`TRANSIT`, capped at 100 elements against 625 for road modes. A day of stops
plus its anchors is around ten points, so 10×10 fits a day exactly. 2-opt then
reorders against real timetabled times rather than a speed model.

Resolving **per day rather than per trip** is also what removes the 20-point
cliff by construction: every request is inside the cap because a day is, so
there is no oversized request to silently give up on.

**Tier 2 — itinerary detail, once the plan is settled.** `computeRoutes` per
leg on the finished plan. A settled day has *n−1* legs rather than *n²* pairs,
so this is linear and cheap, and it is the only point at which the plan is
concrete enough to route at all.

This is what turns `72 min · transit` into "09:43 Stansted Express to
Liverpool Street, Central line to Holborn, arrive 10:48" -- departure times,
line names, transfers, and the walk at each end. It also yields the one
warning no heuristic can produce: the last service has gone.

Tier 1 is the recurring cost and the thing to watch: one transit matrix per
day per Regenerate. Tier 2 is linear and only runs when a plan is produced.

### Coverage is not uniform

Google's transit data is excellent in large cities and thin or absent in small
ones. The fallback chain is what makes that survivable: a city Google does not
cover degrades to Valhalla road times and then to the speed model, rather than
failing.

### Why a 24×7 curve is not needed

The planner consumes exactly one thing: a 0-1 busyness for a place at a time,
used as a soft cost to nudge a stop earlier or later. Foursquare's
`hours_popular` (busy windows per weekday) plus `popularity` (a scalar) supply
that directly -- inside a window, the popularity; outside it, the baseline.
Identical in shape to the category table, with real per-place data behind it.

An earlier draft specified a 24×7 intensity curve and a local scraper to fill
it. Nothing consumes that richness, so both are dropped from the critical path.

### The scraper, deferred

A local scrape is still the only route to busyness for a place no licensed
source knows. It would run locally on a residential connection, because a
datacenter IP is blocked -- the only reason it would be a batch rather than
another Edge Function.

It is deliberately **not** in the build order. Places the providers miss can
already be added by hand, and a scraper that parses an undocumented payload is
a maintenance burden that should not be taken on until something actually
needs it.

## Data model

```sql
places (
  id           uuid primary key,
  name         text not null,
  lat, lng     double precision not null,
  category     text,
  osm_id       text unique,          -- from Photon
  fsq_id       text unique,          -- from Foursquare
  google_id    text unique,          -- from Places
  dedupe_key   text unique not null, -- normalised name + rounded coords
  created_at, updated_at
)

busyness (
  place_id     uuid references places on delete cascade,
  source       text check (source in ('foursquare','scrape')),
  -- Busy windows per weekday, as the provider gives them:
  -- [{"day":1,"open":"1200","close":"1500"}, ...]
  windows      jsonb,
  popularity   numeric,      -- 0-1, the intensity inside those windows
  observed_at  timestamptz not null,
  expires_at   timestamptz not null,
  primary key (place_id, source)
)

travel_cache (
  from_key     text not null,   -- rounded "lat,lng"
  to_key       text not null,
  mode         text not null,
  depart_bucket text not null,  -- local hour band, or 'any'
  minutes      int not null,
  km           numeric not null,
  source       text not null,   -- 'google' | 'valhalla'
  expires_at   timestamptz not null,
  primary key (from_key, to_key, mode, depart_bucket)
)

-- Deferred with the scraper; specified here so the shape is settled.
scrape_jobs (
  id           uuid primary key,
  place_id     uuid references places on delete cascade,
  status       text check (status in ('queued','claimed','done','failed')),
  attempts     int not null default 0,
  claimed_by   text, claimed_at timestamptz,
  last_error   text,
  created_at, updated_at
)
```

Two indexes carry real weight:

- `unique (dedupe_key)` on `places` — one canonical row per real place, so
  "the same place" has one answer rather than each subsystem re-deriving it.
- `unique (place_id) where status in ('queued','claimed')` on `scrape_jobs` —
  the same place cannot be queued twice however many times it is requested.

Claiming uses `for update skip locked`, so two workers never take one job.

## The plan is stored, not derived

An earlier design stated that clock times are never stored, because they are a
pure function of order, durations and the day window. That held while times
were purely derived. Two things ended it.

**Transit pins the plan to real services.** Once a leg resolves to *the 09:43*,
the plan depends on that departure; re-deriving from order and durations would
drift off the service actually being caught.

**Regenerate makes the plan an artifact.** The product is three steps -- create
the trip, fill the wishlist, tap Regenerate. The plan is what Regenerate
produces, not a view that recomputes whenever a page opens. Today `schedule()`
runs on every load, so opening a trip can silently re-time the day. That is a
bug the stored plan removes.

```sql
plan_stops (
  id           uuid primary key,
  trip_id      uuid not null references trips on delete cascade,
  day_index    int not null,
  order_index  int not null,
  poi_id       uuid references pois on delete cascade,  -- null for anchors
  name         text not null,        -- anchors have no poi row
  lat, lng     double precision not null,

  starts_at    timestamptz not null,
  -- Not always starts_at + duration: a meal waits for its window, and the end
  -- of the day truncates.
  ends_at      timestamptz not null,
  -- A time the traveller fixed -- a booked table -- which the planner must
  -- honour rather than cheerfully reschedule.
  pinned       boolean not null default false,

  -- The leg INTO this stop.
  leg_mode     text,
  leg_minutes  int,
  leg_km       numeric,
  leg_detail   jsonb,   -- tier 2: lines, departures, transfers

  warnings     jsonb,
  generated_at timestamptz not null
)
```

`duration_min` stays on `pois`: it is an input, a preference. `starts_at` and
`ends_at` are output. This is the `plan_items` table the original design
rejected, and it now earns its place because it holds what those two columns
cannot -- real times, pins, resolved transit legs and warnings.

### What this unlocks

- **Pinned times.** A booked table at 20:00 becomes a constraint.
- **Shared plans stop re-planning in the viewer's browser.** Today `/shared/`
  re-runs the planner client-side, so a viewer can see different times than the
  owner. It becomes a read.
- **Drag edits persist as times**, not only as order.
- **Offline is real.** A stored plan renders with no computation.

### Staleness is already how this works

A newly added place already sits unplaced until Regenerate is tapped -- the
planner reports it as `not-planned-yet` and the wishlist says "Added since the
last plan". Storing the plan does not introduce staleness; it extends the same
rule to every input, so changing a duration, a rating or the dates also leaves
the plan behind until it is regenerated.

What it does change is that this now needs saying once, plainly, rather than
per stop: "3 changes since this plan was made", with the button beside it.

## The read path

An Edge Function per concern, each the same shape: look in the cache, call the
provider on a miss, write the result back, return it.

```
busyness(place_ids[])  -> cache -> Foursquare -> enqueue scrape -> category table
travel(pairs[], mode)  -> cache -> Google Routes -> Valhalla -> haversine
places(query, near)    -> Photon -> Google Places
```

The category table remains the terminal busyness provider and still never
returns null, so the chain always resolves and the planner never handles a
missing value. The haversine model plays the same role for travel.

**Nothing blocks on the scraper.** A miss returns the fallback immediately and
enqueues work; the next Regenerate picks up whatever has landed.

## Cost control

With paid providers the cache stops being a nicety:

- Travel times are cached per `(from, to, mode, depart_bucket)`. Replanning a
  day hits the same pairs repeatedly and must not re-bill.
- Busyness is cached 14 days. Weekly patterns barely move, and a place's
  busy hours are not news.
- Routes are requested as a **matrix**, not per leg. A day of ten stops is a
  hundred pairs; 2-opt needs all of them because it reorders freely.
- The current 20-point cap disappears rather than becoming chunking: resolving
  per day keeps every request inside the transit matrix's 100-element limit by
  construction. Today a trip above 20 points silently falls back to straight
  lines everywhere, which is the worst failure mode available -- worse numbers
  the bigger the trip, with no indication.

## Time-dependent travel

Real transit makes a leg's cost depend on when it is taken, which is circular:
the order sets the time, the time sets the cost. Resolved with two passes —
plan once against an `any`-bucket estimate, then re-resolve the pairs that plan
actually uses at the hours it produces, and settle. Bounded, and the cache
absorbs the second pass on subsequent replans.

## Navigation is a handoff

The app does not navigate. Each travel leg gets a button that opens directions
for that hop, and each day gets one that opens the whole day as a waypoint
route. Travel mode carries across, so a transit leg opens transit directions.

This is why estimate fidelity only has to be good enough to *order* stops.

## Live adjustment

On the day, refresh busyness for the next stops and, when reality disagrees
with the plan, offer a swap. The suggestion comes from re-running `schedule()`
— it is deterministic, reproducible, and works offline against the cache.

Deliberately no language model. A model cannot know live crowds, and putting
one in the planning path would make Regenerate slower, costlier and
non-reproducible, breaking the property that the same trip always plans the
same way.

## Secrets

`FOURSQUARE_KEY` and `GOOGLE_MAPS_KEY` live in Supabase Edge Function secrets.
The service-role key the local worker needs lives in a local env file on the
machine that runs it — never in the repository, and never in a migration,
because migration SQL is stored in `supabase_migrations.schema_migrations` as
well as in git, and this repository is public.

## Build order

1. Schema: `places`, `busyness`, `travel_cache`, `plan_stops`, with dedupe and TTL.
2. `travel` Edge Function on Google Routes, tier 1: a transit matrix per day,
   cached, replacing the speed model for ordering.
3. Stored plan: Regenerate writes `plan_stops`; every view reads it; the
   staleness indicator ships with it.
4. `busyness` Edge Function on Foursquare, cached, windows and popularity.
5. Tier 2 itinerary detail: per-leg `computeRoutes` on the settled plan.
6. Maps handoff buttons.
7. Pinned times.
8. Live adjustment.
9. Housekeeping: rename Replan to Regenerate.

Deferred, to be taken on only if something needs it: the local scraper and the
`scrape_jobs` queue that feeds it.

Each step is useful alone. Step 2 alone fixes the 222-minute airport leg.
