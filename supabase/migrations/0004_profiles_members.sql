-- User preferences sidecar, and trip membership.
--
-- Profile data started in auth.users.user_metadata, which is only ever
-- readable by its own owner. That is fine for a name, and fatal for a meal
-- window: the planner has to intersect everyone's preferences, so every
-- collaborator's window has to be readable by the others. Hence a real table.

create table profiles (
  user_id      uuid primary key references auth.users on delete cascade,
  display_name text,
  avatar_url   text,
  avatar_seed  text,
  -- Local wall-clock windows. Defaults are continental; everyone can move them.
  meal_windows jsonb not null default
    '{"lunch":{"from":"12:00","to":"15:00"},"dinner":{"from":"19:00","to":"22:00"}}'::jsonb,
  updated_at   timestamptz not null default now()
);

create table trip_members (
  trip_id   uuid not null references trips on delete cascade,
  user_id   uuid not null references auth.users on delete cascade,
  role      text not null default 'editor' check (role in ('owner', 'editor', 'viewer')),
  joined_at timestamptz not null default now(),
  primary key (trip_id, user_id)
);

create index trip_members_user_idx on trip_members (user_id);

alter table profiles     enable row level security;
alter table trip_members enable row level security;

-- SECURITY DEFINER because a policy on trip_members that queries trip_members
-- recurses. The function runs outside RLS, so the recursion never starts.
create function is_trip_member(t uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from trip_members m where m.trip_id = t and m.user_id = auth.uid())
      or exists (select 1 from trips x where x.id = t and x.user_id = auth.uid());
$$;

-- Same reasoning: profiles are visible to people you actually travel with,
-- which is a question about trip_members, asked from a policy on profiles.
create function shares_trip_with(u uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from trip_members a
    join trip_members b on a.trip_id = b.trip_id
    where a.user_id = auth.uid() and b.user_id = u
  );
$$;

create policy profiles_read_own_or_travelling_together on profiles
  for select using (user_id = auth.uid() or shares_trip_with(user_id));
create policy profiles_write_own on profiles
  for insert with check (user_id = auth.uid());
create policy profiles_update_own on profiles
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy trip_members_read on trip_members
  for select using (is_trip_member(trip_id));
-- Leaving is allowed; adding someone is not, so an invite cannot be forged by
-- inserting a row. Joining goes through join_trip, which checks the token.
create policy trip_members_leave on trip_members
  for delete using (user_id = auth.uid());

-- Collaborators can read the trip and its stops. Policies are OR'd with the
-- existing owner policy rather than replacing it.
create policy trips_member_read on trips
  for select using (is_trip_member(id));
create policy pois_member_read on pois
  for select using (is_trip_member(trip_id));
create policy pois_member_write on pois
  for all using (is_trip_member(trip_id)) with check (is_trip_member(trip_id));

-- Joining by share link. The token is the capability; holding it is what
-- grants membership, which is why this takes it as an argument rather than
-- letting a client insert its own row.
create function join_trip(token uuid)
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
  values (target, auth.uid(), 'editor')
  on conflict (trip_id, user_id) do nothing;

  return target;
end;
$$;

revoke all on function join_trip(uuid) from public;
grant execute on function join_trip(uuid) to authenticated;

-- Every existing trip owner becomes a member of their own trip, so the
-- membership table is the single answer to "who is on this trip".
insert into trip_members (trip_id, user_id, role)
select id, user_id, 'owner' from trips
on conflict do nothing;
