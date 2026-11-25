-- =====================================================================
-- 011 — Demand notes linked to jobs, automatic status
-- Run in Supabase → SQL Editor AFTER 010. Safe to run again.
--
--  * assignments.demand_id — the demand note a job covers ("Covers demand" /
--    "Plan this"). A note can be covered by several jobs. Deleting a note
--    just unlinks its jobs.
--  * demand_notes.status_override — the status is now worked out from the
--    linked jobs (Open → Partly planned → Fully planned → Done). Set this to
--    override it (open / planned / done); empty = automatic.
--    The first time this runs, notes you had marked Planned or Done keep that
--    status as an override (you can switch them back to automatic).
--  * demand_notes.status is kept in step by the app (done / planned / open)
--    for anything that still reads it.
-- RLS: unchanged — only admins edit jobs (so only admins link them); people
-- edit their own notes (including the override). Change log and live updates
-- already cover both tables.
-- =====================================================================

alter table public.assignments add column if not exists demand_id uuid references public.demand_notes (id) on delete set null;
create index if not exists assignments_demand_idx on public.assignments (demand_id) where demand_id is not null;

do $$
declare
  is_new boolean := not exists (select 1 from information_schema.columns
                                where table_schema = 'public' and table_name = 'demand_notes' and column_name = 'status_override');
begin
  alter table public.demand_notes add column if not exists status_override text
    check (status_override is null or status_override in ('open', 'partly', 'planned', 'done'));
  if is_new then
    update public.demand_notes set status_override = status where status in ('planned', 'done');
  end if;
end;
$$;

-- Grants (repeat in every migration; see README "Updating the database").
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant execute on all functions in schema public to authenticated;
revoke all on all tables in schema public from anon;
revoke insert, update, delete, truncate on public.audit_log from authenticated;

-- Tell the API (PostgREST) about the new columns straight away.
notify pgrst, 'reload schema';
