-- One OSM place once per trip, except somewhere you eat.
--
-- The original index existed to stop a double tap adding the Tate twice. But a
-- traveller may well want the same cafe on Tuesday and Thursday, and telling
-- them they have already added it is wrong: eating there twice is a plan, not
-- a mistake.
drop index if exists pois_trip_osm_unique;

create unique index pois_trip_osm_unique
  on pois (trip_id, osm_id)
  where osm_id is not null
    and coalesce(category, '') not in
      ('cafe', 'bakery', 'restaurant', 'food_court', 'fast_food', 'pub', 'biergarten', 'bar');
