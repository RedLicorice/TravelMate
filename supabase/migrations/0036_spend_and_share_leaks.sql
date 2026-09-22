-- Who may spend, and what a link actually hands over.
--
-- Three separate holes, all of them about giving away more than was meant:
-- a signed-in traveller could spend the whole routing budget, a "have a look"
-- link carried the trip's booking references to anyone holding it, and the
-- two picture buckets could be listed by a stranger.

-- 1. The routing budget is per traveller, per day.
--
-- The Edge Functions now prove who is calling, but proving it was all they
-- did: one account could ask for a 625-element matrix in a loop, nudging a
-- coordinate each time so the cache never answered. Sign-up is open, so
-- "signed in" is thirty seconds of work. Count the elements instead.
create table function_spend (
  user_id  uuid not null references auth.users (id) on delete cascade,
  day      date not null default current_date,
  elements int  not null default 0 check (elements >= 0),
  primary key (user_id, day)
);

-- No policies: only the service role writes here, and it bypasses RLS. A
-- traveller has no business reading anyone's meter, including their own.
alter table function_spend enable row level security;

-- Charge for the work and say whether it is allowed. One statement, so two
-- calls at once cannot both read "under budget" and both spend.
create function spend(p_user uuid, p_elements int, p_cap int)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare allowed boolean;
begin
  insert into function_spend (user_id, day, elements)
  values (p_user, current_date, p_elements)
  on conflict (user_id, day) do update
    set elements = function_spend.elements + excluded.elements
    where function_spend.elements + excluded.elements <= p_cap
  returning true into allowed;

  return coalesce(allowed, false);
end;
$$;

revoke all on function spend(uuid, int, int) from public, anon, authenticated;

-- Old rows are a meter nobody reads.
create index function_spend_day on function_spend (day);

-- 2. A share link is a look at the trip, not at the tickets.
--
-- get_shared_trip served to_json(t): every column of the trip, which since
-- 0020 and 0021 includes the booking references. A PNR and a surname is
-- account access on most airlines, and the link is handed around in chat.
-- The joining token and the owner's auth uid went with it. Serve the trip
-- without them, and without the uids of whoever added each place.
create or replace function get_shared_trip(token uuid)
returns json
language sql
stable
security definer
set search_path = public
as $$
  select json_build_object(
    'trip', to_jsonb(t)
              - 'arrival_booking_ref'
              - 'departure_booking_ref'
              - 'share_token'
              - 'user_id'
              || jsonb_build_object(
                   'arrival_legs', (
                     select coalesce(jsonb_agg(leg - 'bookingRef'), '[]'::jsonb)
                     from jsonb_array_elements(coalesce(t.arrival_legs, '[]'::jsonb)) leg),
                   'departure_legs', (
                     select coalesce(jsonb_agg(leg - 'bookingRef'), '[]'::jsonb)
                     from jsonb_array_elements(coalesce(t.departure_legs, '[]'::jsonb)) leg)),
    'pois', coalesce((select jsonb_agg((to_jsonb(p) - 'added_by') order by p.day_index, p.order_index)
                      from pois p where p.trip_id = t.id), '[]'::jsonb),
    'plan', coalesce((select jsonb_agg(to_jsonb(s) order by s.day_index, s.order_index)
                      from plan_stops s where s.trip_id = t.id), '[]'::jsonb)
  )
  from trips t
  where t.share_token = token;
$$;

revoke all on function get_shared_trip(uuid) from public;
grant execute on function get_shared_trip(uuid) to anon, authenticated;

-- 3. The buckets are public to read a picture, not to be walked.
--
-- A public bucket serves an object without consulting a policy at all; the
-- select policy is what answers list(). Granted to everyone, it let a
-- stranger list the avatars folder -- one folder per account, named with the
-- auth uid -- and the trip-images folder, one per trip.
drop policy if exists "avatars are readable by anyone" on storage.objects;
drop policy if exists "trip images are readable by anyone" on storage.objects;

create policy "a traveller lists their own avatar" on storage.objects
  for select to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "a member lists that trip's image" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'trip-images'
    and is_trip_member(((storage.foldername(name))[1])::uuid)
  );

