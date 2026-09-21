-- Whether an anchor is the hotel or a terminal. The board colours them
-- differently, and reading a stored plan back had no way to tell.
alter table plan_stops add column anchor_kind text
  check (anchor_kind in ('hotel', 'terminal'));
