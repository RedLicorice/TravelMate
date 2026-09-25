-- Foursquare peak hours are gone (0063): every call was refused, the fields
-- being Premium and paid from the first call. The planner estimates busyness
-- from a place's category and the hour, as it did for places without them.
-- The app stopped reading and writing these columns before this ran.

drop trigger pois_version on pois;
create trigger pois_version before update on pois
  for each row execute function bump_version('updated_at', 'opening_periods', 'opening_checked_at');

alter table pois
  drop column fsq_place_id,
  drop column busy_windows,
  drop column popularity,
  drop column busy_checked_at;
