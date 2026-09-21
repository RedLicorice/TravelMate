-- A pin holds a moment, not just a place in the running order.
--
-- Pinning by day and index alone meant Regenerate could still slide a stop
-- earlier or later as the stops around it changed length. The traveller who
-- pinned a 19:00 dinner meant 19:00.
alter table pois add column pinned_at timestamptz;

-- Everything already pinned was pinned by order only; it keeps that behaviour
-- until it is next moved, at which point it gains a time.
comment on column pois.pinned_at is
  'Exact start the planner must honour. Null on a pin made before times were held.';
