-- Clear the routed-leg cache.
--
-- Its rows were written by three different versions of the route function
-- while the step shape was still settling, and stale shapes are worth nothing:
-- every row regenerates on demand from Google. This is a cache, so emptying it
-- costs a few requests and loses no user data.
delete from route_cache;
