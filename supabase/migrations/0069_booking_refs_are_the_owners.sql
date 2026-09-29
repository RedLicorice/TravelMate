-- Booking references and the share link are the owner's.
--
-- Everybody on a trip could read the whole of the trip's row, and the row
-- carried the booking references -- the two columns and one per leg inside
-- the journeys -- and the share token. Anybody holding the link can join,
-- so anybody the link reached could read the references. And a viewer taken
-- off the trip kept the token, and with it the way straight back on.
--
-- Both now live in trip_private, one row per trip, which only the trip's
-- owner can read or write. The journeys stay on the trip -- the planner and
-- every traveller need them -- without their references: those are kept
-- beside them, one per leg, in the order the legs are in. The two columns
-- were only ever the first and last of those, so they go.
--
-- And taking somebody off the trip turns the key: the link changes, so what
-- they held opens nothing. Leaving of one's own accord does not -- that
-- would break the link the owner sent everybody else each time anybody
-- left, to keep out somebody who chose to go.
--
-- Safe to run twice.

create table if not exists trip_private (
  trip_id uuid primary key references trips (id) on delete cascade,
  -- The booking reference of each leg of the journey in, by the leg's place
  -- in trips.arrival_legs; null where the leg has none.
  arrival_refs jsonb not null default '[]',
  departure_refs jsonb not null default '[]',
  share_token uuid unique,
  version bigint not null default 1
);

alter table trip_private enable row level security;
revoke all on trip_private from anon;

drop policy if exists trip_private_owner on trip_private;
create policy trip_private_owner on trip_private
  for all to authenticated
  using (exists (select 1 from trips t where t.id = trip_private.trip_id and t.user_id = auth.uid()))
  with check (exists (select 1 from trips t where t.id = trip_private.trip_id and t.user_id = auth.uid()));

-- What is there moves across, before the columns go. A reference typed into
-- the column but not the leg -- the columns were written from the legs, so
-- there should be none -- lands on the leg it was always the reference of.
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'trips' and column_name = 'share_token') then
    insert into trip_private (trip_id, arrival_refs, departure_refs, share_token)
    select t.id,
           (select coalesce(jsonb_agg(leg->'bookingRef' order by n), '[]')
              from jsonb_array_elements(coalesce(t.arrival_legs, '[]')) with ordinality e(leg, n)),
           (select coalesce(jsonb_agg(leg->'bookingRef' order by n), '[]')
              from jsonb_array_elements(coalesce(t.departure_legs, '[]')) with ordinality e(leg, n)),
           t.share_token
    from trips t
    on conflict (trip_id) do nothing;

    update trip_private p
      set arrival_refs = jsonb_set(p.arrival_refs, array[(jsonb_array_length(p.arrival_refs) - 1)::text],
                                   to_jsonb(t.arrival_booking_ref))
      from trips t
      where t.id = p.trip_id and t.arrival_booking_ref is not null
        and jsonb_array_length(p.arrival_refs) > 0 and p.arrival_refs->-1 = 'null';
    update trip_private p
      set departure_refs = jsonb_set(p.departure_refs, '{0}', to_jsonb(t.departure_booking_ref))
      from trips t
      where t.id = p.trip_id and t.departure_booking_ref is not null
        and jsonb_array_length(p.departure_refs) > 0 and p.departure_refs->0 = 'null';
  end if;
end $$;

-- Counted from here on, like every row an edit can touch (0052).
drop trigger if exists trip_private_version on trip_private;
create trigger trip_private_version before update on trip_private
  for each row execute function bump_version();

-- The references come off the legs. Not counted as an edit: nobody changed
-- the journey, and a device holding the trip should not find its next edit
-- in conflict with a migration.
alter table trips disable trigger trips_version;
update trips
  set arrival_legs = (select jsonb_agg(leg - 'bookingRef' order by n)
                        from jsonb_array_elements(arrival_legs) with ordinality e(leg, n))
  where jsonb_path_exists(arrival_legs, '$[*].bookingRef');
update trips
  set departure_legs = (select jsonb_agg(leg - 'bookingRef' order by n)
                          from jsonb_array_elements(departure_legs) with ordinality e(leg, n))
  where jsonb_path_exists(departure_legs, '$[*].bookingRef');
alter table trips enable trigger trips_version;

-- And stay off: a device on the app as it was would write them straight back.
alter table trips drop constraint if exists legs_carry_no_booking_refs;
alter table trips add constraint legs_carry_no_booking_refs check (
  not jsonb_path_exists(arrival_legs, '$[*].bookingRef')
  and not jsonb_path_exists(departure_legs, '$[*].bookingRef')
);

