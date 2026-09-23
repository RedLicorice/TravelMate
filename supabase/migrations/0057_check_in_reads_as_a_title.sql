-- The check-in card reads "<hotel>: Check-In". The hotel's name is put in
-- front when the card is drawn, so it follows the hotel if that changes; what
-- the card itself says is only the part after the colon.
update placements set name = 'Check-In' where kind = 'hotel' and name = 'Check-in';
