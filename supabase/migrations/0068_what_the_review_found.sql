-- What a review of the policies found, closed in one go.
--
-- 1. The owner could rewrite a membership onto another trip.
--
-- trip_members_owner_sets_role (0037) checked ownership only of the row as it
-- was; the row as written had only its role checked. So the owner of any one
-- trip could turn a viewer of theirs into an editor of somebody else's trip
-- by writing trip_id along with the role. The written row is now held to the
-- same terms as the read one.
drop policy if exists trip_members_owner_sets_role on trip_members;
create policy trip_members_owner_sets_role on trip_members
  for update using (
    exists (select 1 from trips t where t.id = trip_members.trip_id and t.user_id = auth.uid())
    and user_id <> auth.uid()
  )
  with check (
    role in ('editor', 'viewer')
    and user_id <> auth.uid()
    and exists (select 1 from trips t where t.id = trip_members.trip_id and t.user_id = auth.uid())
  );

-- 2. A place stays on its trip, added by whoever added it.
--
-- 0036 revoked update on added_by and trip_id, but the table-level grant
-- from 0001 still allows them: a column revoke takes nothing off a grant
-- that names no columns. A trigger refuses the change instead. Nothing on
-- the server moves a place or re-credits it -- the hours function writes
-- opening_periods only -- so only a client could, and a client may not.
create or replace function pois_keep_their_trip()
returns trigger language plpgsql security invoker set search_path = public as $$
begin
  if new.trip_id is distinct from old.trip_id or new.added_by is distinct from old.added_by then
    raise exception 'a place may not be moved to another trip or credited to somebody else'
      using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function pois_keep_their_trip() from public, anon;

drop trigger if exists pois_keep_their_trip on pois;
create trigger pois_keep_their_trip before update on pois
  for each row execute function pois_keep_their_trip();

-- 3. A picture is one of ours: this project's, not any project's.
--
-- 0037 accepted a URL on any *.supabase.co project, and anybody can make one
-- of those and read the access log. The checks now name this project. Still
-- `not valid`, as before: they govern what is written from here on.
alter table profiles drop constraint if exists avatar_url_is_ours;
alter table profiles add constraint avatar_url_is_ours check (
  avatar_url is null
  or avatar_url ~ '^https://sechvnxifsovxagfopzp\.supabase\.co/storage/v1/object/public/avatars/'
  or avatar_url ~ '^http://(127\.0\.0\.1|localhost):[0-9]+/storage/v1/object/public/avatars/'
) not valid;

alter table trips drop constraint if exists image_url_is_ours;
alter table trips add constraint image_url_is_ours check (
  image_url is null
  or image_url ~ '^https://sechvnxifsovxagfopzp\.supabase\.co/storage/v1/object/public/trip-images/'
  or image_url ~ '^http://(127\.0\.0\.1|localhost):[0-9]+/storage/v1/object/public/trip-images/'
) not valid;

-- 4. An event names a trip the writer is on, or no trip.
--
-- 0046 checked only whose the event was, so a trail could be written against
-- any trip id at all.
drop policy if exists events_write_own on events;
create policy events_write_own on events
  for insert to authenticated
  with check (user_id = auth.uid() and (trip_id is null or is_trip_member(trip_id)));

-- 5. apply_mutation: the lock is the server's to choose, and a repeated edit
-- answers with what it wrote the first time.
--
-- The lock that serialises edits to a trip was whatever the edit said it
-- was; an edit that said nothing took pg_advisory_xact_lock(null), which is
-- no lock at all. It is now worked out from the table and the key: the trip
-- for a trip's rows, the person for a profile.
--
-- Sent twice -- the answer to the first lost on a dropped connection -- the
-- edit answered with the rows as they are *now*. The device then moved its
-- later edits onto that version, as if they had been made on top of it: an
-- edit somebody else made in between was overwritten without a word of
-- conflict. The rows an edit produced are kept beside its id, and the second
-- answer is the first one. An id applied before this ran has nothing kept
-- and answers as it did.
alter table applied_mutations add column if not exists produced jsonb;

create or replace function apply_mutation(mutation uuid, ops jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  allowed constant text[] := '{trips,pois,placements,trip_members,profiles}';
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
    elsif tbl = 'trip_members' then
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
