-- What kind of place the traveller arrives at and leaves from.
--
-- The kind exists to pick a sane "be there in advance" default: two hours for
-- an airport, one for a train or bus. It is stored rather than derived at
-- render time so that changing the defaults later does not silently rewrite
-- the buffer someone deliberately set.
alter table trips
  add column arrival_kind text check (arrival_kind in ('airport','train','bus','ferry','other')),
  add column departure_kind text check (departure_kind in ('airport','train','bus','ferry','other'));
