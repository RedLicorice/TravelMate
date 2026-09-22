-- The furniture of a day is placed, not generated.
--
-- 0043 let a traveller take a piece out of a day and recorded the absence.
-- That was the wrong half of the job: it could remove what the app drew and
-- nothing else -- no second visit to the hotel in the afternoon, no moving
-- the bags to before lunch, no adding anything the app had not thought of.
-- An absence table is also a second source of truth about what a day is made
-- of, which is the same fault placements were built to end.
--
-- So the hotel, getting ready, checking in and collecting the bags become
-- placements like every stop: a thing on a day, in a position, that can be
-- dragged, removed and added. A placement now says what it is; only a 'stop'
-- points at a place on the wishlist.
drop table if exists day_skips;

alter table placements
  alter column poi_id drop not null,
  add column kind text not null default 'stop'
    check (kind in ('stop', 'hotel', 'chore')),
  -- What a chore is called: "Getting ready", "Collect the bags". A stop and a
  -- hotel take their name from what they are of.
  add column name text,
  -- How long it takes. Null means the trip's own allowance decides, which is
  -- what the sliders in the trip's settings are.
  add column minutes int,
  add constraint placements_stop_has_a_place
    check ((kind = 'stop') = (poi_id is not null));

-- Which days have been furnished already. A day the app has never drawn gets
-- the usual furniture the first time it is seen; after that the day is the
-- traveller's, and a piece they removed stays removed.
alter table trips add column furnished_days int not null default 0;
