-- The shape of a day is the traveller's.
--
-- Every day is drawn with the same furniture: it starts at the hotel, the
-- first half hour is spent getting out of the door, and it ends back at the
-- hotel. That is what most days are and it is a good guess -- but it is a
-- guess, and there was no way to say otherwise. Somebody who means to be out
-- all night had a card telling them they go to bed, and the plan arranged the
-- evening around a return they were not making.
--
-- So a day may have a piece of its furniture taken out. Nothing here invents
-- anchors: it records which of the ones the trip would draw are not wanted on
-- that day.
create table day_skips (
  trip_id   uuid not null references trips on delete cascade,
  day_index int not null,
  -- 'hotel-start', 'hotel-end', 'prep', 'check-in', 'bags-collect'.
  -- Deliberately not a check constraint: the set of things a day is drawn
  -- with is the app's to change, and a trip that has skipped something the
  -- app no longer draws should be ignored rather than refused.
  anchor    text not null,
  primary key (trip_id, day_index, anchor)
);

alter table day_skips enable row level security;
create policy day_skips_member_read on day_skips
  for select using (is_trip_member(trip_id));
create policy day_skips_editor_write on day_skips
  for all using (can_edit_trip(trip_id)) with check (can_edit_trip(trip_id));
