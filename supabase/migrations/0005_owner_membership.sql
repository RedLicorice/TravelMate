-- Every trip's owner is a member of it, enforced at insert rather than left to
-- the client. is_trip_member() also checks trips.user_id, so this is not what
-- makes the owner able to read their trip -- it is what makes them visible to
-- shares_trip_with(), so collaborators can read the owner's meal window.
create function add_owner_as_member()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into trip_members (trip_id, user_id, role)
  values (new.id, new.user_id, 'owner')
  on conflict (trip_id, user_id) do nothing;
  return new;
end;
$$;

create trigger trips_owner_membership
  after insert on trips
  for each row execute function add_owner_as_member();
