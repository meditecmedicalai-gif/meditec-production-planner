-- =====================================================================
-- Report: jobs over several days with duplicate, overlapping or stray parts.
-- Read-only. Run in Supabase → SQL Editor after migration 013.
-- No rows = nothing to fix.
--
-- What to do with each row (the "fix" column):
--   * "clean-up"   → supabase/tests/cleanup_013_parts.sql fixes it (run it after checking this report);
--   * "open + Save" → open the job in the planner and click Save: it re-flows all its parts
--                     from part 1 using the person's hours (moving or removing the extra parts).
-- =====================================================================
with s as (                                   -- every row of a job over several days
  select a.*, coalesce(a.part_of, a.id) as job
  from public.assignments a
  where a.part_of is not null or exists (select 1 from public.assignments c where c.part_of = a.id)
),
head as (select * from public.assignments where id in (select job from s)),
ordered as (
  select s.*, lag(s.work_date) over (partition by s.job order by s.work_date, s.part_of nulls first) as prev_date,
         lead(s.id) over (partition by s.job order by s.work_date, s.part_of nulls first) as next_id
  from s
),
problems as (
  -- 1. two or more parts of the same job on one day (duplicates pile-up)
  select job, 'Two or more parts of the job on the same day' as problem, min(work_date) as on_date,
         string_agg(coalesce(to_char(start_time, 'HH24:MI'), '?') || '–' || coalesce(to_char(end_time, 'HH24:MI'), '?'), ', ' order by start_time) as detail,
         'clean-up (keeps part 1, else the most recently added part)' as fix
  from s group by job, work_date having count(*) > 1
  union all
  -- 2. a part pointing at another part instead of part 1
  select h.part_of, 'Part points at another part (not part 1)', p.work_date, null, 'clean-up'
  from public.assignments p join public.assignments h on h.id = p.part_of where h.part_of is not null
  union all
  -- 3. a continued part left on an old date: on or before part 1's day
  select p.job, 'Continued part on or before part 1 (left on an old date)', p.work_date, 'part 1 is on ' || to_char(h.work_date, 'Dy DD Mon'), 'open + Save'
  from s p join head h on h.id = p.job where p.part_of is not null and p.work_date < h.work_date
  union all
  -- 4. a part far away from the one before it
  select job, 'Part left far from the rest of the job (more than 7 days after the previous part)', work_date,
         'previous part ' || to_char(prev_date, 'Dy DD Mon'), 'open + Save'
  from ordered where prev_date is not null and work_date - prev_date > 7
  union all
  -- 5. more parts than the work needs: a part that is not the last ends before midday, yet the job continues
  select job, 'Possibly more parts than the total work time needs', work_date,
         'this part ends ' || to_char(end_time, 'HH24:MI') || ' but the job continues', 'open + Save'
  from ordered where next_id is not null and end_time is not null and end_time < '12:00'
  union all
  -- 6. parts that don't share part 1's person / task / pump (changes not applied to all parts)
  select p.job, 'Part differs from part 1 (' || concat_ws(', ',
           case when p.person_id <> h.person_id then 'person' end, case when p.task_id <> h.task_id then 'task' end,
           case when p.pump_model_id is distinct from h.pump_model_id then 'pump model' end,
           case when p.build_type_id is distinct from h.build_type_id then 'build type' end,
           case when p.equipment_id is distinct from h.equipment_id then 'station' end) || ')',
         p.work_date, null, 'open + Save'
  from s p join head h on h.id = p.job
  where p.part_of is not null and (p.person_id <> h.person_id or p.task_id <> h.task_id or p.pump_model_id is distinct from h.pump_model_id
     or p.build_type_id is distinct from h.build_type_id or p.equipment_id is distinct from h.equipment_id)
)
select pr.problem, to_char(pr.on_date, 'Dy DD Mon YYYY') as on_day,
       pe.name as person, t.name as task, m.name as pump_model,
       to_char(h.work_date, 'Dy DD Mon') || coalesce(' ' || to_char(h.start_time, 'HH24:MI'), '') as job_starts,
       (select count(*) from public.assignments x where coalesce(x.part_of, x.id) = pr.job) as parts_now,
       pr.detail, pr.fix, pr.job as job_id
from problems pr
left join public.assignments h on h.id = pr.job
left join public.people pe on pe.id = h.person_id
left join public.tasks t on t.id = h.task_id
left join public.pump_models m on m.id = h.pump_model_id
order by h.work_date, pe.name, pr.problem;
