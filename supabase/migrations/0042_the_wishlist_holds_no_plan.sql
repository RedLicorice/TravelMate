-- The wishlist stops pretending to hold a plan.
--
-- 0040 moved "this place, on this day, in this position" into placements, and
-- nothing has read these three since. They are dropped rather than left lying
-- about: a column that still exists is a column the next person writes to, and
-- two answers to "when does this happen" is exactly the fault 0040 was for.
--
-- pinned_at goes with them. A pin carries no time of its own -- it says Replan
-- may not move this one, and the card on the plan says when it is.
alter table pois
  drop column day_index,
  drop column order_index,
  drop column pinned,
  drop column pinned_at;

drop index if exists pois_trip_day_order_idx;
