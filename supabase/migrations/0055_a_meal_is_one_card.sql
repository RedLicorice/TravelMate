-- A meal is one card.
--
-- Since 0051 a sitting has been a placement, but what the traveller said about
-- it lived beside it in trip_meals: which place it was at, or that it was
-- skipped. So a breakfast was up to three things -- the card, a note, and a
-- separate stop card for the cafe -- and a screen could "add a breakfast" by
-- writing the note alone, with nothing on the day to show for it.
--
-- Now the card says it all. A meal card holds the place it is at, or nothing
-- (still to decide), or is skipped (no breakfast that day, on purpose: it
-- takes no time and is not drawn). Replan never invents a meal on a day that
-- already has that meal's card, so a skip is remembered by the card being
-- there.

alter table placements add column skipped boolean not null default false;

-- A stop needs a place; a meal may have one; the day's other cards have none.
alter table placements drop constraint placements_stop_has_a_place;
alter table placements add constraint placements_place_fits_kind check (
  (kind = 'stop' and poi_id is not null)
  or kind = 'meal'
  or (kind in ('hotel', 'chore') and poi_id is null)
);
-- Only a meal is skipped, and a skipped meal is at no place.
alter table placements add constraint placements_skip_is_a_meal
  check (not skipped or (kind = 'meal' and poi_id is null));

-- What trip_meals said, onto the cards. A note that says neither a place nor
-- a skip says nothing, and goes with the table.
--
-- A day that already has the card: the card takes what the note said.
update placements p
  set poi_id = case when tm.skipped then null else tm.poi_id end,
      skipped = tm.skipped
  from trip_meals tm
  where p.trip_id = tm.trip_id
    and p.day_index = tm.day_index
    and p.kind = 'meal'
    and p.meal = tm.meal
    and (tm.skipped or tm.poi_id is not null);

-- A day that has not: the card is made, at the sitting's usual hour on that
-- day in the trip's own zone. Its time is the traveller's to move.
insert into placements (trip_id, kind, meal, poi_id, skipped, day_index, at)
select tm.trip_id, 'meal', tm.meal,
       case when tm.skipped then null else tm.poi_id end,
       tm.skipped,
       tm.day_index,
       ((t.arrival_at at time zone t.timezone)::date + tm.day_index
         + case tm.meal when 'breakfast' then time '08:00'
                        when 'lunch' then time '13:00'
                        else time '20:00' end) at time zone t.timezone
from trip_meals tm
join trips t on t.id = tm.trip_id
where (tm.skipped or tm.poi_id is not null)
  and not exists (
    select 1 from placements p
    where p.trip_id = tm.trip_id and p.day_index = tm.day_index
      and p.kind = 'meal' and p.meal = tm.meal
  );

drop table trip_meals;

