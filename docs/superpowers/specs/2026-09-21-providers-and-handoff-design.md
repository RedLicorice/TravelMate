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
- The current 20-point cap must become chunking. Today a trip above it silently
  falls back to straight lines everywhere, which is the worst failure mode
  available: worse numbers the bigger the trip, with no indication.

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

1. Schema: `places`, `busyness`, `travel_cache`, `scrape_jobs`, with dedupe and TTL.
2. `travel` Edge Function on Google Routes, cached, matrix-shaped, chunked.
3. `busyness` Edge Function on Foursquare, cached, windows and popularity.
4. Maps handoff buttons.
5. Live adjustment.
6. Housekeeping: rename Replan to Regenerate.

Deferred, to be taken on only if something needs it: the local scraper and the
`scrape_jobs` queue that feeds it.

Each step is useful alone. Step 2 alone fixes the 222-minute airport leg.
