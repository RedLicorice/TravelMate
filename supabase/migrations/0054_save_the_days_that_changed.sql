-- The plan is saved for the days an edit touched, not the whole trip.
--
-- Every edit re-timed and saved every day of the trip, and the server wrote
-- every stored stop back -- each of which came back to every open screen over
-- realtime. A drop on the first day cost as much as all of them. save_plan
-- takes the days it is given now, and removes stale stops only from those;
-- the other days keep their rows untouched. Without days it saves the whole
-- plan, as Replan does.

drop function save_plan(uuid, jsonb);

create function save_plan(trip uuid, rows jsonb, days int[] default null)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare kept uuid[];
begin
  -- The trip's plan is written by one caller at a time. Without this, two
  -- savers each delete what the other has not yet inserted.
  perform pg_advisory_xact_lock(hashtext(trip::text));

  -- RLS still applies: security invoker, so a caller who may not write this
  -- trip writes nothing at all.
  with numbered as (
    select
      nullif(r->>'id', '')::uuid as claimed,
      r,
      row_number() over (
        partition by nullif(r->>'id', '')::uuid
        order by (r->>'day_index')::int, (r->>'order_index')::int
      ) as claim
    from jsonb_array_elements(rows) as r
  ), incoming as (
    select
      case when claimed is null or claim > 1 then gen_random_uuid() else claimed end as id,
      r
    from numbered
  ), written as (
    insert into plan_stops (
      id, trip_id, placement_id, day_index, order_index, poi_id, name, lat, lng, anchor,
      anchor_kind, time_label, starts_at, ends_at, duration_min, pinned,
      leg_mode, leg_minutes, leg_km, leg_source, warnings, busyness,
      exit_lat, exit_lng
    )
    select
      i.id,
      trip,
      nullif(i.r->>'placement_id', '')::uuid,
      (i.r->>'day_index')::int,
      (i.r->>'order_index')::int,
      nullif(i.r->>'poi_id', '')::uuid,
      i.r->>'name',
      (i.r->>'lat')::double precision,
      (i.r->>'lng')::double precision,
      (i.r->>'anchor')::boolean,
      nullif(i.r->>'anchor_kind', ''),
      nullif(i.r->>'time_label', ''),
      (i.r->>'starts_at')::timestamptz,
      (i.r->>'ends_at')::timestamptz,
      (i.r->>'duration_min')::int,
      (i.r->>'pinned')::boolean,
      nullif(i.r->>'leg_mode', ''),
      nullif(i.r->>'leg_minutes', '')::int,
      nullif(i.r->>'leg_km', '')::numeric,
      nullif(i.r->>'leg_source', ''),
      coalesce(i.r->'warnings', '[]'::jsonb),
      nullif(i.r->>'busyness', '')::numeric,
      nullif(i.r->>'exit_lat', '')::double precision,
      nullif(i.r->>'exit_lng', '')::double precision
    from incoming i
    on conflict (id) do update set
      placement_id = excluded.placement_id,
      day_index    = excluded.day_index,
      order_index  = excluded.order_index,
      poi_id       = excluded.poi_id,
      name         = excluded.name,
      lat          = excluded.lat,
      lng          = excluded.lng,
      anchor       = excluded.anchor,
      anchor_kind  = excluded.anchor_kind,
      time_label   = excluded.time_label,
      starts_at    = excluded.starts_at,
      ends_at      = excluded.ends_at,
      duration_min = excluded.duration_min,
      pinned       = excluded.pinned,
      leg_mode     = excluded.leg_mode,
      leg_minutes  = excluded.leg_minutes,
      leg_km       = excluded.leg_km,
      leg_source   = excluded.leg_source,
      warnings     = excluded.warnings,
      busyness     = excluded.busyness,
      exit_lat     = excluded.exit_lat,
      exit_lng     = excluded.exit_lng
    returning plan_stops.id
  )
  select array_agg(id) into kept from written;

  -- A plan that sent no stops at all is an empty plan, not a no-op -- for
  -- the days it was sent for. Days it was not sent for keep their rows.
  delete from plan_stops
  where trip_id = trip
    and (days is null or day_index = any (days))
    and (kept is null or id <> all (kept));
end;
$$;

revoke all on function save_plan(uuid, jsonb, int[]) from public, anon;
grant execute on function save_plan(uuid, jsonb, int[]) to authenticated;

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

  insert into applied_mutations (id) values (mutation);
  -- ponytail: a month of ids is far longer than any queue waits to be sent.
  delete from applied_mutations
    where user_id = auth.uid() and applied_at < now() - interval '30 days';

  return jsonb_build_object('status', 'applied', 'rows', results);
end;
$$;
