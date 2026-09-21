-- The way in and the way out are journeys, not single terminals: Rome to Milan
-- by train, Milan to London by air, is one arrival.
--
-- JSONB on the trip rather than a table: a journey is a short ordered list
-- owned entirely by its trip, nothing else references a leg, and it is always
-- wanted at the same moment the trip is.
alter table trips add column arrival_legs jsonb not null default '[]'::jsonb;
alter table trips add column departure_legs jsonb not null default '[]'::jsonb;

-- Existing trips have one implied leg each: whatever terminal they already
-- name, arriving or leaving at the time already stored. The trip's own
-- arrival_point/arrival_at columns stay as the summary the planner reads, so
-- nothing downstream has to learn what a journey is.
update trips set arrival_legs = jsonb_build_array(
  jsonb_build_object(
    'from', null,
    'to', jsonb_build_object(
      'name', arrival_point_name, 'lat', arrival_point_lat,
      'lng', arrival_point_lng, 'kind', coalesce(arrival_kind, 'other')),
    'service', arrival_service,
    'bookingRef', arrival_booking_ref,
    'departLocal', null,
    'arriveLocal', null
  ))
where arrival_point_name is not null;

update trips set departure_legs = jsonb_build_array(
  jsonb_build_object(
    'from', jsonb_build_object(
      'name', departure_point_name, 'lat', departure_point_lat,
      'lng', departure_point_lng, 'kind', coalesce(departure_kind, 'other')),
    'to', null,
    'service', departure_service,
    'bookingRef', departure_booking_ref,
    'departLocal', null,
    'arriveLocal', null
  ))
where departure_point_name is not null;
