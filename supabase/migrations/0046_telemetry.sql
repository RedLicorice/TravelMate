-- What the app actually did, so faults can be read rather than described.
--
-- The traveller should not have to tell anybody what they clicked, in what
-- order, and what came back. Events are written by the client as it goes and
-- read back here.
--
-- Deliberately small: a name, a moment, and a blob of detail. No page views,
-- no session stitching, no third party -- this exists to find bugs in this
-- app, and it lives in the same database as everything else, under the same
-- policies.
create table events (
  id       bigserial primary key,
  user_id  uuid not null default auth.uid() references auth.users on delete cascade,
  trip_id  uuid references trips on delete cascade,
  at       timestamptz not null default now(),
  -- 'search.terminals', 'journey.leg.add', 'drag.drop', 'plan.replan', 'error'
  name     text not null,
  detail   jsonb not null default '{}'::jsonb
);

create index events_recent on events (at desc);
create index events_by_name on events (name, at desc);

alter table events enable row level security;

-- Writing is yours; reading is yours. Nobody reads anybody else's trail.
create policy events_write_own on events
  for insert to authenticated with check (user_id = auth.uid());
create policy events_read_own on events
  for select to authenticated using (user_id = auth.uid());
