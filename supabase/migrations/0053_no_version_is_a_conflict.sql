-- An edit that says no version is not an edit made against any version.
--
-- 0052 compared the row's version with the edit's using <>, and a missing
-- version makes that comparison unknown -- which an IF reads as "no
-- conflict". An update or a delete arriving without one skipped the check
-- altogether and wrote over whatever was there. The app never sends one on
-- purpose; the server does not take its word for it.
create or replace function apply_mutation(mutation uuid, ops jsonb)
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
