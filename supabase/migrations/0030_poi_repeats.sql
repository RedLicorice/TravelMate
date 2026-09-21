-- Somewhere you go every day.
--
-- Coffee on the way out is not one stop on one morning, it is what the trip
-- does every morning. Modelling it as a single place on a single day meant
-- adding it four times to get it four times, and each copy then had to be
-- carried around the planner separately.
alter table pois add column repeats boolean not null default false;

comment on column pois.repeats is
  'Offered on every day it suits, rather than taking one day of its own.';
