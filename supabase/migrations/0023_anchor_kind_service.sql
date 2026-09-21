-- The flight itself is now a card on the plan, beside its airport.
alter table plan_stops drop constraint if exists plan_stops_anchor_kind_check;
alter table plan_stops add constraint plan_stops_anchor_kind_check
  check (anchor_kind in ('hotel', 'terminal', 'service'));
