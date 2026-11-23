-- =====================================================================
-- Meditec Pump Room Production Planner — initial schema
-- Run this whole file once in Supabase: Dashboard → SQL Editor → New query.
-- It is safe to run again (idempotent): it creates what is missing and
-- re-applies functions, triggers and policies.
--
-- Security model: the frontend only has the public "anon" key, so ALL
-- access control is enforced here with Row Level Security (RLS).
--   * admin  : full read/write
--   * viewer : read everything (except audit_log); create demand notes
--              and edit their OWN demand notes; cannot delete anything
--   * anyone without an active profile (or not logged in): nothing
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------

-- App users (one row per Supabase Auth user, created automatically).
create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text not null,
  full_name   text,
  app_role    text not null default 'viewer' check (app_role in ('admin', 'viewer')),
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- Pump room team members (do not need a login).
create table if not exists public.people (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(trim(name)) > 0),
  job_title   text,
  notes       text,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.pump_models (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique check (length(trim(name)) > 0),
  short_code  text,
  is_trial    boolean not null default false,
  active      boolean not null default true,
  sort_order  integer not null default 100,
  created_at  timestamptz not null default now()
);

create table if not exists public.tasks (
  id               uuid primary key default gen_random_uuid(),
  name             text not null unique check (length(trim(name)) > 0),
  requires_pump    boolean not null default true,   -- must an assignment name a pump model?
  counts_as_output boolean not null default false,  -- counted as "units produced" in the weekly summary
  active           boolean not null default true,
  sort_order       integer not null default 100,
  created_at       timestamptz not null default now()
);

-- Which pump models a person is trained on.
create table if not exists public.person_skills (
  person_id     uuid not null references public.people (id) on delete cascade,
  pump_model_id uuid not null references public.pump_models (id) on delete cascade,
  created_at    timestamptz not null default now(),
  primary key (person_id, pump_model_id)
);

