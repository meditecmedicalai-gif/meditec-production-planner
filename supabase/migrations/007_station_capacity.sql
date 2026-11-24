-- =====================================================================
-- 007 — Test capacity by STATION (equipment)
-- Run in Supabase → SQL Editor AFTER 006. Safe to run again; never
-- overwrites anything you changed yourself.
--
--  * Each equipment / station item can be linked to a test area.
--  * A job booked on a linked station counts towards that station's test
--    area — for any task, as long as it has a quantity (pumps). Jobs
--    without a station keep the old rule (testing task + the pump model's
--    default test area).
--  * "Main test area" is renamed "Quality Check" (only if it still has the
--    original name; its max and your other edits are kept).
--  * Stations added if missing: "Quality Check" → Quality Check area,
--    "Medicare / Mediflex test bench" → Medicare / Mediflex test area.
-- =====================================================================

-- 1. Station → test area link
alter table public.equipment add column if not exists test_area_id uuid references public.test_areas (id) on delete set null;
create index if not exists equipment_test_area_idx on public.equipment (test_area_id) where test_area_id is not null;

-- 2. Rename the main area (only if untouched, and only if the new name is free)
update public.test_areas set name = 'Quality Check'
where name = 'Main test area'
  and not exists (select 1 from public.test_areas where name = 'Quality Check');

-- 3. Stations
insert into public.equipment (name, notes, sort_order)
values ('Quality Check', 'Main test station — QPro 2000, Simplex, MediAir, MediAir Turn, MATS, Bari-Med 1', 5),
       ('Medicare / Mediflex test bench', 'Separate bench, 1 pump at a time', 6)
on conflict (name) do nothing;

update public.equipment set test_area_id = (select id from public.test_areas where name = 'Quality Check')
where name = 'Quality Check' and test_area_id is null;
update public.equipment set test_area_id = (select id from public.test_areas where name = 'Medicare / Mediflex test area')
where name = 'Medicare / Mediflex test bench' and test_area_id is null;

-- Grants (repeat in every migration; see README "Updating the database").
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant execute on all functions in schema public to authenticated;
revoke all on all tables in schema public from anon;
revoke insert, update, delete, truncate on public.audit_log from authenticated;

select 'Migration 007 applied' as result,
       (select string_agg(a.name || ' max ' || a.max_pumps, ' · ' order by a.sort_order) from public.test_areas a) as test_areas,
       (select string_agg(e.name || ' → ' || coalesce(a.name, '(no test area)'), ' · ' order by e.sort_order)
          from public.equipment e left join public.test_areas a on a.id = e.test_area_id) as stations;
