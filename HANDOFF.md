# TravelMate — handoff

Two pieces of work, A and B. A is small and contained; B changes how the app
gets its data. Both are written for someone who has not seen this repo.

Read the contract first. It is not a wish list — every line of it has been
broken at least once, and that is why it is written down.

---

## The contract

1. **Single-page PWA.** One document, client-side routing, installable, served
   static from GitHub Pages under `/TravelMate/`. There is no server: auth,
   data and planning all happen in the browser against Supabase.
2. **Usable and reliable offline.** This was the first requirement of the
   project. Opening the app without a connection must give the traveller their
   trip, not a blank screen and not an error.
3. **Snappy at all times.** Every interaction is immediate. The only thing
   allowed to take longer is Replan: under 10 seconds, under 3 preferred.
4. **A new version is taken when the app is opened**, never while it is in
   use. See "Updates" below.
5. **No screen says "Loading".** A screen that has nothing yet draws the shape
   of what is coming.

---

## The domain, as it stands

### Everything holds a clock

A day is its cards in the order their clocks read. There is no position, no
index, no ordering column — `placements.at` (a `timestamptz`, not null) is
both when a card happens and where it sits. Moving a card *is* setting its
clock; they are the same act. Anything that reintroduces a separate ordering
field is a regression.

A **placement** is one visit. The wishlist (`pois`) is what the traveller
wants to see; a placement is a decision to be somewhere at a time. One place
can have many placements (the same cafe on Tuesday and Thursday) and removing
a placement says nothing about the wishlist row.

`placements.kind` is one of:

- `stop` — a visit to a wishlist place. `poi_id` not null (enforced).
- `hotel` — the hotel: the card a day starts from, the one it is slept in, a
  return in the afternoon.
- `chore` — time the trip spends on itself: getting ready, checking in,
  checking out.
- `meal` — a sitting. `placements.meal` says which (`breakfast`/`lunch`/
  `dinner`), and is null for every other kind (enforced).

`hotel`, `chore` and `meal` cards are collectively **the day's furniture**.
They are placements like any other: the traveller places, moves and removes
them. Nothing regenerates them behind the traveller's back.

### Who may move what

- **The traveller is sovereign.** Anything they did stands. It is never
  silently moved, dropped or deleted. A drag is a statement of fact.
- **`replan()`** is the only thing allowed to rearrange a day: it assigns
  places to days, orders them, and writes new clocks.
- **`schedule()`** (the re-time) never reorders, never drops, never re-seats.
  It walks the day and writes times.
- A **pin** means Replan may not move that card. Pins are set by the traveller
  and by nothing else. The traveller can always move a pinned card themselves.
- In a re-time, **furniture and pinned cards keep their stated clock**. A free
  card moves forward to when the traveller actually arrives — a leg is
  movement and movement takes time — and never backwards: arriving early is
  waiting.
- When a re-time cannot reach a card that is not allowed to move, something
  has to give and the plan may not choose what. The card the day breaks on is
  marked (a `blocked` warning; the UI draws an exclamation mark and says what
  can no longer be reached) and it is the traveller's to resolve, or Replan's.

### The journeys are atomic

The way in and the way out are the tickets the traveller holds: airport,
flight, airport; station, train, station. They are built from
`trips.arrival_legs` / `departure_legs`, each card carries the instant off its
ticket, and their order is the ticket's. They are never reordered, never split,
and they are not drop targets.

The day's window follows from them: **the first day begins when the last card
of the way in is finished** (off the plane, through the queue, out of the
terminal) and **the last day is over the minute the way out begins** (when the
traveller must be at the terminal, not when the plane goes). The hours outside
that are not empty time to be filled — nothing goes there, by the plan or by
hand.

A day ends at the hotel it is slept in. Replan draws one at the day's end when
the traveller has not placed one, except on the day they fly home.

---

## How the data is laid out

Supabase project `sechvnxifsovxagfopzp`. Migrations are `supabase/migrations`,
numbered, applied in order; the schema is at 0051.

| Table | What it holds |
|---|---|
| `trips` | City, hotel, timezone, arrival/departure instants and points, journey legs (jsonb), day window, allowed modes, `furnished_days`, share token |
| `pois` | The wishlist: place, category, duration, priority, branches |
| `placements` | The visits and the furniture: `kind`, `poi_id`, `meal`, `day_index`, `at`, `pinned` |
| `plan_stops` | The plan of record: every card as drawn, with its times, its leg in, its warnings, and the `placement_id` it came from |
| `trip_meals` | What the traveller has said about a meal: which place, or that it is skipped. No time — a sitting's time is its placement's |
| `trip_members`, `profiles` | Who is on a trip, and their role (`viewer`/`editor`) |
| `events` | Telemetry |

Server-side pieces: `save_plan` (upserts a whole plan in one call),
`get_shared_trip` (read-only view for a share link), and three edge functions —
`travel` (matrix), `route` (one journey), `refine` (routes a stored plan's legs
in the background and writes the answers back).