-- 4. The owner can put someone off the trip.
--
-- Membership could be joined but never revoked: clearing the share token only
-- stopped new arrivals. Whoever had once followed the link stayed an editor
-- for the life of the trip, and the owner's only remedy was deleting it.
create policy trip_members_owner_removes on trip_members
  for delete using (
    exists (select 1 from trips t where t.id = trip_members.trip_id and t.user_id = auth.uid())
    and user_id <> auth.uid()
  );

-- The owner leaving their own trip leaves it with no members and no owner,
-- and shares_trip_with then answers "no" for the person who owns it.
drop policy trip_members_leave on trip_members;
create policy trip_members_leave on trip_members
  for delete using (user_id = auth.uid() and role <> 'owner');

-- 5. The membership helpers answer questions about the caller, so nothing
-- leaks through them -- but every other definer function here is revoked from
-- public, and a definer left callable by anon is one refactor away from
-- mattering.
revoke all on function is_trip_member(uuid) from public, anon, authenticated;
revoke all on function shares_trip_with(uuid) from public, anon, authenticated;

-- 6. Nobody reads the caches but the functions, which use the service role.
--
-- A read policy that no client uses is a list of where other people's trips
-- go, rounded to a metre, available to anyone with an account.
drop policy travel_cache_read on travel_cache;
drop policy route_cache_read on route_cache;

-- 7. Who added a place is answered by the server.
--
-- added_by was a default, not a constraint: any member could write a place
-- attributed to a fellow traveller.
create function pois_added_by_caller()
returns trigger language plpgsql security invoker set search_path = public as $$
begin
  new.added_by := auth.uid();
  return new;
end;
$$;

create trigger pois_added_by before insert on pois
  for each row execute function pois_added_by_caller();

-- An update could still rewrite it, or move a place onto another trip, since
-- pois_member_write is `for all` with nothing to say about columns.
revoke update (added_by, trip_id) on pois from authenticated;

-- 8. Two plans written at once still interleaved.
--
-- 0035 made the write one statement pair, which stops a caller seeing half a
-- plan, but not two callers deleting on the same snapshot and then both
-- inserting. Take the trip's lock first: the second caller waits, deletes what
-- the first wrote, and the plan is whichever one finished last -- one plan,
-- not both at once.
create or replace function replace_plan(trip uuid, rows jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  perform pg_advisory_xact_lock(hashtext(trip::text));

  -- RLS still applies: security invoker, so a caller who is not a member of
  -- the trip deletes nothing and inserts nothing.
  delete from plan_stops where trip_id = trip;

  insert into plan_stops (
    trip_id, day_index, order_index, poi_id, name, lat, lng, anchor, anchor_kind,
    time_label, starts_at, ends_at, duration_min, pinned, leg_mode, leg_minutes,
    leg_km, warnings, busyness, exit_lat, exit_lng
  )
  select
    trip,
    (r->>'day_index')::int,
    (r->>'order_index')::int,
    nullif(r->>'poi_id', '')::uuid,
    r->>'name',
    (r->>'lat')::double precision,
    (r->>'lng')::double precision,
    (r->>'anchor')::boolean,
    nullif(r->>'anchor_kind', ''),
    nullif(r->>'time_label', ''),
    (r->>'starts_at')::timestamptz,
    (r->>'ends_at')::timestamptz,
    (r->>'duration_min')::int,
    (r->>'pinned')::boolean,
    nullif(r->>'leg_mode', ''),
    nullif(r->>'leg_minutes', '')::int,
    nullif(r->>'leg_km', '')::numeric,
    coalesce(r->'warnings', '[]'::jsonb),
    nullif(r->>'busyness', '')::numeric,
    nullif(r->>'exit_lat', '')::double precision,
    nullif(r->>'exit_lng', '')::double precision
  from jsonb_array_elements(rows) as r;
end;
$$;

revoke all on function replace_plan(uuid, jsonb) from public;
grant execute on function replace_plan(uuid, jsonb) to authenticated;
