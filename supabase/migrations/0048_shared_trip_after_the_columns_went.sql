-- Sharing has been broken since 0042.
--
-- get_shared_trip ordered the places by pois.day_index, which 0042 dropped
-- when a place's position moved to placements. Every share link has answered
-- "column p.day_index does not exist" since -- to anyone holding it, the trip
-- simply did not load.
--
-- The places are ordered by when they were added now. Where each one sits on
-- the plan is in the plan, which this already returns.
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
    'pois', coalesce((select jsonb_agg((to_jsonb(p) - 'added_by') order by p.created_at)
                      from pois p where p.trip_id = t.id), '[]'::jsonb),
    'plan', coalesce((select jsonb_agg(to_jsonb(s) order by s.day_index, s.order_index)
                      from plan_stops s where s.trip_id = t.id), '[]'::jsonb)
  )
  from trips t
  where t.share_token = token;
$$;

revoke all on function get_shared_trip(uuid) from public;
grant execute on function get_shared_trip(uuid) to anon, authenticated;
