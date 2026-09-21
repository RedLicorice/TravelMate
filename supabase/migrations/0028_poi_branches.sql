-- A chain is not a point. "Pret A Manger" is fifty shops, and which one the
-- traveller wants is whichever is nearest to wherever the day has them.
--
-- The branches are captured once, with the place, and read by the planner --
-- which must stay synchronous, so it cannot go looking for them itself.
alter table pois add column any_branch boolean not null default false;
alter table pois add column branches jsonb not null default '[]'::jsonb;

comment on column pois.any_branch is
  'True when the traveller said any branch will do, rather than this one.';
