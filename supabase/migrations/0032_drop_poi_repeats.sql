-- Removing a column that should never have been added.
--
-- pois.repeats came from an invented feature -- the planner placing a stop on
-- every day by itself -- that the traveller rejected. The code was reverted
-- the same day; the column outlived it because reverting a migration file does
-- not undo what it already did to the database.
alter table pois drop column if exists repeats;
