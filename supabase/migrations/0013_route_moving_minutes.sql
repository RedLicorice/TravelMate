-- Google's duration measures the journey once it has begun and excludes the
-- wait for the first service. `minutes` is now door to door, waits included,
-- because that is what the traveller actually spends. This column keeps the
-- moving time so a leg can show both.
alter table route_cache add column moving_minutes int;
