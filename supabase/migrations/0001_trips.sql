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
