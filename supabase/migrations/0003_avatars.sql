-- Storage for uploaded profile pictures.
--
-- Public-read because an <img src> carries no Authorization header, and a
-- signed URL for something shown on every screen would mean refreshing a token
-- to render an avatar. Nothing private lives here: the object key is the
-- uploader's own id, which they already know.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'avatars', 'avatars', true, 2097152,
  array['image/png', 'image/jpeg', 'image/webp', 'image/gif']
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Writes are scoped to a folder named after the uploader, so one traveller
-- cannot overwrite another's picture. storage.foldername() returns the path
-- segments; the first is the owner's uuid.
create policy "avatars are readable by anyone"
  on storage.objects for select
  using (bucket_id = 'avatars');

create policy "a user writes only their own avatar"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "a user replaces only their own avatar"
  on storage.objects for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "a user deletes only their own avatar"
  on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
