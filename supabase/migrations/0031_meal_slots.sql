-- Meal slots are containers on the day, not ordinary stops.
--
-- A row records that the traveller has had a say about that meal on that day:
-- what is in it, when it happens if they moved it, or that they skipped it. No
-- row means the plan decides, which is the usual case and costs nothing to
-- store.
create table trip_meals (
  id         uuid primary key default gen_random_uuid(),
  trip_id    uuid not null references trips on delete cascade,
  day_index  int not null,
  meal       text not null check (meal in ('breakfast', 'lunch', 'dinner')),

  -- Null with skipped false is a container the traveller emptied on purpose:
  -- it stays on the day, waiting, and the plan does not refill it.
  poi_id     uuid references pois on delete set null,
  -- Set when the slot has been dragged. Null leaves it to its window.
  at         timestamptz,
  -- No breakfast that day. The container goes away until it is asked back.
  skipped    boolean not null default false,

  created_at timestamptz not null default now(),
  unique (trip_id, day_index, meal)
);

create index trip_meals_trip on trip_meals (trip_id, day_index);

alter table trip_meals enable row level security;
create policy trip_meals_member_all on trip_meals
  for all using (is_trip_member(trip_id)) with check (is_trip_member(trip_id));
