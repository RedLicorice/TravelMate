-- One OSM place, once per trip.
--
-- The UI already hides places that are on the trip, but two taps in quick
-- succession, or the same place reached from the list and the map, can still
-- race past it. The database is the only place that can actually promise this.
-- Rows added by hand carry no osm_id and are not covered: two different
-- benches in the same park are a legitimate pair.
create unique index pois_trip_osm_unique
  on pois (trip_id, osm_id)
  where osm_id is not null;

-- Things worth knowing before turning up, when OSM happens to know them.
alter table pois
  add column website text,
  add column phone text;
