-- A place's peak hours, from Foursquare: the busy windows per weekday
-- (hours_popular) and how busy it gets in them (popularity, 0-1). Written
-- by the busyness function in the background; the category table stays the
-- answer for a place Foursquare does not know.
alter table pois add column fsq_place_id text;
alter table pois add column busy_windows jsonb;   -- [{"day":1,"open":"1100","close":"1500"}], 1 = Monday
alter table pois add column popularity numeric check (popularity between 0 and 1);
-- When Foursquare was last asked, found or not: asked again after 30 days.
alter table pois add column busy_checked_at timestamptz;

-- Written by the server while the traveller may be editing the same place.
-- Counted as a change of version, it would put their edit aside as a
-- conflict with something they never did; it is facts about the place, not
-- anybody's decision, so like updated_at it leaves the version alone.
drop trigger pois_version on pois;
create trigger pois_version before update on pois
  for each row execute function bump_version('updated_at', 'fsq_place_id', 'busy_windows', 'popularity', 'busy_checked_at');
