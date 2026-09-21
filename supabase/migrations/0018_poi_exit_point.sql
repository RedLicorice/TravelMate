-- Some stops let you out somewhere else. A cable car, a ferry, a funicular:
-- you board at one end and the next leg starts from the other.
--
-- Null means the usual case -- you leave a place from where you entered it,
-- which is also what a return trip on the same cable car amounts to.
alter table pois add column exit_lat double precision;
alter table pois add column exit_lng double precision;
alter table pois add constraint pois_exit_paired
  check ((exit_lat is null) = (exit_lng is null));

-- The stored plan has to carry it too, or the leg out of a cable car would be
-- measured from the wrong end every time the plan was read back.
alter table plan_stops add column exit_lat double precision;
alter table plan_stops add column exit_lng double precision;
alter table plan_stops add constraint plan_stops_exit_paired
  check ((exit_lat is null) = (exit_lng is null));
