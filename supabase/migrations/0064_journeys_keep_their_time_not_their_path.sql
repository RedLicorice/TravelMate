-- Only the time a journey takes is kept. The way it goes -- the line on a
-- map, the turn-by-turn -- is Google Maps' to show, and a journey sheet that
-- draws it asks Google afresh. The route and refine functions stopped
-- reading and writing these before this ran.
alter table route_cache drop column polyline;
alter table route_cache drop column steps;
