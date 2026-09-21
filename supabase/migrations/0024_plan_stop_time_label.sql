-- The journey's cards cost the day nothing, so the planner gives them all the
-- same minute. Their real times are on the ticket; this is where they live.
alter table plan_stops add column time_label text;
