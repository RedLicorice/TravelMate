-- The shared view used to re-run the scheduler on whatever it was handed,
-- which meant a guest could be shown different times than the traveller who
-- sent the link. Serve the stored plan instead.
create or replace function get_shared_trip(token uuid)
returns json
language sql
stable
security definer
set search_path = public
as $$
  select json_build_object(
    'trip', to_json(t),
    'pois', coalesce((select json_agg(p order by p.day_index, p.order_index)
                      from pois p where p.trip_id = t.id), '[]'::json),
    'plan', coalesce((select json_agg(s order by s.day_index, s.order_index)
                      from plan_stops s where s.trip_id = t.id), '[]'::json)
  )
  from trips t
  where t.share_token = token;
$$;

revoke all on function get_shared_trip(uuid) from public;
grant execute on function get_shared_trip(uuid) to anon, authenticated;
