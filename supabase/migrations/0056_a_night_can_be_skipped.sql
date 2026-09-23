-- A night away from the hotel.
--
-- The hotel card that ends a day and the one that starts the next are the
-- same night. Taking either off the day says the traveller is not sleeping
-- at the hotel that night -- somewhere else, or not at all -- so both are
-- kept as skipped, the way a skipped meal is: not drawn, taking no time, and
-- not put back by Replan. Only a meal or a hotel card is ever skipped, and a
-- skipped card is at no place of its own.
alter table placements drop constraint placements_skip_is_a_meal;
alter table placements add constraint placements_skip_fits_kind
  check (not skipped or (kind in ('meal', 'hotel') and poi_id is null));
