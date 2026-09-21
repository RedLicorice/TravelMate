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
| Local scraper | busyness where the APIs have none | none |

### Why Google for routing

No free keyless service routes public transport. Valhalla's public instance
rejects `multimodal` — it has no GTFS — and the OSRM demo answers every
profile with the same car route, so its "walking" times are driving times.
Routes API does real transit against real timetables, which is the difference
between "an express probably averages 60km/h" and "the 09:43 from Stansted".

Valhalla stays as the fallback for road and foot geometry, and the haversine
model stays beneath that. Neither is removed: a provider being down must
degrade the plan, never break it.

### Why the scraper still exists

Google's popular-times data is not exposed by any official API, and Foursquare
gives `popularity` (a scalar) plus `hours_popular` (busy windows) rather than a
24×7 curve. A local scrape fills that gap, and only that gap.

It runs **locally, on a residential connection**, because a datacenter IP is
blocked. That is the whole reason it is a local batch rather than another Edge
Function.

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
  curve        jsonb,        -- 7x24 intensities when known
  popularity   numeric,      -- a scalar when that is all there is
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
- Busyness is cached 14 days for Foursquare, 30 for scrapes. Weekly patterns
  barely move.
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
3. `busyness` Edge Function on Foursquare, cached, enqueuing misses.
4. Local worker: claim, scrape, write back, throttle.
5. Maps handoff buttons.
6. Live adjustment.
7. Housekeeping: rename Replan to Regenerate.

Each step is useful alone. Step 2 alone fixes the 222-minute airport leg.