-- Joining looks the link up where it lives now.
create or replace function join_trip(token uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare target uuid;
begin
  if auth.uid() is null then
    raise exception 'must be signed in to join';
  end if;

  select trip_id into target from trip_private where share_token = token;
  if target is null then
    return null;  -- unknown or revoked: same answer, so neither is confirmed
  end if;

  insert into trip_members (trip_id, user_id, role)
  values (target, auth.uid(), 'viewer')
  on conflict (trip_id, user_id) do nothing;

  return target;
end;
$$;

revoke all on function join_trip(uuid) from public;
grant execute on function join_trip(uuid) to authenticated;

-- So does the shared page. What it hid by hand is no longer on the trip.
create or replace function get_shared_trip(token uuid)
returns json
language sql
stable
security definer
set search_path = public
as $$
  select json_build_object(
    'trip', to_jsonb(t) - 'user_id',
    'pois', coalesce((select jsonb_agg((to_jsonb(p) - 'added_by') order by p.created_at)
                      from pois p where p.trip_id = t.id), '[]'::jsonb),
    'plan', coalesce((select jsonb_agg(to_jsonb(s) order by s.day_index, s.order_index)
                      from plan_stops s where s.trip_id = t.id), '[]'::jsonb)
  )
  from trip_private k
  join trips t on t.id = k.trip_id
  where k.share_token = token;
$$;

revoke all on function get_shared_trip(uuid) from public;
grant execute on function get_shared_trip(uuid) to anon, authenticated;

alter table trips drop column if exists arrival_booking_ref;
alter table trips drop column if exists departure_booking_ref;
alter table trips drop column if exists share_token;

-- Taken off the trip: the link changes. On the owner's say-so, not the
-- leaver's, and not for the owner's own row, which only goes with the trip.
-- Definer, because the owner's delete is what fires it and the row it
-- changes is one only the owner may write -- and so that it holds however
-- the membership is removed.
create or replace function taking_someone_off_turns_the_key()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.role <> 'owner' and old.user_id is distinct from auth.uid() then
    update trip_private set share_token = gen_random_uuid()
      where trip_id = old.trip_id and share_token is not null;
  end if;
  return old;
end;
$$;
revoke all on function taking_someone_off_turns_the_key() from public, anon, authenticated;

drop trigger if exists taking_someone_off_turns_the_key on trip_members;
create trigger taking_someone_off_turns_the_key after delete on trip_members
  for each row execute function taking_someone_off_turns_the_key();

-- The owner's other devices hear of a new link as it happens.
do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'trip_private') then
    alter publication supabase_realtime add table trip_private;
  end if;
end $$;

