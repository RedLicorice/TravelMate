-- Who put this on the wishlist.
--
-- With collaborators a trip's list is written by several people, and "who
-- wanted this" is the first thing anyone asks about a stop they do not
-- recognise.
alter table pois add column added_by uuid references auth.users on delete set null;

-- Existing rows belong to whoever owns the trip: the only answer the data can
-- honestly give, and right for every trip that has never been shared.
update pois p set added_by = t.user_id from trips t where t.id = p.trip_id;

alter table pois alter column added_by set default auth.uid();
