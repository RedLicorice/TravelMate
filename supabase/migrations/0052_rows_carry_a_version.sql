-- The device holds the trip, and the database is where it is replicated to.
--
-- An edit made on a phone is queued there and sent when there is a
-- connection -- which may be hours after it was made, against a row somebody
-- else has changed in the meantime. So every row an edit can touch carries a
-- version, an edit says which version it was made against, and an edit made
-- against a version the row has moved on from is not applied: it is handed
-- back as a conflict, for the traveller to decide.
--
-- plan_stops has none on purpose. It is the plan as drawn, recomputed on the
-- device from the rows below and saved whole; the refiner writes journey
-- times onto it in the background, and a version there would turn every
-- routed leg into a conflict nobody caused.

alter table trips        add column version bigint not null default 1;
alter table pois         add column version bigint not null default 1;
alter table placements   add column version bigint not null default 1;
alter table trip_meals   add column version bigint not null default 1;
alter table trip_members add column version bigint not null default 1;
alter table profiles     add column version bigint not null default 1;

-- Maintained here, not by the client: a version a client could set is a
-- version a client could get wrong. The arguments name columns that are not
-- anybody's decision -- on trips, when the plan was last saved -- so writing
-- them does not count as changing the row.
create function bump_version() returns trigger
language plpgsql
set search_path = public
as $$
declare
  ignored text[] := coalesce(tg_argv::text[], '{}') || '{version}';
begin
  if (to_jsonb(new) - ignored) is distinct from (to_jsonb(old) - ignored) then
    new.version := old.version + 1;
  else
    new.version := old.version;
  end if;
  return new;
end;
$$;

create trigger trips_version before update on trips
  for each row execute function bump_version('plan_generated_at', 'plan_version');
create trigger pois_version before update on pois
  for each row execute function bump_version('updated_at');
create trigger placements_version before update on placements
  for each row execute function bump_version();
create trigger trip_meals_version before update on trip_meals
  for each row execute function bump_version();
create trigger trip_members_version before update on trip_members
  for each row execute function bump_version();
create trigger profiles_version before update on profiles
  for each row execute function bump_version('updated_at');

-- Which edits have already been applied, by the id the device gave them.
--
-- The device sends an edit and the answer is lost on a dropped connection:
-- it sends it again. Without this the second attempt finds the row at the
-- version the first one produced and calls it a conflict with itself.
create table applied_mutations (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  applied_at timestamptz not null default now()
);
alter table applied_mutations enable row level security;
create policy applied_mutations_own_read on applied_mutations
  for select to authenticated using (user_id = auth.uid());
create policy applied_mutations_own_write on applied_mutations
  for insert to authenticated with check (user_id = auth.uid());
create policy applied_mutations_own_delete on applied_mutations
  for delete to authenticated using (user_id = auth.uid());

-- The rows one op names, as a WHERE clause.
create function mutation_key(tbl text, key jsonb) returns text
language sql
immutable
set search_path = public
as $$
  select format('(%s) = (select %s from jsonb_populate_record(null::%I, %L::jsonb))',
                string_agg(format('%I.%I', tbl, k), ', '),
                string_agg(format('%I', k), ', '),
                tbl,
                key)
  from jsonb_object_keys(key) as k;
$$;

-- One edit, applied whole or not at all.
--
-- `ops` is the list of row writes the edit is made of:
--   {table, op: insert|update|delete, key, base, values, lock}
--   {op: plan, trip, rows, planner_version, generated_at}
-- `base` is the version the device made the write against.
--
-- The answer is one of:
--   {status: applied,  rows: [the row as written, or null, per op]}
--   {status: conflict, conflicts: [{index, upstream}]}  -- nothing written
-- and anything the caller may not do raises, which rolls back every op
-- before it: a viewer's edit is refused by the same policies as always.
--
-- Security invoker, so row-level security decides exactly as it does for a
-- plain write. The advisory locks serialise edits to one trip, so a version
-- read here is still the version when the write lands.
create function apply_mutation(mutation uuid, ops jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  allowed constant text[] := '{trips,pois,placements,trip_meals,trip_members,profiles}';
  o jsonb;
  i int := 0;
  tbl text;
  cols text;
  found_row jsonb;
  written jsonb;
  results jsonb := '[]';
  conflicts jsonb := '[]';
  lock_key text;
begin
  for lock_key in
    select distinct coalesce(x->>'lock', x->>'trip')
    from jsonb_array_elements(ops) x
    order by 1
  loop
    perform pg_advisory_xact_lock(hashtext(lock_key));
  end loop;

  -- Sent twice: answer with what the rows are now, and write nothing.
  if exists (select 1 from applied_mutations where id = mutation) then
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
                                      or (found_row->>'version')::bigint <> (o->>'base')::bigint))
         or (o->>'op' = 'delete' and found_row is not null
                                 and (found_row->>'version')::bigint <> (o->>'base')::bigint)
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
      perform save_plan((o->>'trip')::uuid, o->'rows');
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

  insert into applied_mutations (id) values (mutation);
  -- ponytail: a month of ids is far longer than any queue waits to be sent.
  delete from applied_mutations
    where user_id = auth.uid() and applied_at < now() - interval '30 days';

  return jsonb_build_object('status', 'applied', 'rows', results);
end;
$$;

revoke all on function apply_mutation(uuid, jsonb) from public, anon;
grant execute on function apply_mutation(uuid, jsonb) to authenticated;
revoke all on function mutation_key(text, jsonb) from public, anon;
grant execute on function mutation_key(text, jsonb) to authenticated;

-- What another traveller does reaches an open screen as it happens.
alter publication supabase_realtime
  add table trips, pois, placements, trip_meals, trip_members, profiles;
