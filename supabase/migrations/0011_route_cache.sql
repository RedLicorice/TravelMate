-- A routed leg: the actual journey, not just how long it takes.
--
-- Separate from travel_cache because it answers a different question. That one
-- answers "how long between every pair", asked for all pairs before ordering.
-- This answers "what do I actually catch", asked for the n-1 legs of a settled
-- plan, and carries the steps and the drawn line with it.
create table route_cache (
  from_key      text not null,
  to_key        text not null,
  mode          text not null check (mode in ('walk','bike','transit','car','carshare')),
  depart_bucket text not null,
  minutes       int not null check (minutes >= 0),
  km            numeric not null check (km >= 0),
  -- Google's encoded polyline, precision 5. Valhalla uses 6; decoding at the
  -- wrong precision puts the line in the wrong hemisphere.
  polyline      text,
  -- [{kind:'transit'|'walk', line, headsign, from, to, departAt, arriveAt,
  --   minutes, stops}] -- what to actually catch.
  steps         jsonb not null default '[]'::jsonb,
  observed_at   timestamptz not null default now(),
  expires_at    timestamptz not null,
  primary key (from_key, to_key, mode, depart_bucket)
);

alter table route_cache enable row level security;
create policy route_cache_read on route_cache
  for select to authenticated using (true);

create index route_cache_expiry on route_cache (expires_at);
