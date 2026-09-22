-- Writing a plan is one statement, not two.
--
-- savePlan deleted the trip's stops and then inserted the new ones. Two of
-- those overlapping -- an automatic re-time and a traveller's edit, say --
-- interleave as delete, delete, insert, insert, and the plan comes back with
-- every stop on it twice.
--
-- Clean up what that already did: keep the earliest row for each place in the
-- plan and drop the rest.
delete from plan_stops a
using plan_stops b
where a.trip_id = b.trip_id
  and a.day_index = b.day_index
  and a.order_index = b.order_index
  and a.ctid > b.ctid;

create or replace function replace_plan(trip uuid, rows jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
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
