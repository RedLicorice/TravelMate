-- A card is where its clock says, so there is no position to store.
--
-- order_index survived 0049 only because the client still wrote it. Nothing
-- reads it now: a day is its cards sorted by `at`, which is the same fact the
-- traveller sees on the card and the same one they set when they move it.
-- Keeping a second answer to "what comes first" is keeping something to
-- disagree with.
alter table placements drop column order_index;
