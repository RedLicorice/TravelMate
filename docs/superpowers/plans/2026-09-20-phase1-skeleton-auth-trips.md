# Phase 1 — Skeleton, Auth, Trip CRUD — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deployable static PWA where a traveller signs in by magic link, creates a trip with a hotel and arrival/departure times, and sees their trips listed.

**Architecture:** SvelteKit in pure SPA mode (`ssr = false`) built by `adapter-static` into plain files for GitHub Pages. Supabase provides Postgres, Auth and row-level security; the browser talks to it directly with the anon key, and RLS is the only access boundary. All date and day arithmetic lives in one pure, dependency-free module so it can be tested without a browser or a database.

**Tech Stack:** SvelteKit 2.70, Svelte 5 (runes), Tailwind CSS 4.3, `@supabase/supabase-js` 2.116, Vitest 5.0, Node 24.

**Spec:** `docs/superpowers/specs/2026-09-20-travelmate-design.md`

## Global Constraints

- Node 24, npm 11. Package manager is npm.
- Runtime dependencies for phases 1-6 are capped at four: `leaflet`, `opening_hours.js`, `@supabase/supabase-js`, `vite-plugin-pwa`. Phase 1 adds only `@supabase/supabase-js`. Dev dependencies are not capped.
- The planner and all date logic must stay pure: no network, no Supabase imports, no Svelte imports.
- Derived values are never stored. Clock times are recomputed, not persisted.
- The service-role key never appears in the repo, the build, or CI. Only `PUBLIC_SUPABASE_URL` and `PUBLIC_SUPABASE_ANON_KEY` reach the client.
- Mobile-first. Primary controls sit within thumb reach at the bottom of the viewport.
- Every `ponytail:` comment names both the ceiling and its upgrade path.

## Spec amendment made by this plan

The spec stores `arrival_at` / `departure_at` as `timestamptz` but never names the trip's timezone. "Which calendar day is this?" and "has 19:00 passed?" are only answerable in the destination city's zone — a 23:30 arrival in Tokyo belongs to a different day depending on where the question is asked. Task 3 adds `timezone text not null` to `trips` (an IANA name such as `Europe/Rome`), and Task 2 does all day arithmetic in that zone via `Intl.DateTimeFormat`. Fold this back into the spec when this plan is executed.

## Prerequisites (human, once)

1. Create a Supabase project at supabase.com. Note the project URL and the **anon** key from Project Settings → API.
2. Create `.env.local` in the repo root (already git-ignored):

```
PUBLIC_SUPABASE_URL=https://<ref>.supabase.co
PUBLIC_SUPABASE_ANON_KEY=<anon key>
```

3. In Supabase → Authentication → URL Configuration, add `http://localhost:5173` and the eventual GitHub Pages URL to **Redirect URLs**. Magic links silently fail to redirect otherwise.

## File structure

| File | Responsibility |
| --- | --- |
| `svelte.config.js` | Static adapter, base path for the repo subpath |
| `vite.config.ts` | SvelteKit + Tailwind plugins, Vitest config |
| `src/app.css` | Tailwind entry, design tokens |
| `src/lib/trip/days.ts` | **Pure.** Trip + Day types, timezone-aware day derivation, anchors |
| `src/lib/trip/days.test.ts` | Tests for the above |
| `src/lib/supabase.ts` | The single Supabase client instance |
| `src/lib/session.svelte.ts` | Session rune + auth helpers |
| `src/routes/+layout.ts` | `ssr = false` — puts the app in SPA mode |
| `src/routes/+layout.svelte` | Shell, session bootstrap, route guard |
| `src/routes/login/+page.svelte` | Email field, magic link |
| `src/routes/+page.svelte` | Trip list |
| `src/routes/trip/new/+page.svelte` | Three-step wizard |
| `supabase/migrations/0001_trips.sql` | Schema, RLS, share RPC |
| `.github/workflows/deploy.yml` | Build and publish to Pages |

---

### Task 1: Skeleton that builds to static files

**Files:**
- Create: `package.json`, `svelte.config.js`, `vite.config.ts`, `src/app.css`, `src/app.html`, `src/routes/+layout.ts`, `src/routes/+layout.svelte`, `src/routes/+page.svelte`, `.gitignore` (extend)
- Test: `scripts/check-build.sh`

**Interfaces:**
- Consumes: nothing.
- Produces: `npm run build` emits `build/index.html` and `build/404.html`. `npm test` runs Vitest.

- [ ] **Step 1: Scaffold the project**

```bash
cd /mnt/repos/travelmate
npm create svelte@latest . -- --template minimal --types ts --no-add-ons --no-install
npm install
npm install -D @sveltejs/adapter-static @tailwindcss/vite tailwindcss vitest
npm install @supabase/supabase-js
```

If the interactive prompt appears anyway, choose: Skeleton project, TypeScript, no additional options.

- [ ] **Step 2: Write the build check**

Create `scripts/check-build.sh`:

```bash
#!/usr/bin/env bash
# GitHub Pages has no SPA rewrite: it serves 404.html for unknown paths, and
# index.html for "/". A SPA needs both, or the site 404s at its own root.
set -euo pipefail
test -f build/index.html || { echo "FAIL: build/index.html missing"; exit 1; }
test -f build/404.html   || { echo "FAIL: build/404.html missing"; exit 1; }
grep -q "sveltekit" build/index.html || { echo "FAIL: index.html is not the app shell"; exit 1; }
echo "PASS: static output has both entry points"
```

Then `chmod +x scripts/check-build.sh`.

- [ ] **Step 3: Run it to verify it fails**

Run: `./scripts/check-build.sh`
Expected: FAIL with `build/index.html missing` (nothing is built yet).

- [ ] **Step 4: Configure the static adapter**

Replace `svelte.config.js`:

