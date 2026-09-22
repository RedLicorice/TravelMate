-- save_plan carries which visit each card is.
--
-- 0040 gave plan_stops a placement_id, because two coffees at the same cafe
-- on one day are two cards and telling them apart by what they are of cannot
-- work. The write had not heard about it, so the column was filled once by
-- the migration's backfill and then blanked by the next save.

create or replace function save_plan(trip uuid, rows jsonb)
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

  -- A plan that sent no stops at all is an empty plan, not a no-op.
  delete from plan_stops
  where trip_id = trip
    and (kept is null or id <> all (kept));
end;
$$;

revoke all on function save_plan(uuid, jsonb) from public, anon;
grant execute on function save_plan(uuid, jsonb) to authenticated;
