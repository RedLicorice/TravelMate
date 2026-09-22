-- The card is called Check-in, and the one at the other end Check-out.
--
-- Arriving at the hotel and handing over the bags is one errand with one
-- name. The cards already existed under older names -- the hotel's own name
-- with "check-in" tacked on, and "Collect the bags" -- so the rows are
-- renamed rather than left for the traveller to wonder about.
update placements
set name = 'Check-in'
where kind = 'hotel' and name is not null and name like '%check-in';

update placements
set name = 'Check-out'
where kind = 'chore' and name in ('Collect the bags', 'Drop the bags');

-- The plan of record carries the names it was drawn with; those cards are on
-- screen until the next save, and would otherwise disagree with the trip.
update plan_stops
set name = 'Check-in'
where anchor_kind = 'hotel' and name like '%check-in';

update plan_stops
set name = 'Check-out'
where anchor_kind = 'chore' and name in ('Collect the bags', 'Drop the bags');