```js
import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

// Set by CI to '/<repo-name>' so asset URLs resolve under the Pages subpath.
const base = process.env.BASE_PATH ?? '';

/** @type {import('@sveltejs/kit').Config} */
export default {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({ fallback: '404.html' }),
    paths: { base }
  }
};
```

Replace `vite.config.ts`:

```ts
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts']
  }
});
```

Create `src/routes/+layout.ts`:

```ts
// Pure SPA. Auth state lives only in the browser, so there is nothing
// meaningful to render on a server that will never exist.
export const ssr = false;
export const prerender = false;
```

Create `src/app.css`:

```css
@import 'tailwindcss';

:root {
  color-scheme: light;
}

body {
  margin: 0;
  -webkit-tap-highlight-color: transparent;
}
```

Replace `src/routes/+layout.svelte`:

```svelte
<script lang="ts">
  import '../app.css';
  let { children } = $props();
</script>

{@render children()}
```

Replace `src/routes/+page.svelte`:

```svelte
<h1 class="p-6 text-2xl font-semibold">TravelMate</h1>
```

- [ ] **Step 5: Add the build script**

In `package.json`, set the `scripts` block to:

```json
{
  "dev": "vite dev",
  "build": "vite build && cp build/404.html build/index.html",
  "preview": "vite preview",
  "test": "vitest run",
  "check:build": "./scripts/check-build.sh"
}
```

The `cp` is deliberate. With `ssr = false` and nothing prerendered, the adapter emits only the fallback; copying it to `index.html` gives the site a root document without turning prerendering back on.

- [ ] **Step 6: Run the check to verify it passes**

Run: `npm run build && npm run check:build`
Expected: `PASS: static output has both entry points`

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: SvelteKit skeleton building to static files

Pure SPA via ssr=false plus adapter-static. GitHub Pages serves 404.html
for unknown paths and index.html for the root, so the build emits both;
check-build.sh fails if either goes missing."
```

---

### Task 2: Timezone-aware trip days (pure)

**Files:**
- Create: `src/lib/trip/days.ts`
- Test: `src/lib/trip/days.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type LatLng = { lat: number; lng: number }`
  - `type Place = { name: string; at: LatLng }`
  - `type Waypoint = { name: string; at: LatLng; dwellMin: number }`
  - `type Trip` — see code below
  - `type Day = { date: string; start: Date; end: Date; fixedStart: Waypoint[]; fixedEnd: Waypoint[]; usableMin: number }`
  - `tripDays(trip: Trip): Day[]`

Phase 3's planner consumes `Day` exactly as defined here.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/trip/days.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { tripDays, type Trip } from './days';

const hotel = { lat: 41.8986, lng: 12.4768 };
const fco = { lat: 41.8003, lng: 12.2389 };

const base: Trip = {
  hotelName: 'Hotel Artemide',
  hotel,
  timezone: 'Europe/Rome',
  arrivalAt: '2026-04-10T13:00:00Z', // 15:00 Rome (CEST)
  departureAt: '2026-04-13T08:00:00Z', // 10:00 Rome
  arrivalPoint: { name: 'Fiumicino', at: fco },
  departurePoint: { name: 'Fiumicino', at: fco },
  arrivalBufferMin: 45,
  departureBufferMin: 120,
  bagDropMin: 30,
  dayStart: '09:00',
  dayEnd: '19:00'
};

const hhmm = (d: Date, tz: string) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false
  }).format(d);

describe('tripDays', () => {
  it('covers every calendar day in the destination timezone, inclusive', () => {
    const days = tripDays(base);
    expect(days.map((d) => d.date)).toEqual([
      '2026-04-10', '2026-04-11', '2026-04-12', '2026-04-13'
    ]);
  });

  it('starts the first day at arrival plus the buffer, not at day_start', () => {
    const [first] = tripDays(base);
    expect(hhmm(first.start, base.timezone)).toBe('15:45');
  });

  it('ends the last day at departure minus the buffer', () => {
    const days = tripDays(base);
    expect(hhmm(days.at(-1)!.end, base.timezone)).toBe('08:00');
  });

  it('uses the normal day window for middle days', () => {
    const [, second] = tripDays(base);
    expect(hhmm(second.start, base.timezone)).toBe('09:00');
    expect(hhmm(second.end, base.timezone)).toBe('19:00');
  });

  it('never starts the first day before day_start for an early arrival', () => {
    const early = { ...base, arrivalAt: '2026-04-10T03:00:00Z' }; // 05:00 Rome
    const [first] = tripDays(early);
    expect(hhmm(first.start, base.timezone)).toBe('09:00');
  });

  it('anchors the first day airport then hotel, with bag drop', () => {
    const [first] = tripDays(base);
    expect(first.fixedStart.map((w) => w.name)).toEqual(['Fiumicino', 'Hotel Artemide']);
    expect(first.fixedStart[1].dwellMin).toBe(30);
    expect(first.fixedEnd.map((w) => w.name)).toEqual(['Hotel Artemide']);
  });

  it('anchors the last day hotel then airport', () => {
    const last = tripDays(base).at(-1)!;
    expect(last.fixedStart.map((w) => w.name)).toEqual(['Hotel Artemide']);
    expect(last.fixedEnd.map((w) => w.name)).toEqual(['Hotel Artemide', 'Fiumicino']);
    expect(last.fixedEnd[0].dwellMin).toBe(30);
  });

  it('shapes a day like a middle day when there is no arrival point', () => {
    const noAirport = { ...base, arrivalPoint: null };
    const [first] = tripDays(noAirport);
    expect(first.fixedStart.map((w) => w.name)).toEqual(['Hotel Artemide']);
  });

  it('gives a departure day with no usable time zero minutes, not a negative', () => {
    const earlyFlight = { ...base, departureAt: '2026-04-13T05:00:00Z' }; // 07:00 Rome
    const last = tripDays(earlyFlight).at(-1)!;
    expect(last.usableMin).toBe(0);
    expect(last.end.getTime()).toBeGreaterThanOrEqual(last.start.getTime());
  });

  it('skips the bag drop when bag_drop_min is zero', () => {
    const light = { ...base, bagDropMin: 0 };
    const [first] = tripDays(light);
    expect(first.fixedStart.map((w) => w.name)).toEqual(['Fiumicino']);
  });

  it('handles a single-day trip', () => {
    const oneDay = {
      ...base,
      arrivalAt: '2026-04-10T06:00:00Z',
      departureAt: '2026-04-10T19:00:00Z'
    };
    expect(tripDays(oneDay)).toHaveLength(1);
  });

  it('uses the destination timezone, not the machine timezone', () => {
    // 23:30 on the 10th in Tokyo is still the 10th there, and the 10th in UTC.
    const tokyo = {
      ...base,
      timezone: 'Asia/Tokyo',
      arrivalAt: '2026-04-10T14:30:00Z', // 23:30 Tokyo
      departureAt: '2026-04-12T01:00:00Z', // 10:00 Tokyo
      arrivalPoint: null,
      departurePoint: null
    };
    expect(tripDays(tokyo).map((d) => d.date)).toEqual([
      '2026-04-10', '2026-04-11', '2026-04-12'
    ]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/trip/days.test.ts`
