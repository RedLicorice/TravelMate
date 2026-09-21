-- A pinned stop keeps its day and its place in that day when Regenerate runs.
--
-- It lives on pois rather than on plan_stops because the planner reads pois:
-- a pin recorded only on the stored plan would be invisible to the very run it
-- is meant to constrain.
alter table pois add column pinned boolean not null default false;
