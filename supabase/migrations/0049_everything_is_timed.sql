-- Every card holds a clock.
--
-- A day was ordered by position and timed by walking it. Two travellers'
-- gestures -- dragging a card, and dragging a meal to an hour -- therefore
-- meant different things, and the position always won: a card dropped at
-- four o'clock landed wherever the walk happened to reach it.
--
-- So: a placement has a time. It is what the traveller set by putting the
-- card there, it is what the plan sorts by, and it is what Replan writes when
-- it decides a day. Position is gone -- a day is its cards in the order their
-- clocks say, which is the only order anybody has ever meant.
alter table placements add column at timestamptz;

-- What each card already says on the plan of record becomes its clock.
update placements p
set at = s.starts_at
from plan_stops s
where s.trip_id = p.trip_id and s.placement_id = p.id;

-- Anything the plan has never drawn -- placed since the last walk -- takes
-- the day's own start, so it opens the day rather than vanishing to the end
-- of it. The next walk gives it a real one.
update placements p
set at = t.arrival_at + (p.day_index || ' days')::interval
from trips t
where p.at is null and t.id = p.trip_id;

alter table placements alter column at set not null;
create index placements_trip_at on placements (trip_id, at);

-- A meal said nothing but which meal it is. When it happens is the clock on
-- its own placement, like everything else.
alter table trip_meals drop column at;
