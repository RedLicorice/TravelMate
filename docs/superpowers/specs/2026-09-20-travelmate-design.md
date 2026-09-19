# TravelMate — Design

Date: 2026-09-20
Status: Approved (brainstorming phase complete)

## Purpose

A PWA for someone visiting a city for a few days. They tell it their hotel and
when they arrive and leave, they add the places they want to see, and it turns
that pile of pins into a day-by-day schedule that minimises walking and doesn't
send them to a museum that's closed.

Serverless: Supabase for data and auth, static build on GitHub Pages.

## Scope

In scope for v1, in build order:

1. Auth, trip CRUD
2. Map, POI search and capture
3. Planner and timeline
4. PWA and offline
5. Read-only share link
6. Realtime collaborative editing

Phase 6 is the cut line. Phases 1-5 are a complete product without it.

Out of scope: bookings, tickets, flights, budgets, reviews, photos, social
features.

## Stack

| Concern | Choice | Why |
| --- | --- | --- |
| Framework | SvelteKit, `adapter-static`, SPA fallback | Emits plain files; GitHub Pages serves them |
| UI | Svelte 5 runes, Tailwind v4 | |
| Map | Leaflet + OSM raster tiles | No API key, no account, ~40KB |
| Backend | Supabase (Postgres, Auth, Realtime) | |
| Auth | Magic link email | No passwords stored; trips survive a cache clear |
| POI data | Nominatim (search), Overpass (category browse) | Free, keyless |
| Opening hours | `opening_hours.js` | The OSM format is not hand-parseable |
| PWA | `vite-plugin-pwa` | Generates manifest and service worker |

Four runtime dependencies total: `leaflet`, `opening_hours.js`,
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
  day_start     time not null default '09:00',
  day_end       time not null default '19:00',
  transport_mode text not null default 'walk'
                 check (transport_mode in ('walk','transit','drive')),
  share_token   uuid unique,
  created_at    timestamptz not null default now(),
  check (departure_at > arrival_at)
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

Two decisions worth stating explicitly:

**A POI is its own plan assignment.** `day_index` and `order_index` live on the
POI row; `null` means unassigned, which is the wishlist. There is no
`plan_items` table because there is nothing a third table would hold that these
two columns don't.

**Arrival and departure clock times are never stored.** They are a pure function
of hotel position, row order, durations and the day window, so the planner
derives them on read. Storing them would create a second source of truth that
goes stale the moment anyone drags a card.

**Arrival and departure are timestamps, not dates.** A traveller landing at
15:00 has a short first day, and one flying out at 10:00 has almost no last day.
The planner clamps day one to `arrival_at` and the final day to `departure_at`,
and uses `day_start`/`day_end` for every day in between. Treating them as plain
dates would schedule a full day around a flight.

### Security

RLS on both tables, owner-only:

- `trips`: `auth.uid() = user_id` for all commands.
- `pois`: same, resolved through `trip_id`.

The share link is deliberately **not** implemented as a
`using (share_token is not null)` select policy. That policy would let any
anonymous client select every shared trip in the database — the token would
gate nothing, because the client chooses its own `where` clause. Instead:

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

Read-only, single-token, non-enumerable. Anonymous role is granted execute on
this function and nothing else.

Revoking a share link is setting `share_token` to null.

The Supabase anon key is baked into the static build. This is how the key is
designed to be used; it identifies the project, it does not authorise anything.
RLS is the actual boundary. The service-role key never appears in the repo, the
build, or CI.

## Planner

`src/lib/planner.ts`. Pure: no network, no Supabase, no Svelte imports. Testable
in isolation, and fast enough to re-run on every drag rather than maintaining
incremental state.

```ts
plan(input: {
  hotel: LatLng,
  pois: Poi[],
  days: Day[],            // { date, start: Date, end: Date }
  mode: 'walk' | 'transit' | 'drive'
}): { days: PlannedDay[], warnings: Warning[] }
```

Four steps:

1. **Cluster into days.** k-means on latitude/longitude, `k` = number of days.
   Seeded by farthest-point initialisation, not randomly — with random seeding,
   tapping Replan twice produces two different trips, which users read as a bug.
   Then rebalance: move the point closest to a neighbouring centroid until no
   day holds more than `ceil(n/k)` stops, so a nine-stop day doesn't sit next to
   a one-stop day.
2. **Order within the day.** Nearest-neighbour from the hotel, then 2-opt until
   no improving swap remains. The route is a loop: hotel, stops, hotel. On ten
   stops this is microseconds.
3. **Walk the clock.** From the day's start, add the travel leg, then the stop's
   `duration_min`, and repeat. Travel time is haversine distance x 1.3 detour
   factor, divided by mode speed: walk 4.5, transit 18, drive 25 km/h.
4. **Check constraints.** Each stop's `opening_hours` is evaluated against its
   computed arrival. Anything closed on arrival, or landing past the day's end,
   produces a warning.

### Known ceilings

Each is marked in code with a `ponytail:` comment naming its upgrade path.

- **Haversine, not routing.** Off by roughly 20% in cities cut by rivers, hills
  or one-way systems. Upgrade: replace the single `travelTime()` function with
  an OSRM call. Nothing else moves.
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

One file, `planner.test.ts`, assert-based, six cases:

- fixed input produces a stable day split across repeated runs
- 2-opt beats plain nearest-neighbour on a route with a known crossing
- a stop closed at its arrival time raises a warning
- a day that overruns `day_end` raises a warning
- zero POIs returns empty days rather than crashing
- a single-day trip yields exactly one cluster

This is the only non-trivial logic in the application, so it is the only code
with tests.

## Screens

| Route | Contents |
| --- | --- |
| `/login` | One email field, magic link |
| `/` | Trip list: city, dates, stop count |
| `/trip/new` | Three steps: city and hotel search, arrival/departure datetimes, day window and transport mode |
| `/trip/[id]` | The application. Segmented Map / Plan over shared state |
| `/shared/[token]` | Read-only plan. No map, no auth |

### `/trip/[id]`

**Map view.** Leaflet with a search field on top. Results appear as tappable
pins; tap-and-hold drops a custom stop. Pins are tinted by assigned day,
unassigned stops are grey, and the hotel has its own marker.

**Plan view.** A vertical timeline per day. Each stop is a card showing time,
name and duration, with a thin travel leg between cards reading "12 min on
foot". Dragging a card reorders it or moves it to another day; on drop the
planner re-runs and the clock re-derives. Warnings appear as amber chips on the
offending card. A Replan control re-clusters from scratch, with undo.

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
which is the exact moment abroad when it's needed. Edits made offline queue and
flush on reconnect, last-write-wins.

## Deployment

GitHub Actions: build, then `actions/deploy-pages`.

- `404.html` is copied from `index.html` for SPA fallback.
- `base` is set to the repository subpath.
- `PUBLIC_SUPABASE_URL` and `PUBLIC_SUPABASE_ANON_KEY` are injected from
  repository secrets at build time.

## Build order

Each phase ships independently.

1. Skeleton, auth, trip CRUD
2. Map, POI search and capture
3. Planner and timeline — the point at which this stops being a list app
4. PWA and offline
5. Share link
6. Realtime collaborative editing

Phase 6 needs a `trip_members` table, membership-based RLS, a join-by-token RPC
and presence UI. It is scoped last precisely so it can be dropped without
touching anything above it.
