-- A sitting is a card, and a card is a placement.
--
-- A meal used to be a slot the planner drew wherever its window fell, timed
-- by a rule instead of by a clock. Everything else on a day is a placement
-- holding the minute it happens at, and a meal is a card like any other: it
-- is somewhere the traveller is, for as long as lunch takes. So a sitting is
-- a placement too, and `trip_meals` is left with what it is actually for --
-- which place was chosen for a meal, and whether it was skipped.
alter table placements drop constraint if exists placements_kind_check;
alter table placements add constraint placements_kind_check
  check (kind in ('stop', 'hotel', 'chore', 'meal'));

-- Which sitting it is. Only a meal has one.
alter table placements add column meal text
  check (meal is null or meal in ('breakfast', 'lunch', 'dinner'));
alter table placements add constraint placements_meal_named
  check ((kind = 'meal') = (meal is not null));
