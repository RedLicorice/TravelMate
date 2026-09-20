-- The city's own bounding box, captured when the traveller picks it.
--
-- Place search has to be bounded or Nominatim ranks globally and offers a
-- 'Premier Inn' in another country. Bounding by a box drawn around the hotel
-- almost works -- until the hotel coordinate is wrong, at which point the
-- search quietly hunts the wrong part of the planet. The city box is the
-- authoritative answer and does not depend on the hotel being right.
alter table trips
  add column city_south double precision,
  add column city_north double precision,
  add column city_west  double precision,
  add column city_east  double precision;

-- All four or none: a partial box is worse than no box, because code that
-- checks one field would build a nonsense viewbox from the rest.
alter table trips add constraint trips_city_bbox_whole
  check (num_nonnulls(city_south, city_north, city_west, city_east) in (0, 4));