### Facts about this database that have cost production time

- **RLS policy expressions execute as the caller, not as the table owner.** A
  helper function used inside a policy (`is_trip_member`, `can_edit_trip`,
  `shares_trip_with`) must be executable by `authenticated`, or every policy
  that calls it fails and collaborators see nothing. This was learned by
  breaking it.
- **The client and the schema must never disagree, and the database goes
  first.** Deploying a client that writes a column production does not have
  breaks the app for everyone immediately. Ship the migration, verify it, then
  push the code.
- **A column drop reaches further than the tables.** Dropping
  `pois.day_index` left `get_shared_trip` selecting a column that no longer
  existed, and every share link returned an error until the function was
  repaired. Grep the functions and views, not just the queries.
- Realtime is subscribed per trip on `plan_stops`; that is how a refined leg
  and another traveller's edit reach an open screen.

---

## What is wrong right now

### Offline is broken at the shell (this is work A)

Read off the deployed `sw.js`:

- The precache manifest contains the JS chunks and the two icons. **It
  contains no HTML** — not `index.html`, not `404.html`. Offline there is no
  document to serve.
- The navigation fallback is bound to `/`, while the app is served from
  `/TravelMate/`. It points at a URL that is not in the precache and cannot
  resolve.

Consequence: an offline open is a blank screen, at the root and at every deep
link. The app never boots, so nothing else about offline has ever been
exercised.

**Why**, traced through `@vite-pwa/sveltekit`: the integration does not read
SvelteKit's configuration. It takes what it needs through its own `kit`
option (`SvelteKitPWA({ kit: { ... } })`), and this project passes none. So it
falls back to assuming a site at the domain root with no adapter fallback
page, which has two consequences in its manifest transform: the fallback page
is filtered out of the precache (`excludeFallback`), and the navigation route
is bound to the base it assumed, `/`.

### Every read is a network round trip (this is work B)

Opening a trip issues six parallel reads (trip, placements, pois, plan_stops,
trip_meals, members) plus the profiles read that follows. Measured cold on a
local stack: first paint 196 ms, reads issued at 191 ms, last one back at
289 ms — the app itself is not slow. On a phone that is one round trip to
Frankfurt plus radio wake-up, and unbounded on a bad signal. Offline it is
nothing at all.

---

## Work A — the app opens offline

**The change:** tell the PWA integration what this app is, in
`vite.config.ts`, where `SvelteKitPWA` is configured:

```ts
SvelteKitPWA({
  kit: { adapterFallback: '404.html', spa: true },
  // ...everything already there
})
```

`adapterFallback` names the page `adapter-static` is configured to write —
the one page every route is drawn into. `spa` is what puts that page in the
precache with a revision of its own. Nothing in application code changes.

A build with those two settings emits `createHandlerBoundToURL("404.html")`
and a precache entry `{url:"404.html",revision:"..."}` — the two things
missing from the deployed worker today. That the build emits them is not the
point; the point is what the app does with the network off.

**Done when:** with the network off, opening `/TravelMate/` and
`/TravelMate/trip/<id>` both boot the app — the shell, the chrome, the
navigation — rather than a blank page or a browser error, and reloading each
while still offline does the same. Turning the network back on changes
nothing on screen except that data arrives.

**Constraints:** no loading screen for the offline case, and the worker still
does not take the page while it is in use (see Updates).

**Verify in a real browser**, offline, both URLs, both reloaded. The build
output is evidence of configuration, not of behaviour.

---

## Work B — local-first data

**The shape asked for:** the device holds the trip in its own database and
that is what the app reads and writes — immediately, online or off. Supabase
is where it is replicated to and from: changes go up when there is a
connection, other people's changes come down over the realtime channel as they
happen. The app never waits on the network to draw, and never waits on it to
accept an edit.

Caching and on-device storage are wanted, and are what makes this work. What
is not wanted is a cache used as a substitute for the store — serving an old
HTTP response and hoping it is close enough. The store is the source of
truth the app reads; the service worker's business is the shell, not the
data.

**Requirements**

1. Every read the UI performs is local and draws in the first frame. No
   spinner and no skeleton for anything the device already holds.
2. **Built on the store/mutation pattern.** State lives in a store that is
   the only way into the data. Nothing writes rows from a component: the store
   exposes named mutations (place a card, move it to a clock, remove it, set a
   duration, say what a meal is) and every change in the app is one of them.
   The mutation applies to IndexedDB and updates the state that the UI reads,
   in one step.
3. **Read caching and write durability are separate concerns.** The service
   worker caches the shell — the document, the code, the assets — and nothing
   else. Durability of what the traveller does belongs to IndexedDB: the data
   itself, and a `syncQueue` holding the mutations not yet accepted by the
   server. Background Sync replays that queue when connectivity returns, in
   the order the mutations were made.
