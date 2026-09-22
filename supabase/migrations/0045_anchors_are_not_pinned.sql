-- An anchor holds its place, not its clock.
--
-- Anchors were created pinned, and a pinned card is held to the time its card
-- already had. So the first walk's answer became permanent: a check-in card
-- that landed at ten past midnight stayed at ten past midnight, with two
-- hours of nothing in front of it, however the day was rearranged
-- afterwards. The planner holds an anchor in the position it was placed in
-- regardless; the pin only ever added a frozen clock.
update placements set pinned = false where kind <> 'stop';
