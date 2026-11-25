-- =====================================================================
-- 009 — Job timing: pause for breaks, jobs continued on the next working day
-- Run in Supabase → SQL Editor AFTER 008. Safe to run again.
--
--  * assignments.pause_for_breaks — attended jobs pause for the person's
--    break and lunch (default ON). The saved end time already includes the
--    pause (e.g. 10:00 + 2h work, break 10:30–10:45 → ends 12:15).
--  * assignments.part_of — a job continued onto the next working day(s) is
--    saved as parts; parts 2, 3 … point at part 1 (deleting part 1 deletes
--    them). Quantities count once, on part 1.
--  * Tidy-up: an "Ends on" equal to the job's own date means nothing, so it
--    is cleared. (To review jobs whose "Ends on" is the NEXT day — possibly set
--    by mistake — run supabase/tests/check_multiday_jobs.sql.)
-- RLS, the change log and live updates already cover these columns.
-- =====================================================================

alter table public.assignments add column if not exists pause_for_breaks boolean not null default true;
alter table public.assignments add column if not exists part_of uuid references public.assignments (id) on delete cascade;
create index if not exists assignments_part_of_idx on public.assignments (part_of) where part_of is not null;

alter table public.assignments drop constraint if exists assignments_part_not_self;
alter table public.assignments add constraint assignments_part_not_self check (part_of is null or part_of <> id);

update public.assignments set end_date = null where end_date = work_date;

-- Grants (repeat in every migration; see README "Updating the database").
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant execute on all functions in schema public to authenticated;
revoke all on all tables in schema public from anon;
revoke insert, update, delete, truncate on public.audit_log from authenticated;

-- Tell the API (PostgREST) about the new columns straight away.
notify pgrst, 'reload schema';
