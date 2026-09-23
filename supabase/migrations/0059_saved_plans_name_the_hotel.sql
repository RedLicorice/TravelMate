-- The saved plan is what a day is drawn from, and it copies a card's name
-- only when the day is re-timed. So days saved before 0057 and 0058 still
-- read "Check-in" and "Check-out" until something on them changes. They are
-- given the names the cards now draw: "<hotel>: Check-In", "<hotel>: Check-Out".
update plan_stops s
  set name = t.hotel_name || ': ' || case s.name when 'Check-in' then 'Check-In' else 'Check-Out' end
  from trips t
  where t.id = s.trip_id and s.name in ('Check-in', 'Check-out');
