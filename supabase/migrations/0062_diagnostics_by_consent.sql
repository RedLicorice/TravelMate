-- Diagnostics are sent only by someone who agreed to send them.
--
-- The published app records events too now, so whether a traveller agreed
-- is kept with them: null until asked, then their answer. Off unless yes.
alter table profiles add column telemetry boolean;

-- Saying no later takes back what was already sent: a traveller may delete
-- their own trail, and only their own.
create policy events_delete_own on events
  for delete to authenticated using (user_id = auth.uid());

-- Kept for fifteen days, then gone: long enough to read a fault out of, not
-- a history of anyone's holidays. Checked once a night.
create extension if not exists pg_cron;
select cron.schedule(
  'events-retention',
  '17 3 * * *',
  $$delete from public.events where at < now() - interval '15 days'$$
);
delete from events where at < now() - interval '15 days';
