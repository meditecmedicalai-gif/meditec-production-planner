-- =====================================================================
-- 006 — Test capacity rules (Phase 8 answers)
-- Run in Supabase → SQL Editor AFTER 005. Safe to run again.
-- Brings an existing database in line with the agreed rules, without
-- overwriting anything you changed yourself in Settings:
--  * No site-wide limit: each test area is separate. The Main test area's
--    max 7 is the absolute max; Medicare / Mediflex (max 1) does not count
--    towards it.
--  * MATS and Bari-Med 1 have no limit group of their own — they only
--    count towards the Main test area.
--  * Rental repairs: no preset times. The seeded 08:30–16:30 is cleared
--    only if the template is still exactly as seeded (no person, times
--    unchanged); otherwise it is left alone.
--  * Calibration + quality testing on the same pump count once — this is a
--    planner rule (no data change needed).
-- =====================================================================

-- 1. Remove the site-wide limit (from the first version of 005).
alter table public.app_settings drop column if exists max_pumps_on_test;

-- 2. MATS and Bari-Med 1 are not part of any limit group.
delete from public.test_limit_models x
using public.pump_models m
where m.id = x.pump_model_id
  and m.name in ('MediAir Turn Sense (MATS)', 'Bari-Med 1');

-- 3. Rental repairs: drop the seeded default times if untouched.
update public.recurring_jobs r
set start_time = null, end_time = null
where r.title = 'Rental repairs'
  and r.person_id is null
  and r.start_time is not distinct from (select work_start from public.app_settings where id = 1)
  and r.end_time   is not distinct from (select work_end   from public.app_settings where id = 1);
update public.recurring_jobs
set notes = 'Rental returns — any pump. Assign a person and set the times to start.'
where title = 'Rental repairs' and person_id is null
  and notes = 'Rental returns — any pump. Assign a person to start.';

-- Grants (repeat in every migration; see README "Updating the database").
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant execute on all functions in schema public to authenticated;
revoke all on all tables in schema public from anon;
revoke insert, update, delete, truncate on public.audit_log from authenticated;

select 'Migration 006 applied' as result,
       (select string_agg(a.name || ' max ' || a.max_pumps, ' · ' order by a.sort_order) from public.test_areas a) as test_areas,
       (select string_agg(l.name || ' max ' || l.max_pumps, ' · ' order by l.sort_order) from public.test_limits l) as limit_groups,
       (select coalesce(to_char(start_time, 'HH24:MI') || '–' || to_char(end_time, 'HH24:MI'), 'not set (set it when assigning)')
          from public.recurring_jobs where title = 'Rental repairs' order by created_at limit 1) as rental_repairs_times;