-- An edit may write it, locked by its trip like the trip's other rows.
create or replace function apply_mutation(mutation uuid, ops jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  allowed constant text[] := '{trips,pois,placements,trip_members,trip_private,profiles}';
  o jsonb;
  i int := 0;
  tbl text;
  cols text;
  found_row jsonb;
  written jsonb;
  results jsonb := '[]';
  conflicts jsonb := '[]';
  lock_key text;
  lock_keys text[] := '{}';
begin
  for o in select * from jsonb_array_elements(ops) loop
    tbl := o->>'table';
    if o->>'op' = 'plan' then
      lock_key := o->>'trip';
    elsif not tbl = any (allowed) then
      raise exception 'apply_mutation: % is not a table an edit may write', tbl
        using errcode = '42501';
    elsif tbl = 'trips' then
      lock_key := o->'key'->>'id';
    elsif tbl = 'profiles' then
      lock_key := o->'key'->>'user_id';
    elsif tbl in ('trip_members', 'trip_private') then
      lock_key := o->'key'->>'trip_id';
    else
      -- A place or a card: its trip is on the row, or on the values of one
      -- being made. A row that is not there conflicts below, unlocked.
      lock_key := o->'values'->>'trip_id';
      if lock_key is null then
        execute format('select trip_id::text from %I where %s', tbl, mutation_key(tbl, o->'key'))
          into lock_key;
      end if;
    end if;
    lock_keys := lock_keys || lock_key;
  end loop;
  for lock_key in
    select distinct k from unnest(lock_keys) k where k is not null order by 1
  loop
    perform pg_advisory_xact_lock(hashtext(lock_key));
  end loop;

  -- Sent twice: answer as the first time did, and write nothing.
  select produced into found_row from applied_mutations where id = mutation;
  if found then
    if found_row is not null then
      return jsonb_build_object('status', 'applied', 'rows', found_row);
    end if;
    for o in select * from jsonb_array_elements(ops) loop
      if o->>'op' = 'plan' then
        results := results || jsonb_build_array(null);
      else
        execute format('select to_jsonb(%I.*) from %I where %s',
                       o->>'table', o->>'table', mutation_key(o->>'table', o->'key'))
          into found_row;
        results := results || jsonb_build_array(found_row);
      end if;
    end loop;
    return jsonb_build_object('status', 'applied', 'rows', results);
  end if;

  -- Every row checked before anything is written.
  for o in select * from jsonb_array_elements(ops) loop
    if o->>'op' <> 'plan' then
      tbl := o->>'table';
      if not tbl = any (allowed) then
        raise exception 'apply_mutation: % is not a table an edit may write', tbl
          using errcode = '42501';
      end if;
      execute format('select to_jsonb(%I.*) from %I where %s',
                     tbl, tbl, mutation_key(tbl, o->'key'))
        into found_row;
      if (o->>'op' = 'insert' and found_row is not null)
         or (o->>'op' = 'update' and (found_row is null
                                      or (found_row->>'version')::bigint is distinct from (o->>'base')::bigint))
         or (o->>'op' = 'delete' and found_row is not null
                                 and (found_row->>'version')::bigint is distinct from (o->>'base')::bigint)
      then
        conflicts := conflicts || jsonb_build_object('index', i, 'upstream', found_row);
      end if;
    end if;
    i := i + 1;
  end loop;

  if jsonb_array_length(conflicts) > 0 then
    return jsonb_build_object('status', 'conflict', 'conflicts', conflicts);
  end if;

  for o in select * from jsonb_array_elements(ops) loop
    tbl := o->>'table';
    written := null;
    if o->>'op' = 'plan' then
      -- save_plan's own policies decide who may write the plan. The stamp
      -- on the trip is the owner's row, so an editor's save leaves it be,
      -- as it always has.
      perform save_plan(
        (o->>'trip')::uuid,
        o->'rows',
        case when jsonb_typeof(o->'days') = 'array'
             then array(select jsonb_array_elements_text(o->'days')::int)
        end);
      update trips
        set plan_generated_at = (o->>'generated_at')::timestamptz,
            plan_version = (o->>'planner_version')::int
        where id = (o->>'trip')::uuid;
    elsif o->>'op' = 'insert' then
      select string_agg(format('%I', k), ', ') into cols
        from jsonb_object_keys((o->'values') - 'version') k;
      execute format('insert into %I (%s) select %s from jsonb_populate_record(null::%I, $1) returning to_jsonb(%I.*)',
                     tbl, cols, cols, tbl, tbl)
        using (o->'values') - 'version'
        into written;
    elsif o->>'op' = 'update' then
      select string_agg(format('%I', k), ', ') into cols
        from jsonb_object_keys((o->'values') - 'version') k;
      execute format('update %I set (%s) = (select %s from jsonb_populate_record(null::%I, $1)) where %s returning to_jsonb(%I.*)',
                     tbl, cols, cols, tbl, mutation_key(tbl, o->'key'), tbl)
        using (o->'values') - 'version'
        into written;
      -- It was there a moment ago, so a write that touched nothing is a
      -- write the policies would not let through.
      if written is null then
        raise exception 'apply_mutation: this change to % may not be made', tbl
          using errcode = '42501';
      end if;
    elsif o->>'op' = 'delete' then
      execute format('delete from %I where %s', tbl, mutation_key(tbl, o->'key'));
      -- Gone already is what was asked for. Still there is a refusal.
      execute format('select to_jsonb(%I.*) from %I where %s',
                     tbl, tbl, mutation_key(tbl, o->'key'))
        into found_row;
      if found_row is not null then
        raise exception 'apply_mutation: this % may not be removed', tbl
          using errcode = '42501';
      end if;
    else
      raise exception 'apply_mutation: unknown op %', o->>'op' using errcode = '22023';
    end if;
    results := results || jsonb_build_array(written);
  end loop;

  insert into applied_mutations (id, produced) values (mutation, results);
  -- ponytail: a month of ids is far longer than any queue waits to be sent.
  delete from applied_mutations
    where user_id = auth.uid() and applied_at < now() - interval '30 days';

  return jsonb_build_object('status', 'applied', 'rows', results);
end;
$$;

revoke all on function apply_mutation(uuid, jsonb) from public, anon;
grant execute on function apply_mutation(uuid, jsonb) to authenticated;
