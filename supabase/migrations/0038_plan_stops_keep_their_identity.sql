-- A stop keeps its row.
--
-- plan_stops has had an id since 0010, and replace_plan threw it away on every
-- save: delete the trip's stops, insert them again, new ids for the same
-- places. Nothing minded while the plan was written only by the client that
-- had just built it. It matters now, because the real travel times are looked
-- up after the fact and written back to the stop they belong to -- and an
-- answer that arrives for a row the next save has already deleted is an answer
-- thrown away.
--
-- So saving becomes what it always meant: this is the plan now. Stops the
-- client sends with an id keep it and are updated in place; stops without one
-- are new; rows it did not send are gone.

-- Where a leg's numbers came from. 'estimate' is the speed model or a matrix
-- cell -- good enough to order a day by, and shown with a star. 'routed' came
-- back from the routing service for this exact journey at this hour. Null is a
-- plan stored before the distinction existed, which was routed synchronously,
-- so it is not worth a call to prove.
alter table plan_stops add column leg_source text
  check (leg_source in ('estimate', 'routed'));

create function save_plan(trip uuid, rows jsonb)
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
  with incoming as (
    select
      coalesce(nullif(r->>'id', '')::uuid, gen_random_uuid()) as id,
      r
    from jsonb_array_elements(rows) as r
  ), written as (
    insert into plan_stops (
      id, trip_id, day_index, order_index, poi_id, name, lat, lng, anchor,
      anchor_kind, time_label, starts_at, ends_at, duration_min, pinned,
      leg_mode, leg_minutes, leg_km, leg_source, warnings, busyness,
      exit_lat, exit_lng
    )
    select
      i.id,
      trip,
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

-- replace_plan stays until every open tab has reloaded onto the new client.
comment on function replace_plan(uuid, jsonb) is
  'Superseded by save_plan, which keeps a stop''s id. Here for clients loaded before that shipped; drop once they are gone.';

-- The refined times have to reach an open plan without being asked for.
alter publication supabase_realtime add table plan_stops;