-- apply_mutation names trip_meals among the tables an edit may write. Left
-- there it would only ever fail; it is taken out.
create or replace function apply_mutation(mutation uuid, ops jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  allowed constant text[] := '{trips,pois,placements,trip_members,profiles}';
  o jsonb;
  i int := 0;
  tbl text;
  cols text;
  found_row jsonb;
  written jsonb;
  results jsonb := '[]';
  conflicts jsonb := '[]';
  lock_key text;
begin
  for lock_key in
    select distinct coalesce(x->>'lock', x->>'trip')
    from jsonb_array_elements(ops) x
    order by 1
  loop
    perform pg_advisory_xact_lock(hashtext(lock_key));
  end loop;

  -- Sent twice: answer with what the rows are now, and write nothing.
  if exists (select 1 from applied_mutations where id = mutation) then
    for o in select * from jsonb_array_elements(ops) loop
      if o->>'op' = 'plan' then
        results := results || jsonb_build_array(null);
      else
        execute format('select to_jsonb(%I.*) from %I where %s',
                       o->>'table', o->>'table', mutation_key(o->>'table', o->'key'))
          into found_row;
        results := results || jsonb_build_array(found_row);
      end if;
    end loop;
    return jsonb_build_object('status', 'applied', 'rows', results);
  end if;

  -- Every row checked before anything is written.
  for o in select * from jsonb_array_elements(ops) loop
    if o->>'op' <> 'plan' then
      tbl := o->>'table';
      if not tbl = any (allowed) then
        raise exception 'apply_mutation: % is not a table an edit may write', tbl
          using errcode = '42501';
      end if;
      execute format('select to_jsonb(%I.*) from %I where %s',
                     tbl, tbl, mutation_key(tbl, o->'key'))
        into found_row;
      if (o->>'op' = 'insert' and found_row is not null)
         or (o->>'op' = 'update' and (found_row is null
                                      or (found_row->>'version')::bigint is distinct from (o->>'base')::bigint))
         or (o->>'op' = 'delete' and found_row is not null
                                 and (found_row->>'version')::bigint is distinct from (o->>'base')::bigint)
      then
        conflicts := conflicts || jsonb_build_object('index', i, 'upstream', found_row);
      end if;
    end if;
    i := i + 1;
  end loop;

  if jsonb_array_length(conflicts) > 0 then
    return jsonb_build_object('status', 'conflict', 'conflicts', conflicts);
  end if;

  for o in select * from jsonb_array_elements(ops) loop
    tbl := o->>'table';
    written := null;
    if o->>'op' = 'plan' then
      -- save_plan's own policies decide who may write the plan. The stamp
      -- on the trip is the owner's row, so an editor's save leaves it be,
      -- as it always has.
      perform save_plan(
        (o->>'trip')::uuid,
        o->'rows',
        case when jsonb_typeof(o->'days') = 'array'
             then array(select jsonb_array_elements_text(o->'days')::int)
        end);
      update trips
        set plan_generated_at = (o->>'generated_at')::timestamptz,
            plan_version = (o->>'planner_version')::int
        where id = (o->>'trip')::uuid;
    elsif o->>'op' = 'insert' then
      select string_agg(format('%I', k), ', ') into cols
        from jsonb_object_keys((o->'values') - 'version') k;
      execute format('insert into %I (%s) select %s from jsonb_populate_record(null::%I, $1) returning to_jsonb(%I.*)',
                     tbl, cols, cols, tbl, tbl)
        using (o->'values') - 'version'
        into written;
    elsif o->>'op' = 'update' then
      select string_agg(format('%I', k), ', ') into cols
        from jsonb_object_keys((o->'values') - 'version') k;
      execute format('update %I set (%s) = (select %s from jsonb_populate_record(null::%I, $1)) where %s returning to_jsonb(%I.*)',
                     tbl, cols, cols, tbl, mutation_key(tbl, o->'key'), tbl)
        using (o->'values') - 'version'
        into written;
      -- It was there a moment ago, so a write that touched nothing is a
      -- write the policies would not let through.
      if written is null then
        raise exception 'apply_mutation: this change to % may not be made', tbl
          using errcode = '42501';
      end if;
    elsif o->>'op' = 'delete' then
      execute format('delete from %I where %s', tbl, mutation_key(tbl, o->'key'));
      -- Gone already is what was asked for. Still there is a refusal.
      execute format('select to_jsonb(%I.*) from %I where %s',
                     tbl, tbl, mutation_key(tbl, o->'key'))
        into found_row;
      if found_row is not null then
        raise exception 'apply_mutation: this % may not be removed', tbl
          using errcode = '42501';
      end if;
    else
      raise exception 'apply_mutation: unknown op %', o->>'op' using errcode = '22023';
    end if;
    results := results || jsonb_build_array(written);
  end loop;

  insert into applied_mutations (id) values (mutation);
  -- ponytail: a month of ids is far longer than any queue waits to be sent.
  delete from applied_mutations
    where user_id = auth.uid() and applied_at < now() - interval '30 days';

  return jsonb_build_object('status', 'applied', 'rows', results);
end;
$$;
