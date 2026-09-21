-- Staleness needs to know when a place last changed in a way the planner
-- cares about. Only those columns bump the stamp: day_index and order_index
-- are written BY the planner, and bumping on those would mark every trip
-- stale the instant it was regenerated.
alter table pois add column updated_at timestamptz not null default now();

create or replace function pois_touch() returns trigger
language plpgsql as $$
begin
  if (new.name, new.lat, new.lng, new.category, new.duration_min, new.priority)
     is distinct from
     (old.name, old.lat, old.lng, old.category, old.duration_min, old.priority)
  then
    new.updated_at := now();
  end if;
  return new;
end;
$$;

create trigger pois_touch_updated_at
  before update on pois
  for each row execute function pois_touch();

-- Busyness was computed when the plan was made. Recomputing it on load would
-- reach the network on every page view and could disagree with the plan that
-- is on screen.
alter table plan_stops add column busyness numeric;
