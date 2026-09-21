-- When a traveller is actually out of the door, and breakfast.
alter table profiles
  add column wake_at time not null default '08:00',
  -- Showering, packing a bag, arguing about the umbrella.
  add column prep_min int not null default 30 check (prep_min between 0 and 240);

-- Existing rows carry only lunch and dinner. Give them breakfast rather than
-- leaving a shape the code has to keep guarding against.
update profiles
set meal_windows = meal_windows || '{"breakfast":{"from":"07:00","to":"10:00"}}'::jsonb
where not (meal_windows ? 'breakfast');

alter table profiles
  alter column meal_windows
  set default '{"breakfast":{"from":"07:00","to":"10:00"},"lunch":{"from":"12:00","to":"15:00"},"dinner":{"from":"19:00","to":"22:00"}}'::jsonb;
