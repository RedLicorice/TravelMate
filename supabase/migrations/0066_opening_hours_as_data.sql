-- When a place is open, as data the planner can read: Google's periods,
--   [{"open": {"day": 1, "hour": 9, "minute": 0}, "close": {"day": 1, "hour": 17, "minute": 0}}]
-- day 0 = Sunday, in the place's own local time. A place open round the
-- clock has one period with an open and no close. Null: not known.
alter table pois add column opening_periods jsonb;
-- When Google was last asked for them, found or not: asked again after 30 days.
alter table pois add column opening_checked_at timestamptz;

-- Written by the server in the background, like peak hours (0063): facts
-- about the place, not anybody's edit, so they leave the version alone.
drop trigger pois_version on pois;
create trigger pois_version before update on pois
  for each row execute function bump_version(
    'updated_at', 'fsq_place_id', 'busy_windows', 'popularity', 'busy_checked_at',
    'opening_periods', 'opening_checked_at'
  );
