-- Jobs that run over several days ("Ends on" set). Optional review after 009:
-- a short job such as 10:00–11:00 with "Ends on" the next day was probably set
-- by mistake (it shows as "10:00 → 11:00 next day"). Open it in the planner and
-- untick "Runs over several days" — or clear them all with the UPDATE below.
select a.id, p.name as person, a.work_date, a.end_date, a.start_time, a.end_time, t.name as task,
       case when a.end_date = a.work_date + 1 and a.start_time < a.end_time
              and a.end_time - a.start_time <= interval '8 hours'
            then 'probably a mistake' else '' end as check
from public.assignments a
join public.people p on p.id = a.person_id
join public.tasks t on t.id = a.task_id
where a.end_date is not null
order by a.work_date desc;

-- To clear the likely mistakes (only after checking the list above):
-- update public.assignments set end_date = null
-- where end_date = work_date + 1 and start_time < end_time and end_time - start_time <= interval '8 hours';
