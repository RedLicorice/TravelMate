-- A place on the wishlist, and the times it is on the plan, are two things.
--
-- pois has carried day_index and order_index since the first migration, which
-- made a wishlist row and a placement the same record. That is the wrong
-- shape, and it has been the cause of most of what has gone wrong lately:
--
--   * Taking a stop off the plan deleted the place, because there was only
--     one row and removing it removed everything.
--   * The same place could not be on the plan twice -- every McDonald's, the
--     same cafe on Tuesday and Thursday, the park you walk through each
--     morning -- because the one row has one day and one position.
--   * 0029 had to carve out an exemption letting anywhere you eat be on the
--     wishlist twice, which is a second wishlist row standing in for a second
--     placement. The wishlist then shows the same cafe twice, which is not
--     what anybody meant.
--
-- So: a poi is a place the traveller is interested in, once. A placement is
-- that place on a day, in a position, as many times as they like.

create table placements (
  id          uuid primary key default gen_random_uuid(),
  trip_id     uuid not null references trips on delete cascade,
  poi_id      uuid not null references pois on delete cascade,
  day_index   int not null,
  order_index int not null,
  -- Held where the traveller put it: Replan may not move it. When it happens
  -- is the card's, not the placement's.
  pinned      boolean not null default false,
  created_at  timestamptz not null default now()
);

create index placements_trip_day on placements (trip_id, day_index, order_index);
create index placements_poi on placements (poi_id);

alter table placements enable row level security;
create policy placements_member_read on placements
  for select using (is_trip_member(trip_id));
create policy placements_editor_write on placements
  for all using (can_edit_trip(trip_id)) with check (can_edit_trip(trip_id));

-- Everything already on a plan becomes its first placement.
insert into placements (trip_id, poi_id, day_index, order_index, pinned)
select trip_id, id, day_index, coalesce(order_index, 0), coalesce(pinned, false)
from pois
where day_index is not null;

-- A stop on the plan is a placement, not a place: two placements of one cafe
-- are two stops, and telling them apart by what they are of cannot work.
alter table plan_stops add column placement_id uuid references placements on delete cascade;

update plan_stops s
set placement_id = p.id
from placements p
where p.trip_id = s.trip_id
  and p.poi_id = s.poi_id
  and p.day_index = s.day_index;

-- One place, once, on the wishlist -- whatever it is. The food exemption from
-- 0029 existed so a cafe could be visited twice; that is two placements now,
-- and the wishlist goes back to being a list of places rather than a list of
-- visits.
drop index if exists pois_trip_osm_unique;
create unique index pois_trip_osm_unique
  on pois (trip_id, osm_id)
  where osm_id is not null;
