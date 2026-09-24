-- A place keeps where it is, in words: the address the search gave for it,
-- shown under its name wherever the wishlist lists it. Places already on a
-- wishlist have none; nothing looks them up again.
alter table pois add column address text;

-- Which source a place came from, and its id there, prefixed by the source:
-- 'osm/node/123' from OpenStreetMap, 'google/ChIJ...' from Google. It takes
-- over from osm_id, which since the switch to Google has held both kinds.
--
-- In two steps, so the published app never writes a column that is gone:
-- this one adds source_id beside osm_id and the app writes both; a later
-- migration fills in what older copies of the app wrote to osm_id alone,
-- and drops osm_id.
alter table pois add column source_id text;
update pois
  set source_id = case when osm_id like 'google/%' then osm_id else 'osm/' || osm_id end
  where osm_id is not null;

-- The same place is on a trip once, as osm_id made sure.
create unique index pois_trip_source_unique on pois (trip_id, source_id) where source_id is not null;
