-- How much the traveller wants to see a place, 1 to 5.
--
-- 3 is the default so an unrated stop sits in the middle rather than at the
-- bottom: not having said yet is not the same as not caring.
alter table pois
  add column priority int not null default 3
  check (priority between 1 and 5);
