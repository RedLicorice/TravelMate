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
