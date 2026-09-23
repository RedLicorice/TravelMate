-- The check-out card reads "<hotel>: Check-Out", like the check-in card
-- (0057): the hotel's name is put in front when it is drawn.
update placements set name = 'Check-Out' where kind = 'chore' and name = 'Check-out';
