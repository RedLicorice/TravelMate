-- Getting ready and the bags are cards of their own now.
alter table plan_stops drop constraint if exists plan_stops_anchor_kind_check;
alter table plan_stops add constraint plan_stops_anchor_kind_check
  check (anchor_kind in ('hotel', 'terminal', 'service', 'chore'));