4. **A mutation is a transaction.** It happens entirely or not at all: the
   store write, the queue entry and everything that follows from it land
   together, and a failure leaves the store exactly as it was. No partially
   applied edits, no rows pointing at rows that are not there.
5. **Concurrency control is stated, not improvised.** Two tabs of this app on
   one device must not lose each other's work; the rule for that case (the
   acting user's mutation wins, and the other tab is told) belongs in the
   store, written down, not discovered per call site.
6. Offline: the whole trip is usable — drag, place, remove, edit durations,
   re-time. Replan is the one thing that needs a connection (it prices real
   journeys), and says so plainly when there is none.
7. **Collaborators, in real time.** When online, a change made by one person
   reaches everyone else's open screen as it happens, and lands there as a
   mutation like any other. The realtime subscription exists for
   `plan_stops`; `placements`, `trip_meals` and `pois` need the same.
8. Sync respects RLS. A viewer's write is refused by the server; the local
   store must not pretend it succeeded. A refusal is shown, never swallowed,
   and the store is returned to what the server actually holds.
9. A queued mutation is replayed against the server as a whole and is either
   accepted or rejected — never half-applied.
10. **Conflicts are shown, never resolved behind the traveller's back.** A
   mutation carries the version of the row it was made against. If the row has
   moved on -- somebody else changed it while this device was away -- the
   server does not apply the mutation and the row is marked conflicted.

   - The local edit is **put aside**, not applied and not thrown away. It
     stays on the device and is not sent anywhere: a change the traveller has
     not confirmed never reaches the trip, and no collaborator sees it. The
     queue does not retry it.
   - The row draws what is upstream, in a card with an orange border and an
     exclamation mark: what the traveller sees is what is actually on the
     trip.
   - Tapping the card shows how the put-aside change would apply -- what it
     would alter, from what to what -- and offers exactly two answers:
     **accept** (keep the local change, overwrite upstream) or **reject**
     (keep upstream, drop the local change). Either answer clears the
     conflict.
   - Nothing else is blocked while a row is conflicted. The rest of the trip
     goes on being edited and synced.

   This needs a per-row version the mutation can be compared against --
   `updated_at` maintained by the database, or an explicit version column --
   on every table a mutation can touch. It does not exist yet; it is a
   migration, and the database goes first.
11. What must not regress: everything under "The domain, as it stands". In
   particular the clock model, the sovereignty of the traveller's gestures,
   the atomicity of the journeys, and the absence of any positional ordering.

**How it goes in: one cut-over, no compatibility path**

The app moves to the store and the old way is deleted in the same change.
There is no period where some reads come from the network and some from the
store, no flag selecting between them, and nothing kept on the server side to
keep an older client working. A client running the old version is out of date
and takes the new one when it is next opened; that is the whole migration
story. Two paths to the same data means two answers to every question, and
they disagree in production, not in review.

The order of the work, not of the shipping:

1. The store: its IndexedDB schema, the `syncQueue`, the mutations it exposes,
   and the transaction boundary around them.
2. The sync: what goes up, how Background Sync drains the queue, what comes
   down over realtime, and how a refusal is reported.
3. Every read and write in the app moved onto the store's mutations, and the
   direct-to-Supabase calls deleted.

Nothing is left behind that still speaks to the database on its own.

**Replan's budget:** under 10 seconds, under 3 preferred. It is a network
operation (matrix pricing through the `travel` edge function) and is the one
place a wait is acceptable. It must report progress while it works.

---

## Updates

A new version is taken **when the app is opened**, never while it is in use.
The worker does not claim an open page; the app asks for the new one during a
short window at startup, and a version that lands later waits for the next
opening. Do not change this to auto-update: a deploy reloading someone
mid-edit is the reason the rule exists.

---

## How this app is verified

There are no tests in this repo and none are wanted. They passed while every
fault in the app was found by the person using it, and they were deleted for
that reason. Do not reintroduce a test suite or a CI test step.

Verification is a real browser against a real stack: run the local Supabase,
run the dev server, drive Chromium over CDP, and look at what the app actually
does. Drags need touch emulation with a mobile device profile — under the
plain desktop profile the browser claims the gesture and the drag never
starts, which is an artefact of the harness, not of the app.

Check types with `npx svelte-check`, and build with `npm run build`. Neither
proves behaviour.

---

## Working with the owner

- **Write no code without explicit authorization for that specific change.**
  Reporting a fault is not a request to fix it. Diagnose, say what the cause
  is and what the fix would be, then stop and wait.
- No unrequested features, ever. If it was not asked for, it is not in scope —
  including "improvements" discovered along the way.
- No workarounds and no half-done work. If the proper thing cannot be built,
  say so and stop; do not ship the approximation.
- **Ask when blocked.** A blocker named early costs a question. A blocker
  guessed at costs the owner their evening.
- Say what is actually true about what was verified, and what was not. A
  claim that something works means it was seen working.
- The app is the product. Descriptions of it belong in the product's language:
  what the traveller sees, in their terms.
