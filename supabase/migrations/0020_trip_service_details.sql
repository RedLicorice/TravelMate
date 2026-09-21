-- The service itself, not just the airport it leaves from. No provider gives
-- this away: OpenSky is live positions only and knows nothing about a flight
-- next Tuesday, and the schedule APIs all want a key. The traveller has it on
-- their ticket, so they type it once and the plan carries it.
alter table trips add column arrival_service text;
alter table trips add column arrival_booking_ref text;
alter table trips add column departure_service text;
alter table trips add column departure_booking_ref text;
