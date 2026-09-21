-- The shape of a cached route can change when the function that writes it
-- does. Without a version, a deploy that adds a field silently keeps serving
-- rows that lack it, and the client breaks on data it cannot see in review.
--
-- Old rows are not deleted: they simply stop matching, and the expiry index
-- sweeps them in time.
alter table route_cache add column schema_version int not null default 1;
create index route_cache_version on route_cache (schema_version);
