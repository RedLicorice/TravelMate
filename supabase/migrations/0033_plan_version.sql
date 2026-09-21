-- Which version of the planner produced the stored plan.
--
-- The plan is the plan of record, so a change to how planning works does not
-- reach a trip until it is regenerated -- and asking the traveller to tap
-- Replan because the app changed underneath them is the app's problem, not
-- theirs. A plan older than the planner re-times itself once, on sight.
alter table trips add column plan_version int not null default 0;
