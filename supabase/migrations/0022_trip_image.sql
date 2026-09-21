-- A picture for the trip, and the country it is in so there is something to
-- show before anyone uploads one.
alter table trips add column image_url text;
alter table trips add column country_code text;

-- Public-read for the same reason as avatars: an <img src> carries no
-- Authorization header, and a signed URL for something drawn on the trips list
-- would mean refreshing a token to render a thumbnail.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'trip-images', 'trip-images', true, 4194304,
  array['image/png', 'image/jpeg', 'image/webp', 'image/gif']
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create policy "trip images are readable by anyone"
  on storage.objects for select
  using (bucket_id = 'trip-images');

-- The folder is the trip id, so writing is exactly membership of that trip --
-- a collaborator can change the picture, a stranger cannot. is_trip_member is
-- SECURITY DEFINER, so this does not need its own view of trip_members.
create policy "a trip member writes that trip's image"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'trip-images'
    and is_trip_member(((storage.foldername(name))[1])::uuid)
  );

create policy "a trip member replaces that trip's image"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'trip-images'
    and is_trip_member(((storage.foldername(name))[1])::uuid)
  );

create policy "a trip member deletes that trip's image"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'trip-images'
    and is_trip_member(((storage.foldername(name))[1])::uuid)
  );
