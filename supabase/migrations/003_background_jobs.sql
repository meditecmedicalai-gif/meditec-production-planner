-- =====================================================================
-- 003 — Background / overnight jobs and equipment
-- Run in Supabase → SQL Editor AFTER 002. Safe to run again.
--
-- * tasks.is_background         — task normally runs unattended
--                                  (seeded: "Soak / burn-in test")
-- * assignments.background      — per-job override: null = use the
--                                  task's setting, true / false = override
-- * assignments.start_time / end_time / end_date
--     - no times                 → whole day
--     - end_time <= start_time   → finishes the next day (overnight)
--     - end_date                 → runs until that date (multi-day)
-- * equipment                   — test rigs / stations (admin-editable)
-- * assignments.equipment_id    — optional link to one piece of equipment
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Tasks: background flag + seed
-- ---------------------------------------------------------------------
alter table public.tasks add column if not exists is_background boolean not null default false;

insert into public.tasks (name, requires_pump, counts_as_output, is_background, sort_order)
values ('Soak / burn-in test', true, false, true, 35)
on conflict (name) do nothing;   -- re-running never overrides your Settings

-- ---------------------------------------------------------------------
-- 2. Equipment / test stations
-- ---------------------------------------------------------------------
create table if not exists public.equipment (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique check (length(trim(name)) > 0),
  notes       text,
  active      boolean not null default true,
  sort_order  integer not null default 100,
  created_at  timestamptz not null default now()
);

insert into public.equipment (name, sort_order) values
  ('Test rig 1', 10),
  ('Test rig 2', 20),
  ('Soak rack',  30)
on conflict (name) do nothing;

-- ---------------------------------------------------------------------
-- 3. Assignment columns
-- ---------------------------------------------------------------------
alter table public.assignments
  add column if not exists background   boolean,
  add column if not exists start_time   time,
  add column if not exists end_time     time,
  add column if not exists end_date     date,
  add column if not exists equipment_id uuid references public.equipment (id) on delete restrict;

-- Rules: an end time needs a start time; an end date can't be before the start date.
alter table public.assignments drop constraint if exists assignments_end_time_needs_start;
alter table public.assignments add constraint assignments_end_time_needs_start
  check (end_time is null or start_time is not null);
alter table public.assignments drop constraint if exists assignments_end_date_after_start;
alter table public.assignments add constraint assignments_end_date_after_start
  check (end_date is null or end_date >= work_date);

create index if not exists assignments_end_date_idx on public.assignments (end_date) where end_date is not null;
create index if not exists assignments_equipment_idx on public.assignments (equipment_id) where equipment_id is not null;

-- ---------------------------------------------------------------------
-- 4. Security: RLS, policies, grants, audit
-- ---------------------------------------------------------------------
alter table public.equipment enable row level security;

drop policy if exists "equipment: members read"  on public.equipment;
drop policy if exists "equipment: admin insert"  on public.equipment;
drop policy if exists "equipment: admin update"  on public.equipment;
drop policy if exists "equipment: admin delete"  on public.equipment;
create policy "equipment: members read" on public.equipment
  for select to authenticated using (public.is_member());
create policy "equipment: admin insert" on public.equipment
  for insert to authenticated with check (public.is_admin());
create policy "equipment: admin update" on public.equipment
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "equipment: admin delete" on public.equipment
  for delete to authenticated using (public.is_admin());

drop trigger if exists audit on public.equipment;
create trigger audit after insert or update or delete on public.equipment
  for each row execute function public.write_audit_log();
-- (The new assignment columns are captured by the existing assignments audit trigger.)

-- Grants (repeat in every migration; see README "Updating the database").
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant execute on all functions in schema public to authenticated;
revoke all on all tables in schema public from anon;
revoke insert, update, delete, truncate on public.audit_log from authenticated;

select 'Migration 003 applied' as result,
       (select count(*) from public.equipment) as equipment_items,
       (select is_background from public.tasks where name = 'Soak / burn-in test') as soak_task_is_background;
