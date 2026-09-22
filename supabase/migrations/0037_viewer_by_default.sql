-- A link is a look. Editing is given, not taken.
--
-- join_trip made every arrival an editor, and no policy has ever read the
-- role, so the "have a look at this" link and the "help me plan it" link were
-- the same link. Someone forwarded a trip could rewrite it.
--
-- Whoever is already on a trip keeps what they have: this changes who arrives
-- next, not who is here.

-- Editing is owner and editor. Membership -- reading -- stays is_trip_member.
create function can_edit_trip(t uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from trip_members m
    where m.trip_id = t and m.user_id = auth.uid() and m.role in ('owner', 'editor')
  ) or exists (
    select 1 from trips x where x.id = t and x.user_id = auth.uid()
  );
$$;

-- Granted to authenticated, not revoked from it. A policy's expression runs as
-- the caller, not as the table's owner, so a membership helper the caller may
-- not execute is a table the caller may not read: 0036 revoked is_trip_member
-- and shares_trip_with from authenticated and took every collaborator's read
-- of trips, pois, plan_stops, trip_meals and profiles with them. Put those
-- back, and keep anon out, which was the only part worth having.
revoke all on function can_edit_trip(uuid) from public, anon;
grant execute on function can_edit_trip(uuid) to authenticated;

grant execute on function is_trip_member(uuid) to authenticated;
grant execute on function shares_trip_with(uuid) to authenticated;

-- The places on the trip. Reading is membership; writing is editing.
drop policy pois_member_write on pois;
create policy pois_editor_write on pois
  for all using (can_edit_trip(trip_id)) with check (can_edit_trip(trip_id));

-- plan_stops and trip_meals were one `for all` policy each, which made every
-- reader a writer. Split them.
drop policy plan_stops_member_all on plan_stops;
create policy plan_stops_member_read on plan_stops
  for select using (is_trip_member(trip_id));
create policy plan_stops_editor_write on plan_stops
  for all using (can_edit_trip(trip_id)) with check (can_edit_trip(trip_id));

drop policy trip_meals_member_all on trip_meals;
create policy trip_meals_member_read on trip_meals
  for select using (is_trip_member(trip_id));
create policy trip_meals_editor_write on trip_meals
  for all using (can_edit_trip(trip_id)) with check (can_edit_trip(trip_id));

-- The trip's picture is part of editing it.
drop policy "a trip member writes that trip's image" on storage.objects;
drop policy "a trip member replaces that trip's image" on storage.objects;
drop policy "a trip member deletes that trip's image" on storage.objects;

create policy "an editor writes that trip's image" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'trip-images' and can_edit_trip(((storage.foldername(name))[1])::uuid));

create policy "an editor replaces that trip's image" on storage.objects
  for update to authenticated
  using (bucket_id = 'trip-images' and can_edit_trip(((storage.foldername(name))[1])::uuid));

create policy "an editor deletes that trip's image" on storage.objects
  for delete to authenticated
  using (bucket_id = 'trip-images' and can_edit_trip(((storage.foldername(name))[1])::uuid));

-- Arrivals look; the owner hands over the pen.
create or replace function join_trip(token uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare target uuid;
begin
  if auth.uid() is null then
    raise exception 'must be signed in to join';
  end if;

  select id into target from trips where share_token = token;
  if target is null then
    return null;  -- unknown or revoked: same answer, so neither is confirmed
  end if;

  insert into trip_members (trip_id, user_id, role)
  values (target, auth.uid(), 'viewer')
  on conflict (trip_id, user_id) do nothing;

  return target;
end;
$$;

revoke all on function join_trip(uuid) from public;
grant execute on function join_trip(uuid) to authenticated;

-- Only the owner changes a role, only to editor or viewer, and never their
-- own: a trip with no owner is a trip nobody can share or delete.
create policy trip_members_owner_sets_role on trip_members
  for update using (
    exists (select 1 from trips t where t.id = trip_members.trip_id and t.user_id = auth.uid())
    and user_id <> auth.uid()
  )
  with check (role in ('editor', 'viewer'));

-- A picture is one of ours, or it is not a picture.
--
-- avatar_url and image_url are written by the client and rendered as <img> to
-- everyone else on the trip, so a member could point one at their own server
-- and collect the others' addresses. Left `not valid`: it governs what is
-- written from here on rather than refusing to start over a row written
-- before it existed.
alter table profiles add constraint avatar_url_is_ours check (
  avatar_url is null
  or avatar_url ~ '^https://[a-z0-9]+\.supabase\.co/storage/v1/object/public/avatars/'
  or avatar_url ~ '^http://(127\.0\.0\.1|localhost):[0-9]+/storage/v1/object/public/avatars/'
) not valid;

alter table trips add constraint image_url_is_ours check (
  image_url is null
  or image_url ~ '^https://[a-z0-9]+\.supabase\.co/storage/v1/object/public/trip-images/'
  or image_url ~ '^http://(127\.0\.0\.1|localhost):[0-9]+/storage/v1/object/public/trip-images/'
) not valid;