Expected: FAIL — `Failed to resolve import "./days"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/trip/days.ts`:

```ts
export type LatLng = { lat: number; lng: number };
export type Place = { name: string; at: LatLng };

/** A fixed point in a day's route. `dwellMin` is time spent there, not travelling. */
export type Waypoint = { name: string; at: LatLng; dwellMin: number };

export type Trip = {
  hotelName: string;
  hotel: LatLng;
  /** IANA zone of the destination city, e.g. 'Europe/Rome'. */
  timezone: string;
  /** ISO instants. Arrival is when the plane lands, not when sightseeing starts. */
  arrivalAt: string;
  departureAt: string;
  arrivalPoint: Place | null;
  departurePoint: Place | null;
  arrivalBufferMin: number;
  departureBufferMin: number;
  bagDropMin: number;
  /** Local wall-clock 'HH:MM' in `timezone`. */
  dayStart: string;
  dayEnd: string;
};

export type Day = {
  /** YYYY-MM-DD in the trip's timezone. */
  date: string;
  start: Date;
  end: Date;
  fixedStart: Waypoint[];
  fixedEnd: Waypoint[];
  /** Minutes between start and end. Never negative. */
  usableMin: number;
};

const MIN = 60_000;

/**
 * Milliseconds to add to a UTC instant to get the wall-clock reading in `tz`.
 * Intl is the only timezone database available without a dependency.
 */
function tzOffsetMs(at: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  }).formatToParts(at);
  const g = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  // 'en-CA' renders midnight as 24; Date.UTC wants 0.
  const hour = g('hour') % 24;
  return Date.UTC(g('year'), g('month') - 1, g('day'), hour, g('minute'), g('second')) - at.getTime();
}

/** The YYYY-MM-DD a given instant falls on, in `tz`. */
function zonedDate(at: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(at);
}

/**
 * The instant at which local wall-clock `date`T`time` occurs in `tz`.
 * Two passes: guess at UTC, correct by the offset there, then re-measure in
 * case the correction crossed a DST boundary.
 * ponytail: a wall-clock time skipped by a spring-forward resolves to the
 * instant after the jump. Upgrade to Temporal.ZonedDateTime when it ships.
 */
function zonedInstant(date: string, time: string, tz: string): Date {
  let guess = new Date(`${date}T${time}:00Z`);
  for (let i = 0; i < 2; i++) {
    guess = new Date(new Date(`${date}T${time}:00Z`).getTime() - tzOffsetMs(guess, tz));
  }
  return guess;
}

/** All YYYY-MM-DD strings from `from` to `to` inclusive, in `tz`. */
function dateRange(from: string, to: string, tz: string): string[] {
  const out: string[] = [];
  let cursor = zonedInstant(from, '12:00', tz); // midday: never near a DST edge
  const limit = zonedInstant(to, '12:00', tz).getTime();
  while (cursor.getTime() <= limit) {
    out.push(zonedDate(cursor, tz));
    cursor = new Date(cursor.getTime() + 24 * 60 * MIN);
  }
  return out;
}

export function tripDays(trip: Trip): Day[] {
  const tz = trip.timezone;
  const arrival = new Date(trip.arrivalAt);
  const departure = new Date(trip.departureAt);

  const dates = dateRange(zonedDate(arrival, tz), zonedDate(departure, tz), tz);
  const lastIndex = dates.length - 1;

  const hotelStop = (dwellMin: number): Waypoint => ({
    name: trip.hotelName, at: trip.hotel, dwellMin
  });
  const placeStop = (p: Place): Waypoint => ({ name: p.name, at: p.at, dwellMin: 0 });

  return dates.map((date, i) => {
    const windowStart = zonedInstant(date, trip.dayStart, tz);
    const windowEnd = zonedInstant(date, trip.dayEnd, tz);

    // The first day cannot begin before the traveller is out of the airport;
    // the last cannot run past the moment they must leave for it.
    const start = i === 0
      ? new Date(Math.max(windowStart.getTime(), arrival.getTime() + trip.arrivalBufferMin * MIN))
      : windowStart;
    const rawEnd = i === lastIndex
      ? new Date(Math.min(windowEnd.getTime(), departure.getTime() - trip.departureBufferMin * MIN))
      : windowEnd;
    // A 07:00 flight leaves a day with negative length. Clamp it to empty:
    // the planner should schedule nothing, not schedule backwards.
    const end = new Date(Math.max(start.getTime(), rawEnd.getTime()));

    const fixedStart: Waypoint[] = [];
    if (i === 0 && trip.arrivalPoint) {
      fixedStart.push(placeStop(trip.arrivalPoint));
      // You cannot drag a suitcase around the Colosseum.
      if (trip.bagDropMin > 0) fixedStart.push(hotelStop(trip.bagDropMin));
    } else {
      fixedStart.push(hotelStop(0));
    }

    const fixedEnd: Waypoint[] = [];
    if (i === lastIndex && trip.departurePoint) {
      if (trip.bagDropMin > 0) fixedEnd.push(hotelStop(trip.bagDropMin));
      fixedEnd.push(placeStop(trip.departurePoint));
    } else {
      fixedEnd.push(hotelStop(0));
    }

    return {
      date,
      start,
      end,
      fixedStart,
      fixedEnd,
      usableMin: Math.round((end.getTime() - start.getTime()) / MIN)
    };
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/trip/days.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/trip/days.ts src/lib/trip/days.test.ts
git commit -m "feat: timezone-aware trip day derivation

Days, anchors and the usable window are derived in the destination city's
IANA zone via Intl -- 23:30 in Tokyo belongs to a different calendar day
depending on where the question is asked, and the spec never named a zone.

The first day starts at arrival plus buffer and the last ends at departure
minus buffer, clamped so an early flight yields an empty day rather than a
negative one. Bag drop is a mandatory anchor unless bag_drop_min is zero."
```

