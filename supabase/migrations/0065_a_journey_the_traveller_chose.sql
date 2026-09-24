-- The route the traveller chose for the journey to this card, among the
-- ones Google offered: its time, distance and a line naming it -- never the
-- path, which is Google Maps' to show.
--
--   {"from": "<placement id of the card before>", "mode": "transit",
--    "minutes": 22, "km": 3.4, "summary": "Keihan · 207"}
--
-- It holds only while the card before this one is `from`: moved, it is a
-- different journey, and the app lets the choice go.
alter table placements add column leg_choice jsonb;
