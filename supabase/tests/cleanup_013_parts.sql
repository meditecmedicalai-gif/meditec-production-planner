-- =====================================================================
-- Optional clean-up of jobs over several days — run AFTER checking
-- supabase/tests/report_013_parts.sql. Needs migration 013.
--
-- Fixes only what is unambiguous (rows marked "clean-up" in the report):
--   1. parts that point at another part → re-pointed at part 1 of their job;
--   2. two or more parts of one job on the same day → one is kept (part 1 if it is
--      on that day, else the most recently added part — the old app added a new one on every save); the others are deleted.
-- Everything else in the report ("open + Save") needs the person's hours: open the
-- job in the planner and click Save, and it re-flows from part 1.
--
-- Every change goes through the normal triggers, so it is in History (audit log).
-- The script runs as one transaction: if anything fails, nothing changes.
-- The result lists how many rows each step changed. Safe to run again (then 0, 0).
-- =====================================================================
begin;
create temp table if not exists cleanup_013_result (step text, rows_changed int);
truncate cleanup_013_result;

-- 1. re-point parts at the root part 1 of their job (follows chains of any length)
with recursive up as (
  select a.id, a.part_of as root from public.assignments a where a.part_of is not null
  union all
  select up.id, h.part_of from up join public.assignments h on h.id = up.root where h.part_of is not null
),
roots as (select id, root from up u where not exists (select 1 from public.assignments h where h.id = u.root and h.part_of is not null)),
fixed as (
  update public.assignments a set part_of = r.root
  from roots r where a.id = r.id and a.part_of is distinct from r.root
  returning 1
)
insert into cleanup_013_result select '1. parts re-pointed at part 1', count(*) from fixed;

-- 2. one part per job per day: keep part 1 (if on that day), else the most recently added part
with ranked as (
  select a.id,
         row_number() over (partition by coalesce(a.part_of, a.id), a.work_date
                            order by (a.part_of is null) desc, a.created_at desc, a.updated_at desc) as rn
  from public.assignments a
  where a.part_of is not null or exists (select 1 from public.assignments c where c.part_of = a.id)
),
gone as (
  delete from public.assignments a using ranked r where a.id = r.id and r.rn > 1 returning 1
)
insert into cleanup_013_result select '2. duplicate parts on the same day deleted', count(*) from gone;

commit;   -- the one-part-per-day guard checks everything here

select * from cleanup_013_result order by step;