-- Planned work: one or more per person per day.
create table if not exists public.assignments (
  id            uuid primary key default gen_random_uuid(),
  person_id     uuid not null references public.people (id) on delete restrict,
  work_date     date not null,
  pump_model_id uuid references public.pump_models (id) on delete restrict,
  task_id       uuid not null references public.tasks (id) on delete restrict,
  qty_target    integer check (qty_target is null or qty_target >= 0),
  notes         text,
  created_by    uuid default auth.uid() references auth.users (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_by    uuid references auth.users (id) on delete set null,
  updated_at    timestamptz not null default now()
);
create index if not exists assignments_work_date_idx on public.assignments (work_date);
create index if not exists assignments_person_date_idx on public.assignments (person_id, work_date);

-- Holiday / sickness / training course / off-site, for a date range.
create table if not exists public.absences (
  id            uuid primary key default gen_random_uuid(),
  person_id     uuid not null references public.people (id) on delete cascade,
  start_date    date not null,
  end_date      date not null,
  absence_type  text not null check (absence_type in ('holiday', 'sick', 'training', 'off_site')),
  notes         text,
  created_by    uuid default auth.uid() references auth.users (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_by    uuid references auth.users (id) on delete set null,
  updated_at    timestamptz not null default now(),
  check (end_date >= start_date)
);
create index if not exists absences_dates_idx on public.absences (start_date, end_date);

-- Demand & notes (admin and viewer can post).
create table if not exists public.demand_notes (
  id            uuid primary key default gen_random_uuid(),
  pump_model_id uuid references public.pump_models (id) on delete restrict,
  quantity      integer check (quantity is null or quantity >= 0),
  needed_by     date,
  priority      text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  comment       text,
  status        text not null default 'open' check (status in ('open', 'planned', 'done')),
  created_by    uuid default auth.uid() references auth.users (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_by    uuid references auth.users (id) on delete set null,
  updated_at    timestamptz not null default now()
);
create index if not exists demand_notes_status_idx on public.demand_notes (status, needed_by);

-- Site settings: exactly one row (id = 1).
create table if not exists public.app_settings (
  id             smallint primary key default 1 check (id = 1),
  work_start     time not null default '08:30',
  work_end       time not null default '16:30',
  break_time     time not null default '10:30',
  break_minutes  integer not null default 15 check (break_minutes >= 0),
  lunch_time     time not null default '12:30',
  lunch_minutes  integer not null default 30 check (lunch_minutes >= 0),
  updated_by     uuid references auth.users (id) on delete set null,
  updated_at     timestamptz not null default now()
);

-- Change log, written only by triggers.
create table if not exists public.audit_log (
  id          bigint generated always as identity primary key,
  table_name  text not null,
  record_id   uuid,
  action      text not null check (action in ('insert', 'update', 'delete')),
  old_data    jsonb,
  new_data    jsonb,
  changed_by  uuid,
  changed_at  timestamptz not null default now()
);
create index if not exists audit_log_record_idx on public.audit_log (table_name, record_id);
create index if not exists audit_log_changed_at_idx on public.audit_log (changed_at desc);

-- ---------------------------------------------------------------------
-- 2. Helper functions (SECURITY DEFINER so policies can check roles
--    without recursive RLS on profiles).
-- ---------------------------------------------------------------------

create or replace function public.is_member()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.active
  );
$$;

create or replace function public.is_admin()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.active and p.app_role = 'admin'
  );
$$;

revoke all on function public.is_member() from public, anon;
revoke all on function public.is_admin()  from public, anon;
grant execute on function public.is_member() to authenticated;
grant execute on function public.is_admin()  to authenticated;

-- Create a profile (role = viewer) whenever a user is added in Supabase Auth.
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Back-fill profiles for any users created before this migration ran.
insert into public.profiles (id, email, full_name)
select u.id, u.email, split_part(u.email, '@', 1)
from auth.users u
on conflict (id) do nothing;

-- Stamp updated_at / updated_by and protect created_by / created_at.
create or replace function public.stamp_row()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  if tg_op = 'UPDATE' then
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;
  return new;
end;
$$;

-- Same for tables that only track updated_at.
create or replace function public.stamp_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create or replace function public.stamp_settings()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;

-- Audit trigger: SECURITY DEFINER so it can write to audit_log even
-- though no user has insert rights on that table.
create or replace function public.write_audit_log()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.audit_log (table_name, record_id, action, old_data, new_data, changed_by)
    values (tg_table_name, new.id, 'insert', null, to_jsonb(new), auth.uid());
    return new;
  elsif tg_op = 'UPDATE' then
    insert into public.audit_log (table_name, record_id, action, old_data, new_data, changed_by)
    values (tg_table_name, new.id, 'update', to_jsonb(old), to_jsonb(new), auth.uid());
    return new;
  else
    insert into public.audit_log (table_name, record_id, action, old_data, new_data, changed_by)
    values (tg_table_name, old.id, 'delete', to_jsonb(old), null, auth.uid());
    return old;
  end if;
end;
$$;
revoke all on function public.write_audit_log() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. Triggers
-- ---------------------------------------------------------------------

drop trigger if exists stamp on public.assignments;
create trigger stamp before insert or update on public.assignments
  for each row execute function public.stamp_row();

drop trigger if exists stamp on public.absences;
create trigger stamp before insert or update on public.absences
  for each row execute function public.stamp_row();

drop trigger if exists stamp on public.demand_notes;
create trigger stamp before insert or update on public.demand_notes
  for each row execute function public.stamp_row();

drop trigger if exists stamp on public.people;
create trigger stamp before update on public.people
  for each row execute function public.stamp_updated_at();

drop trigger if exists stamp on public.app_settings;
create trigger stamp before insert or update on public.app_settings
  for each row execute function public.stamp_settings();

drop trigger if exists audit on public.assignments;
create trigger audit after insert or update or delete on public.assignments
  for each row execute function public.write_audit_log();

drop trigger if exists audit on public.demand_notes;
create trigger audit after insert or update or delete on public.demand_notes
  for each row execute function public.write_audit_log();

drop trigger if exists audit on public.absences;
create trigger audit after insert or update or delete on public.absences
  for each row execute function public.write_audit_log();

-- ---------------------------------------------------------------------
-- 4. Row Level Security
-- ---------------------------------------------------------------------

alter table public.profiles      enable row level security;
alter table public.people        enable row level security;
alter table public.pump_models   enable row level security;
alter table public.tasks         enable row level security;
alter table public.person_skills enable row level security;
alter table public.assignments   enable row level security;
alter table public.absences      enable row level security;
alter table public.demand_notes  enable row level security;
alter table public.app_settings  enable row level security;
alter table public.audit_log     enable row level security;

-- Logged-out visitors (anon key only) get no table access at all.
revoke all on all tables in schema public from anon;

-- The audit log can never be written or changed through the API.
revoke insert, update, delete, truncate on public.audit_log from authenticated;

-- profiles: members can see who is who; only admins change roles/status.
drop policy if exists "profiles: members read"  on public.profiles;
drop policy if exists "profiles: admin update"  on public.profiles;
create policy "profiles: members read" on public.profiles
  for select to authenticated using (public.is_member() or id = auth.uid());
create policy "profiles: admin update" on public.profiles
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
-- (no insert/delete policies: rows come from the auth trigger / cascade)

-- Reference & planning tables: members read, admin writes.
do $$
declare t text;
begin
  foreach t in array array['people', 'pump_models', 'tasks', 'person_skills',
                           'assignments', 'absences', 'app_settings']
  loop
    execute format('drop policy if exists "%1$s: members read" on public.%1$I', t);
    execute format('drop policy if exists "%1$s: admin insert" on public.%1$I', t);
    execute format('drop policy if exists "%1$s: admin update" on public.%1$I', t);
    execute format('drop policy if exists "%1$s: admin delete" on public.%1$I', t);
    execute format('create policy "%1$s: members read" on public.%1$I for select to authenticated using (public.is_member())', t);
    execute format('create policy "%1$s: admin insert" on public.%1$I for insert to authenticated with check (public.is_admin())', t);
    execute format('create policy "%1$s: admin update" on public.%1$I for update to authenticated using (public.is_admin()) with check (public.is_admin())', t);
    execute format('create policy "%1$s: admin delete" on public.%1$I for delete to authenticated using (public.is_admin())', t);
  end loop;
end;
$$;

-- demand_notes: members read and create; admin edits anything,
-- a viewer edits only their own notes; only admin deletes.
drop policy if exists "demand_notes: members read"   on public.demand_notes;
drop policy if exists "demand_notes: members insert" on public.demand_notes;
drop policy if exists "demand_notes: update"         on public.demand_notes;
drop policy if exists "demand_notes: admin delete"   on public.demand_notes;
create policy "demand_notes: members read" on public.demand_notes
  for select to authenticated using (public.is_member());
create policy "demand_notes: members insert" on public.demand_notes
  for insert to authenticated
  with check (public.is_member() and created_by = auth.uid());
create policy "demand_notes: update" on public.demand_notes
  for update to authenticated
  using (public.is_admin() or (public.is_member() and created_by = auth.uid()))
  with check (public.is_admin() or (public.is_member() and created_by = auth.uid()));
create policy "demand_notes: admin delete" on public.demand_notes
  for delete to authenticated using (public.is_admin());

-- audit_log: admin read only.
drop policy if exists "audit_log: admin read" on public.audit_log;
create policy "audit_log: admin read" on public.audit_log
  for select to authenticated using (public.is_admin());

-- ---------------------------------------------------------------------
-- 5. Seed data (only inserts what is missing)
-- ---------------------------------------------------------------------

insert into public.app_settings (id) values (1) on conflict (id) do nothing;

insert into public.pump_models (name, short_code, sort_order) values
  ('QPro 2000',               'QPro',     10),
  ('Simplex',                 'Simplex',  20),
  ('MediAir',                 'MediAir',  30),
  ('MediAir Turn',            'MA Turn',  40),
  ('MediAir Turn Sense (MATS)', 'MATS',   50),
  ('Mediflex',                'Mediflex', 60),
  ('Medicare',                'Medicare', 70),
  ('Bari-Med 1',              'Bari-Med', 80)
on conflict (name) do nothing;

insert into public.tasks (name, requires_pump, counts_as_output, sort_order) values
  ('Sub-assembly',                 true,  false, 10),
  ('Final assembly',               true,  true,  20),
  ('Functional test / calibration', true, false, 30),
  ('QC & Packing',                 true,  false, 40),
  ('Rework',                       true,  false, 50),
  ('Repair',                       true,  false, 60),
  ('Training',                     false, false, 70),
  ('Stock room / 5S',              false, false, 80),
  ('Other',                        false, false, 90)
on conflict (name) do nothing;
