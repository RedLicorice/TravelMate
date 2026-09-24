-- Step two of 0060. The app writes source_id only, and the published copy of
-- it is the one that does. What copies from before 0060 wrote in the meantime
-- -- osm_id alone -- is carried over, and osm_id goes, with its index.
update pois
  set source_id = case when osm_id like 'google/%' then osm_id else 'osm/' || osm_id end
  where source_id is null and osm_id is not null;

alter table pois drop column osm_id;
