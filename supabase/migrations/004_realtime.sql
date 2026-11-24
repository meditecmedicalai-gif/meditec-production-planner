-- =====================================================================
-- 004 — Live updates (Supabase Realtime) + refreshed build-type colours
-- Run in Supabase → SQL Editor AFTER 003. Safe to run again.
--
-- Realtime sends a message to signed-in browsers when a row changes, so
-- the other person's screen refreshes by itself. It is still protected by
-- RLS: Supabase only delivers a change to a user who is allowed to SELECT
-- that row under the table's policies (logged-out visitors get nothing,
-- and audit_log is NOT published at all).
-- =====================================================================

-- 1. Add the planning tables to the "supabase_realtime" publication.
do $$
declare
  t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  -- A publication created "for all tables" already includes everything.
  if (select puballtables from pg_publication where pubname = 'supabase_realtime') then
    return;
  end if;
  foreach t in array array['assignments', 'absences', 'demand_notes', 'people', 'person_skills',
                           'pump_models', 'tasks', 'build_types', 'equipment', 'app_settings']
  loop
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end;
$$;

-- 2. Harmonise the seeded build-type colours with the new palette.
--    Only colours still at their original seed value are changed, so any
--    colour you picked yourself in Settings is kept.
update public.build_types set color = '#3E5C7E' where name = 'Production' and lower(color) = '#475569';
update public.build_types set color = '#A14D06' where name = 'Trial'      and lower(color) = '#b45309';
update public.build_types set color = '#0F766E' where name = 'Rental'     and lower(color) = '#7c3aed';
-- Customer (#0369A1) already fits the palette.

-- 3. Grants (repeat in every migration; see README "Updating the database").
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant execute on all functions in schema public to authenticated;
revoke all on all tables in schema public from anon;
revoke insert, update, delete, truncate on public.audit_log from authenticated;

select 'Migration 004 applied' as result,
       (select count(*) from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public') as tables_with_live_updates,
       (select string_agg(name || ' ' || color, ', ' order by sort_order) from public.build_types) as build_type_colours;