---

### Task 3: Schema, RLS, and the share RPC

**Files:**
- Create: `supabase/migrations/0001_trips.sql`, `supabase/README.md`

**Interfaces:**
- Consumes: nothing.
- Produces: tables `trips` and `pois`, function `get_shared_trip(uuid)`.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/0001_trips.sql`:

```sql
-- Phase 1 schema. See docs/superpowers/specs/2026-09-20-travelmate-design.md
create extension if not exists pgcrypto;

create table trips (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users on delete cascade,
  name          text not null,
  city          text not null,
  timezone      text not null,

  hotel_name    text not null,
  hotel_lat     double precision not null,
  hotel_lng     double precision not null,

  arrival_at    timestamptz not null,
  departure_at  timestamptz not null,

  arrival_point_name    text,
  arrival_point_lat     double precision,
  arrival_point_lng     double precision,
  departure_point_name  text,
  departure_point_lat   double precision,
  departure_point_lng   double precision,

  arrival_buffer_min    int not null default 45,
  departure_buffer_min  int not null default 120,
  bag_drop_min          int not null default 30,

  allowed_modes text[] not null default '{walk,transit}',
  day_start     time not null default '09:00',
  day_end       time not null default '19:00',

  share_token   uuid unique,
  created_at    timestamptz not null default now(),

  constraint trips_dates_ordered check (departure_at > arrival_at),
  constraint trips_modes_known check (allowed_modes <@ '{walk,bike,transit,car,carshare}'::text[]),
  constraint trips_modes_present check (array_length(allowed_modes, 1) >= 1),
  -- A half-set coordinate pair is worse than none: it geocodes to the Atlantic.
  constraint trips_arrival_point_whole check (num_nonnulls(arrival_point_lat, arrival_point_lng) <> 1),
  constraint trips_departure_point_whole check (num_nonnulls(departure_point_lat, departure_point_lng) <> 1)
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

create index pois_trip_day_order_idx on pois (trip_id, day_index, order_index);

alter table trips enable row level security;
alter table pois  enable row level security;

create policy trips_owner_all on trips
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy pois_owner_all on pois
  for all
  using      (exists (select 1 from trips t where t.id = pois.trip_id and t.user_id = auth.uid()))
  with check (exists (select 1 from trips t where t.id = pois.trip_id and t.user_id = auth.uid()));

-- Share links are an RPC, not a policy. A policy of the form
--   using (share_token is not null)
-- would gate nothing: the anonymous client writes its own WHERE clause and
-- could enumerate every shared trip in the database. This function takes the
-- token as an argument, so an unguessable token is genuinely required.
create function get_shared_trip(token uuid)
returns json
language sql
stable
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
grant execute on function get_shared_trip(uuid) to anon, authenticated;
```

- [ ] **Step 2: Apply it**

Open the Supabase dashboard → SQL Editor → paste the file → Run.
Expected: `Success. No rows returned`.

- [ ] **Step 3: Verify RLS actually denies**

In the SQL Editor, run this. It impersonates an anonymous client:

```sql
set local role anon;
select count(*) from trips;
```

Expected: `0` — not an error, and not a row count. RLS filters rather than rejecting, so a non-zero result here means the policy is not doing its job.

Then confirm the deny path on write:

```sql
set local role anon;
insert into trips (user_id, name, city, timezone, hotel_name, hotel_lat, hotel_lng, arrival_at, departure_at)
values (gen_random_uuid(), 'x', 'x', 'Europe/Rome', 'x', 0, 0, now(), now() + interval '1 day');
```

Expected: `ERROR: new row violates row-level security policy for table "trips"`.

- [ ] **Step 4: Write the runbook**

Create `supabase/README.md`:

```markdown
# Supabase

Migrations are plain SQL, applied in filename order.

No Supabase CLI is installed in this environment, so the current process is:
dashboard → SQL Editor → paste → Run. Apply them in order and never edit one
that has already been applied — add a new file instead.

After applying, re-run the RLS verification in
`docs/superpowers/plans/2026-09-20-phase1-skeleton-auth-trips.md` Task 3 Step 3.
A policy that silently returns rows to `anon` is the failure this catches.
```

- [ ] **Step 5: Commit**

```bash
git add supabase/
git commit -m "feat: trips and pois schema with owner-only RLS

Share access is a SECURITY DEFINER RPC taking the token as an argument.
An RLS select policy on share_token would let an anonymous client write its
own WHERE clause and enumerate every shared trip.

Adds timezone to trips: the spec stored timestamptz but never named the zone
the day arithmetic happens in."
```

---

### Task 4: Supabase client and session

**Files:**
- Create: `src/lib/supabase.ts`, `src/lib/session.svelte.ts`, `src/lib/session.test.ts`
- Modify: `src/routes/+layout.svelte`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `supabase` — the shared `SupabaseClient`
  - `session` — a rune-backed object with `{ user: User | null, ready: boolean }`
  - `signIn(email: string): Promise<{ error: string | null }>`
  - `signOut(): Promise<void>`
  - `redirectTarget(pathname: string, hasUser: boolean): string | null` — pure, tested

- [ ] **Step 1: Write the failing test for the guard**

Create `src/lib/session.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { redirectTarget } from './session.svelte';

describe('redirectTarget', () => {
  it('sends a signed-out visitor to login', () => {
    expect(redirectTarget('/', false)).toBe('/login');
  });

  it('leaves a signed-out visitor on login alone', () => {
    expect(redirectTarget('/login', false)).toBeNull();
  });

  it('sends a signed-in visitor away from login', () => {
    expect(redirectTarget('/login', true)).toBe('/');
  });

  it('leaves a signed-in visitor where they are', () => {
    expect(redirectTarget('/trip/new', true)).toBeNull();
  });

  it('lets anyone reach a shared plan', () => {
    expect(redirectTarget('/shared/abc', false)).toBeNull();
    expect(redirectTarget('/shared/abc', true)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/session.test.ts`
Expected: FAIL — cannot resolve `./session.svelte`.

- [ ] **Step 3: Write the client and session**

Create `src/lib/supabase.ts`:

```ts
import { createClient } from '@supabase/supabase-js';
import { PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY } from '$env/static/public';

// The anon key is public by design: it names the project, it authorises
// nothing. RLS is the boundary.
export const supabase = createClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
});
```

Create `src/lib/session.svelte.ts`:

```ts
import type { User } from '@supabase/supabase-js';
import { supabase } from './supabase';

export const session = $state<{ user: User | null; ready: boolean }>({
  user: null,
  ready: false
});

/** Kept pure and exported so the route guard is testable without a browser. */
export function redirectTarget(pathname: string, hasUser: boolean): string | null {
  if (pathname.startsWith('/shared/')) return null; // public by design
  if (!hasUser) return pathname === '/login' ? null : '/login';
  return pathname === '/login' ? '/' : null;
}

export function watchSession(): () => void {
  supabase.auth.getSession().then(({ data }) => {
    session.user = data.session?.user ?? null;
    session.ready = true;
  });
  const { data } = supabase.auth.onAuthStateChange((_event, s) => {
    session.user = s?.user ?? null;
    session.ready = true;
  });
  return () => data.subscription.unsubscribe();
}

export async function signIn(email: string): Promise<{ error: string | null }> {
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.origin + base() }
  });
  return { error: error?.message ?? null };
}

export async function signOut(): Promise<void> {
  await supabase.auth.signOut();
}

// The Pages subpath has to survive the round trip through the email link,
// or the magic link lands on a 404 at the domain root.
function base(): string {
  return import.meta.env.BASE_URL.replace(/\/$/, '');
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/session.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Wire the guard into the layout**

Replace `src/routes/+layout.svelte`:

```svelte
<script lang="ts">
  import '../app.css';
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { session, watchSession, redirectTarget } from '$lib/session.svelte';

  let { children } = $props();

  onMount(() => watchSession());

  $effect(() => {
    if (!session.ready) return;
    const target = redirectTarget(page.url.pathname, !!session.user);
    if (target) goto(target, { replaceState: true });
  });
</script>

{#if session.ready}
  {@render children()}
{:else}
  <div class="grid min-h-dvh place-items-center text-sm text-slate-500">Loading…</div>
{/if}
```

- [ ] **Step 6: Verify the whole suite still passes and it builds**

Run: `npm test && npm run build && npm run check:build`
Expected: all tests PASS, `PASS: static output has both entry points`.

- [ ] **Step 7: Commit**

```bash
git add src/lib/supabase.ts src/lib/session.svelte.ts src/lib/session.test.ts src/routes/+layout.svelte
git commit -m "feat: supabase client, session rune, route guard

The guard's decision is a pure function so it can be tested without a browser
or a live session. /shared/ stays reachable signed-out -- it is the one route
that is public by design."
```

---

### Task 5: Login screen

**Files:**
- Create: `src/routes/login/+page.svelte`

**Interfaces:**
- Consumes: `signIn` from `$lib/session.svelte`.
- Produces: nothing other tasks import.

- [ ] **Step 1: Write the page**

Create `src/routes/login/+page.svelte`:

```svelte
<script lang="ts">
  import { signIn } from '$lib/session.svelte';

  let email = $state('');
  let status = $state<'idle' | 'sending' | 'sent'>('idle');
  let error = $state<string | null>(null);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    status = 'sending';
    error = null;
    const result = await signIn(email);
    if (result.error) {
      error = result.error;
      status = 'idle';
    } else {
      status = 'sent';
    }
  }
</script>

<main class="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 p-6">
  <h1 class="text-3xl font-semibold tracking-tight">TravelMate</h1>

  {#if status === 'sent'}
    <p class="rounded-lg bg-emerald-50 p-4 text-sm text-emerald-900">
      Check <strong>{email}</strong> for a sign-in link.
    </p>
  {:else}
    <form onsubmit={submit} class="flex flex-col gap-3">
      <label class="text-sm font-medium" for="email">Email</label>
      <input
        id="email"
        type="email"
        required
        autocomplete="email"
        bind:value={email}
        placeholder="you@example.com"
        class="rounded-lg border border-slate-300 px-4 py-3 text-base"
      />
      {#if error}
        <p class="text-sm text-red-600">{error}</p>
      {/if}
      <button
        type="submit"
        disabled={status === 'sending'}
        class="rounded-lg bg-slate-900 px-4 py-3 text-base font-medium text-white disabled:opacity-50"
      >
        {status === 'sending' ? 'Sending…' : 'Send me a link'}
      </button>
    </form>
  {/if}
</main>
```

- [ ] **Step 2: Verify it manually**

Run: `npm run dev`, open `http://localhost:5173/login`, enter a real address, submit.
Expected: the confirmation panel appears; the email arrives within a minute; clicking the link returns to the app signed in, and the guard moves you to `/`.

If the link lands on a blank page, the redirect URL is not in Supabase → Authentication → URL Configuration. That is the prerequisite, not a code bug.

- [ ] **Step 3: Commit**

```bash
git add src/routes/login
git commit -m "feat: magic-link login screen"
```

---

### Task 6: Trip list and create wizard

**Files:**
- Create: `src/lib/trip/repo.ts`, `src/lib/trip/repo.test.ts`, `src/routes/trip/new/+page.svelte`
- Modify: `src/routes/+page.svelte`

**Interfaces:**
- Consumes: `supabase`, `Trip` and `tripDays` from Task 2.
- Produces:
  - `type TripRow` — the database shape
  - `toTrip(row: TripRow): Trip` — maps a row to the pure Task 2 type
  - `listTrips(): Promise<TripRow[]>`
  - `createTrip(input: NewTrip): Promise<string>` — returns the new trip id

- [ ] **Step 1: Write the failing test for the row mapping**

Create `src/lib/trip/repo.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { toTrip, type TripRow } from './repo';
import { tripDays } from './days';

const row: TripRow = {
  id: 't1',
  user_id: 'u1',
  name: 'Rome',
  city: 'Rome',
  timezone: 'Europe/Rome',
  hotel_name: 'Hotel Artemide',
  hotel_lat: 41.8986,
  hotel_lng: 12.4768,
  arrival_at: '2026-04-10T13:00:00Z',
  departure_at: '2026-04-13T08:00:00Z',
  arrival_point_name: 'Fiumicino',
  arrival_point_lat: 41.8003,
  arrival_point_lng: 12.2389,
  departure_point_name: null,
  departure_point_lat: null,
  departure_point_lng: null,
  arrival_buffer_min: 45,
  departure_buffer_min: 120,
  bag_drop_min: 30,
  allowed_modes: ['walk', 'transit'],
  day_start: '09:00:00',
  day_end: '19:00:00',
  share_token: null,
  created_at: '2026-03-01T00:00:00Z'
};

describe('toTrip', () => {
  it('produces a Trip the day derivation accepts', () => {
    expect(tripDays(toTrip(row))).toHaveLength(4);
  });

  it('carries the arrival point through', () => {
    expect(toTrip(row).arrivalPoint).toEqual({
      name: 'Fiumicino',
      at: { lat: 41.8003, lng: 12.2389 }
    });
  });

  it('maps a missing departure point to null, not a half-built place', () => {
    expect(toTrip(row).departurePoint).toBeNull();
  });

  it('trims postgres time values to HH:MM', () => {
    const trip = toTrip(row);
    expect(trip.dayStart).toBe('09:00');
    expect(trip.dayEnd).toBe('19:00');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/trip/repo.test.ts`
Expected: FAIL — cannot resolve `./repo`.

- [ ] **Step 3: Write the repository**

Create `src/lib/trip/repo.ts`:

```ts
import { supabase } from '$lib/supabase';
import type { Place, Trip } from './days';

export type TripRow = {
  id: string;
  user_id: string;
  name: string;
  city: string;
  timezone: string;
  hotel_name: string;
  hotel_lat: number;
  hotel_lng: number;
  arrival_at: string;
  departure_at: string;
  arrival_point_name: string | null;
  arrival_point_lat: number | null;
  arrival_point_lng: number | null;
  departure_point_name: string | null;
  departure_point_lat: number | null;
  departure_point_lng: number | null;
  arrival_buffer_min: number;
  departure_buffer_min: number;
  bag_drop_min: number;
  allowed_modes: string[];
  day_start: string;
  day_end: string;
  share_token: string | null;
  created_at: string;
};

export type NewTrip = {
  name: string;
  city: string;
  timezone: string;
  hotelName: string;
  hotelLat: number;
  hotelLng: number;
  arrivalAt: string;
  departureAt: string;
};

function place(name: string | null, lat: number | null, lng: number | null): Place | null {
  // The column constraint forbids a half-set pair, so either all three are
  // present or the point is genuinely absent.
  return name !== null && lat !== null && lng !== null ? { name, at: { lat, lng } } : null;
}

/** Postgres renders `time` as HH:MM:SS; the pure module speaks HH:MM. */
const hhmm = (t: string) => t.slice(0, 5);

export function toTrip(row: TripRow): Trip {
  return {
    hotelName: row.hotel_name,
    hotel: { lat: row.hotel_lat, lng: row.hotel_lng },
    timezone: row.timezone,
    arrivalAt: row.arrival_at,
    departureAt: row.departure_at,
    arrivalPoint: place(row.arrival_point_name, row.arrival_point_lat, row.arrival_point_lng),
    departurePoint: place(row.departure_point_name, row.departure_point_lat, row.departure_point_lng),
    arrivalBufferMin: row.arrival_buffer_min,
    departureBufferMin: row.departure_buffer_min,
    bagDropMin: row.bag_drop_min,
    dayStart: hhmm(row.day_start),
    dayEnd: hhmm(row.day_end)
  };
}

export async function listTrips(): Promise<TripRow[]> {
  const { data, error } = await supabase
    .from('trips')
    .select('*')
    .order('arrival_at', { ascending: true });
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function createTrip(input: NewTrip): Promise<string> {
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) throw new Error('Not signed in');

  const { data, error } = await supabase
    .from('trips')
    .insert({
      user_id: auth.user.id,
      name: input.name,
      city: input.city,
      timezone: input.timezone,
      hotel_name: input.hotelName,
      hotel_lat: input.hotelLat,
      hotel_lng: input.hotelLng,
      arrival_at: input.arrivalAt,
      departure_at: input.departureAt
    })
    .select('id')
    .single();
  if (error) throw new Error(error.message);
  return data.id;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/trip/repo.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Write the trip list**

Replace `src/routes/+page.svelte`:

```svelte
<script lang="ts">
  import { onMount } from 'svelte';
  import { listTrips, toTrip, type TripRow } from '$lib/trip/repo';
  import { tripDays } from '$lib/trip/days';
  import { signOut } from '$lib/session.svelte';
  import { base } from '$app/paths';

  let trips = $state<TripRow[]>([]);
  let error = $state<string | null>(null);
  let loading = $state(true);

  onMount(async () => {
    try {
      trips = await listTrips();
    } catch (e) {
      error = (e as Error).message;
    } finally {
      loading = false;
    }
  });

  const dayCount = (row: TripRow) => tripDays(toTrip(row)).length;
</script>

<main class="mx-auto max-w-lg p-6 pb-28">
  <header class="mb-6 flex items-baseline justify-between">
    <h1 class="text-2xl font-semibold tracking-tight">Your trips</h1>
    <button onclick={signOut} class="text-sm text-slate-500 underline">Sign out</button>
  </header>

  {#if loading}
    <p class="text-sm text-slate-500">Loading…</p>
  {:else if error}
    <p class="text-sm text-red-600">{error}</p>
  {:else if trips.length === 0}
    <p class="rounded-lg bg-slate-100 p-6 text-sm text-slate-600">
      No trips yet. Where are you going?
    </p>
  {:else}
    <ul class="flex flex-col gap-3">
      {#each trips as trip (trip.id)}
        <li>
          <a href="{base}/trip/{trip.id}" class="block rounded-xl border border-slate-200 p-4">
            <p class="text-lg font-medium">{trip.city}</p>
            <p class="text-sm text-slate-500">
              {new Date(trip.arrival_at).toLocaleDateString()} · {dayCount(trip)} days
            </p>
          </a>
        </li>
      {/each}
    </ul>
  {/if}

  <a
    href="{base}/trip/new"
    class="fixed inset-x-6 bottom-6 mx-auto max-w-lg rounded-xl bg-slate-900 py-4 text-center text-base font-medium text-white"
  >
    Plan a new trip
  </a>
</main>
```

- [ ] **Step 6: Write the wizard**

Create `src/routes/trip/new/+page.svelte`:

```svelte
<script lang="ts">
  import { goto } from '$app/navigation';
  import { base } from '$app/paths';
  import { createTrip } from '$lib/trip/repo';

  let step = $state(1);
  let city = $state('');
  let hotelName = $state('');
  let arrivalAt = $state('');
  let departureAt = $state('');
  let saving = $state(false);
  let error = $state<string | null>(null);

  // Phase 2 replaces this with a real geocode through the POI seam. Until then
  // the hotel has a name but no position, and the map has nothing to centre on.
  // ponytail: hardcoded 0,0 -- replace with poi.search() in phase 2.
  const PLACEHOLDER = { lat: 0, lng: 0 };

  // The browser's zone is the best guess available without geocoding; the
  // wizard shows it so a traveller planning from home can correct it.
  let timezone = $state(Intl.DateTimeFormat().resolvedOptions().timeZone);

  const canAdvance = $derived(
    step === 1 ? city.trim() !== '' && hotelName.trim() !== ''
    : step === 2 ? arrivalAt !== '' && departureAt !== '' && departureAt > arrivalAt
    : true
  );

  async function save() {
    saving = true;
    error = null;
    try {
      const id = await createTrip({
        name: city,
        city,
        timezone,
        hotelName,
        hotelLat: PLACEHOLDER.lat,
        hotelLng: PLACEHOLDER.lng,
        arrivalAt: new Date(arrivalAt).toISOString(),
        departureAt: new Date(departureAt).toISOString()
      });
      await goto(`${base}/trip/${id}`);
    } catch (e) {
      error = (e as Error).message;
      saving = false;
    }
  }
</script>

<main class="mx-auto flex min-h-dvh max-w-lg flex-col p-6 pb-28">
  <p class="mb-1 text-sm text-slate-500">Step {step} of 3</p>
  <h1 class="mb-6 text-2xl font-semibold tracking-tight">
    {step === 1 ? 'Where are you going?' : step === 2 ? 'When?' : 'Check and save'}
  </h1>

  {#if step === 1}
    <label class="mb-2 text-sm font-medium" for="city">City</label>
    <input id="city" bind:value={city} placeholder="Rome"
      class="mb-5 rounded-lg border border-slate-300 px-4 py-3 text-base" />

    <label class="mb-2 text-sm font-medium" for="hotel">Hotel</label>
    <input id="hotel" bind:value={hotelName} placeholder="Hotel Artemide"
      class="rounded-lg border border-slate-300 px-4 py-3 text-base" />
  {:else if step === 2}
    <label class="mb-2 text-sm font-medium" for="arr">Arrival</label>
    <input id="arr" type="datetime-local" bind:value={arrivalAt}
      class="mb-5 rounded-lg border border-slate-300 px-4 py-3 text-base" />

    <label class="mb-2 text-sm font-medium" for="dep">Departure</label>
    <input id="dep" type="datetime-local" bind:value={departureAt}
      class="mb-5 rounded-lg border border-slate-300 px-4 py-3 text-base" />

    <label class="mb-2 text-sm font-medium" for="tz">Timezone</label>
    <input id="tz" bind:value={timezone}
      class="rounded-lg border border-slate-300 px-4 py-3 text-base" />
    <p class="mt-2 text-sm text-slate-500">Times are local to the city you're visiting.</p>
  {:else}
    <dl class="flex flex-col gap-3 text-base">
      <div><dt class="text-sm text-slate-500">City</dt><dd>{city}</dd></div>
      <div><dt class="text-sm text-slate-500">Hotel</dt><dd>{hotelName}</dd></div>
      <div><dt class="text-sm text-slate-500">Arrival</dt><dd>{arrivalAt}</dd></div>
      <div><dt class="text-sm text-slate-500">Departure</dt><dd>{departureAt}</dd></div>
      <div><dt class="text-sm text-slate-500">Timezone</dt><dd>{timezone}</dd></div>
    </dl>
    {#if error}<p class="mt-4 text-sm text-red-600">{error}</p>{/if}
  {/if}

  <div class="fixed inset-x-6 bottom-6 mx-auto flex max-w-lg gap-3">
    <button
      onclick={() => (step > 1 ? step-- : goto(`${base}/`))}
      class="rounded-xl border border-slate-300 px-5 py-4 text-base"
    >Back</button>

    {#if step < 3}
      <button
        disabled={!canAdvance}
        onclick={() => step++}
        class="flex-1 rounded-xl bg-slate-900 py-4 text-base font-medium text-white disabled:opacity-40"
      >Next</button>
    {:else}
      <button
        disabled={saving}
        onclick={save}
        class="flex-1 rounded-xl bg-slate-900 py-4 text-base font-medium text-white disabled:opacity-40"
      >{saving ? 'Saving…' : 'Save trip'}</button>
    {/if}
  </div>
</main>
```

- [ ] **Step 7: Verify end to end**

Run: `npm test` — expected: all PASS.
Then `npm run dev`, sign in, create a trip, and confirm it appears in the list with the right day count.

Then confirm isolation, which is the one thing unit tests cannot cover: sign in as a second address and check the list is empty. If the first user's trip appears, the RLS policy from Task 3 is wrong and nothing else in this plan matters.

- [ ] **Step 8: Commit**

```bash
git add src/lib/trip/repo.ts src/lib/trip/repo.test.ts src/routes/+page.svelte src/routes/trip/new
git commit -m "feat: trip list and three-step create wizard

Row-to-domain mapping is tested against the day derivation, so a schema
change that breaks planning fails in CI rather than in the timeline.

Hotel coordinates are a placeholder until the phase 2 geocode seam exists."
```

---

### Task 7: Deploy to GitHub Pages

**Files:**
- Create: `.github/workflows/deploy.yml`

**Interfaces:**
- Consumes: `npm run build`, `npm test` from Task 1.
- Produces: a published site.

- [ ] **Step 1: Write the workflow**

Create `.github/workflows/deploy.yml`:

```yaml
name: Deploy

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: true

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npm test
      - run: npm run build
        env:
          # Pages serves the site from /<repo>, so assets need that prefix.
          BASE_PATH: /${{ github.event.repository.name }}
          PUBLIC_SUPABASE_URL: ${{ secrets.PUBLIC_SUPABASE_URL }}
          PUBLIC_SUPABASE_ANON_KEY: ${{ secrets.PUBLIC_SUPABASE_ANON_KEY }}
      - run: ./scripts/check-build.sh
      - uses: actions/upload-pages-artifact@v3
        with:
          path: build

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deploy.outputs.page_url }}
    steps:
      - id: deploy
        uses: actions/deploy-pages@v4
```

- [ ] **Step 2: Configure the repository**

In GitHub → Settings → Secrets and variables → Actions, add `PUBLIC_SUPABASE_URL` and `PUBLIC_SUPABASE_ANON_KEY`.
In GitHub → Settings → Pages, set Source to **GitHub Actions**.

Only the anon key goes here. The service-role key must never enter CI.

- [ ] **Step 3: Add the deployed URL to Supabase**

Add `https://<user>.github.io/<repo>/` to Supabase → Authentication → URL Configuration → Redirect URLs.

Magic links sent from the deployed site fail silently without this, and the failure looks like a broken login rather than a missing configuration.

- [ ] **Step 4: Push and verify**

Run: `git push -u origin main`
Expected: the Deploy workflow succeeds and the site loads at the Pages URL. Sign in there and create a trip to confirm the round trip works against the real redirect URL.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/deploy.yml
git commit -m "ci: build, test and publish to GitHub Pages

BASE_PATH is injected so assets resolve under the repository subpath, and
check-build.sh gates the upload -- a build missing index.html would deploy a
site that 404s at its own root."
```

---

## Done when

- `npm test` passes.
- `npm run build && npm run check:build` passes.
- A traveller can sign in by magic link, create a trip, and see it listed with the correct number of days.
- A second account sees an empty list.
- The deployed Pages site does all of the above.

## Deliberately not in phase 1

- Hotel and airport geocoding — needs the phase 2 POI seam. Coordinates are `0,0` until then, which is why no map appears yet.
- `/trip/[id]` — the wizard redirects to it and it will 404 until phase 2. Acceptable: phase 1's deliverable is the trip existing, not the trip being viewable.
- Editing or deleting a trip.
- `allowed_modes`, `day_start`, `day_end`, and the buffers are schema defaults with no UI. The wizard sets them implicitly; phase 3 gives them controls when the planner can act on them.
