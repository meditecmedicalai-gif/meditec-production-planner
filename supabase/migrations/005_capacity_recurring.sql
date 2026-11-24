-- =====================================================================
-- 005 — Test capacity, "Any / mixed pump" repairs, recurring jobs
-- Run in Supabase → SQL Editor AFTER 004. Safe to run again: seeds only
-- fill in what is missing and never overwrite your Settings.
-- The last result table tells you whether live updates are fully on.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Test areas, limit groups and task / model settings
-- ---------------------------------------------------------------------
create table if not exists public.test_areas (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique check (length(trim(name)) > 0),
  max_pumps   integer not null check (max_pumps between 1 and 99),
  notes       text,
  active      boolean not null default true,
  sort_order  integer not null default 100,
  created_at  timestamptz not null default now()
);

-- Tasks that run on the SAME pumps at the same time in an area (e.g. calibration
-- and quality testing on Medicare / Mediflex) — they count once, not twice.
create table if not exists public.test_area_shared_tasks (
  test_area_id uuid not null references public.test_areas (id) on delete cascade,
  task_id      uuid not null references public.tasks (id) on delete cascade,
  primary key (test_area_id, task_id)
);

-- A limit inside an area for one model or a group of models ("MediAir + Simplex: 6").
create table if not exists public.test_limits (
  id           uuid primary key default gen_random_uuid(),
  test_area_id uuid not null references public.test_areas (id) on delete cascade,
  name         text not null check (length(trim(name)) > 0),
  max_pumps    integer not null check (max_pumps between 1 and 99),
  active       boolean not null default true,
  sort_order   integer not null default 100,
  created_at   timestamptz not null default now(),
  unique (test_area_id, name)
);
create table if not exists public.test_limit_models (
  test_limit_id uuid not null references public.test_limits (id) on delete cascade,
  pump_model_id uuid not null references public.pump_models (id) on delete cascade,
  primary key (test_limit_id, pump_model_id)
);

alter table public.pump_models add column if not exists test_area_id uuid references public.test_areas (id) on delete set null;
alter table public.tasks
  add column if not exists is_testing      boolean not null default false,  -- counts towards test capacity
  add column if not exists allows_any_pump boolean not null default false;  -- "Any / mixed pump" allowed (repairs)

-- Seeds -----------------------------------------------------------------
insert into public.tasks (name, requires_pump, counts_as_output, is_background, is_testing, sort_order)
values ('Quality testing', true, false, false, true, 36)
on conflict (name) do nothing;

-- Mark testing tasks / any-pump tasks once (only while nothing is marked yet).
update public.tasks set is_testing = true
where name in ('Functional test / calibration', 'Quality testing', 'Soak / burn-in test')
  and not exists (select 1 from public.tasks where is_testing and name <> 'Quality testing');
update public.tasks set allows_any_pump = true
where name = 'Repair' and not exists (select 1 from public.tasks where allows_any_pump);

insert into public.test_areas (name, max_pumps, sort_order, notes) values
  ('Main test area', 7, 10, 'Absolute max 7. Shared by QPro 2000, Simplex, MediAir, MediAir Turn, MATS and Bari-Med 1'),
  ('Medicare / Mediflex test area', 1, 20, 'Separate area, 1 pump at a time. Calibration + quality testing on the same pump count once')
on conflict (name) do nothing;

do $$
declare
  main_id uuid := (select id from public.test_areas where name = 'Main test area');
  mm_id   uuid := (select id from public.test_areas where name = 'Medicare / Mediflex test area');
  lim     uuid;
  g       record;
begin
  -- default test area per model (only where not set yet)
  update public.pump_models set test_area_id = mm_id
  where test_area_id is null and name in ('Medicare', 'Mediflex');
  update public.pump_models set test_area_id = main_id
  where test_area_id is null and name not in ('Medicare', 'Mediflex');

  -- calibration + quality testing share pumps in the Medicare / Mediflex area
  if mm_id is not null and not exists (select 1 from public.test_area_shared_tasks where test_area_id = mm_id) then
    insert into public.test_area_shared_tasks (test_area_id, task_id)
    select mm_id, id from public.tasks where name in ('Functional test / calibration', 'Quality testing');
  end if;

  -- limit groups in the main area
  if main_id is not null then
    for g in select * from (values
        ('QPro 2000', 7, 10, array['QPro 2000']),
        ('MediAir + Simplex', 6, 20, array['MediAir', 'Simplex']),
        ('MediAir Turn', 3, 30, array['MediAir Turn'])) as v(name, max_pumps, sort_order, models)
    loop
      insert into public.test_limits (test_area_id, name, max_pumps, sort_order)
      values (main_id, g.name, g.max_pumps, g.sort_order)
      on conflict (test_area_id, name) do nothing;
      select id into lim from public.test_limits where test_area_id = main_id and name = g.name;
      if not exists (select 1 from public.test_limit_models where test_limit_id = lim) then
        insert into public.test_limit_models (test_limit_id, pump_model_id)
        select lim, id from public.pump_models where name = any (g.models);
      end if;
    end loop;
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- 2. "Any / mixed pump" (repairs on any pump, e.g. rental returns)
-- ---------------------------------------------------------------------
alter table public.assignments
  add column if not exists any_pump boolean not null default false,
  add column if not exists pump_mix jsonb;   -- optional, when known: [{"pump_model_id": "...", "qty": 2}, ...]
alter table public.demand_notes add column if not exists any_pump boolean not null default false;

alter table public.assignments drop constraint if exists assignments_any_pump_xor_model;
alter table public.assignments add constraint assignments_any_pump_xor_model check (not (any_pump and pump_model_id is not null));
alter table public.assignments drop constraint if exists assignments_pump_mix_is_list;
alter table public.assignments add constraint assignments_pump_mix_is_list check (pump_mix is null or jsonb_typeof(pump_mix) = 'array');
alter table public.demand_notes drop constraint if exists demand_any_pump_xor_model;
alter table public.demand_notes add constraint demand_any_pump_xor_model check (not (any_pump and pump_model_id is not null));

-- Job rules (replaces the 002 version):
--  * a pump task needs a pump model — or "Any / mixed pump" if the task allows it
--  * "Any / mixed pump" only on tasks that allow it
--  * pump tasks get the default build type when none is given
create or replace function public.check_assignment()
returns trigger
language plpgsql
set search_path = ''
as $$
-- Job rules. The same function is defined in migrations 002 and 005 so that
-- re-running any migration, in any order, keeps the current rules.
-- Columns added by later migrations are read via jsonb so this also works
-- before they exist.
declare
  task     jsonb;
  any_pump boolean := coalesce((to_jsonb(new) ->> 'any_pump')::boolean, false);
begin
  select to_jsonb(t) into task from public.tasks t where t.id = new.task_id;
  if any_pump and not coalesce((task ->> 'allows_any_pump')::boolean, false) then
    raise exception '"Any / mixed pump" is only allowed for repair-type tasks' using errcode = '23514';
  end if;
  if coalesce((task ->> 'requires_pump')::boolean, false) then
    if new.pump_model_id is null and not any_pump then
      raise exception 'A pump model is required for this task' using errcode = '23502';
    end if;
    if new.build_type_id is null then
      select b.id into new.build_type_id from public.build_types b where b.is_default limit 1;
    end if;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- 3. Recurring jobs
-- ---------------------------------------------------------------------
create table if not exists public.recurring_jobs (
  id             uuid primary key default gen_random_uuid(),
  title          text,                                  -- e.g. "Rental repairs"
  person_id      uuid references public.people (id) on delete set null,  -- empty = not assigned yet
  task_id        uuid not null references public.tasks (id) on delete restrict,
  pump_model_id  uuid references public.pump_models (id) on delete restrict,
  any_pump       boolean not null default false,
  build_type_id  uuid references public.build_types (id) on delete restrict,
  qty_target     integer check (qty_target is null or qty_target >= 0),
  notes          text,
  start_time     time,
  end_time       time,
  background     boolean,
  equipment_id   uuid references public.equipment (id) on delete restrict,
  pattern        text not null check (pattern in ('workdays', 'daily', 'weekly', 'every_n_weeks')),
  weekdays       smallint[] not null default '{1,2,3,4,5}' check (weekdays <@ '{1,2,3,4,5,6,7}'::smallint[]),  -- ISO: 1 = Monday
  interval_weeks smallint not null default 1 check (interval_weeks between 1 and 12),
  start_date     date not null default current_date,
  end_date       date,                                  -- empty = no end (generated 12 weeks ahead, extended automatically)
  active         boolean not null default true,
  created_by     uuid default auth.uid() references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_by     uuid references auth.users (id) on delete set null,
  updated_at     timestamptz not null default now(),
  check (end_date is null or end_date >= start_date),
  check (end_time is null or start_time is not null),
  check (not (any_pump and pump_model_id is not null))
);

-- Dates removed with "this one only" — never generated again.
create table if not exists public.recurring_exceptions (
  recurring_id uuid not null references public.recurring_jobs (id) on delete cascade,
  skip_date    date not null,
  created_at   timestamptz not null default now(),
  primary key (recurring_id, skip_date)
);

alter table public.assignments
  add column if not exists recurring_id       uuid references public.recurring_jobs (id) on delete set null,
  add column if not exists recurring_date     date,                          -- the occurrence this job came from
  add column if not exists recurring_detached boolean not null default false; -- edited "this one only"
create unique index if not exists assignments_recurring_once
  on public.assignments (recurring_id, recurring_date) where recurring_id is not null;

/** Does a recurring pattern fall on date d? */
create or replace function public.recurring_matches(r public.recurring_jobs, d date)
returns boolean
language sql immutable
set search_path = ''
as $$
  select d >= r.start_date
     and (r.end_date is null or d <= r.end_date)
     and case r.pattern
           when 'daily'    then true
           when 'workdays' then extract(isodow from d) <= 5
           else extract(isodow from d)::smallint = any (r.weekdays)
                and ((d - date_trunc('week', r.start_date)::date) / 7) % greatest(r.interval_weeks, 1) = 0
         end;
$$;

-- Creates the jobs for assigned recurring templates from today up to p_until
-- (default 12 weeks ahead). Skips days the person is absent and dates removed
-- with "this one only". Runs with the caller's rights, so only an admin can
-- create jobs (RLS); for anyone else it does nothing.
create or replace function public.extend_recurring_jobs(p_until date default null)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  until_d date := coalesce(p_until, current_date + 84);
  r public.recurring_jobs;
  d date;
  added integer := 0;
  c integer;
begin
  if not public.is_admin() then
    return 0;
  end if;
  for r in select * from public.recurring_jobs where active and person_id is not null loop
    d := greatest(r.start_date, current_date);
    while d <= least(until_d, coalesce(r.end_date, until_d)) loop
      if public.recurring_matches(r, d)
         and not exists (select 1 from public.recurring_exceptions e where e.recurring_id = r.id and e.skip_date = d)
         and not exists (select 1 from public.absences a where a.person_id = r.person_id and d between a.start_date and a.end_date)
      then
        insert into public.assignments (person_id, work_date, task_id, pump_model_id, any_pump, build_type_id, qty_target, notes,
                                        start_time, end_time, background, equipment_id, recurring_id, recurring_date)
        values (r.person_id, d, r.task_id, r.pump_model_id, r.any_pump, r.build_type_id, r.qty_target, r.notes,
                r.start_time, r.end_time, r.background, r.equipment_id, r.id, d)
        on conflict (recurring_id, recurring_date) where recurring_id is not null do nothing;
        get diagnostics c = row_count;
        added := added + c;
      end if;
      d := d + 1;
    end loop;
  end loop;
  return added;
end;
$$;

-- Seed: rental repairs every working day, any pump, Rental, not assigned yet.
-- No times: you set them yourself when assigning it (🔁 Recurring jobs panel).
insert into public.recurring_jobs (title, task_id, any_pump, build_type_id, pattern, weekdays, start_date, notes)
select 'Rental repairs',
       (select id from public.tasks where name = 'Repair'),
       true,
       (select id from public.build_types where name = 'Rental'),
       'workdays', '{1,2,3,4,5}', current_date,
       'Rental returns — any pump. Assign a person and set the times to start.'
where not exists (select 1 from public.recurring_jobs where title = 'Rental repairs')
  and exists (select 1 from public.tasks where name = 'Repair');

-- ---------------------------------------------------------------------
-- 4. Change log: works for tables without an "id" column too
-- ---------------------------------------------------------------------
create or replace function public.write_audit_log()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
-- Same function in migrations 001 and 005 (re-running either keeps it current).
-- Works for tables with or without an "id" column.
declare
  o jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  n jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
begin
  insert into public.audit_log (table_name, record_id, action, old_data, new_data, changed_by)
  values (tg_table_name, nullif(coalesce(n, o) ->> 'id', '')::uuid, lower(tg_op), o, n, auth.uid());
  return coalesce(new, old);
end;
$$;
revoke all on function public.write_audit_log() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 5. Security: RLS, policies, stamps, audit, grants
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['test_areas', 'test_area_shared_tasks', 'test_limits', 'test_limit_models',
                           'recurring_jobs', 'recurring_exceptions']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "%1$s: members read" on public.%1$I', t);
    execute format('drop policy if exists "%1$s: admin insert" on public.%1$I', t);
    execute format('drop policy if exists "%1$s: admin update" on public.%1$I', t);
    execute format('drop policy if exists "%1$s: admin delete" on public.%1$I', t);
    execute format('create policy "%1$s: members read" on public.%1$I for select to authenticated using (public.is_member())', t);
    execute format('create policy "%1$s: admin insert" on public.%1$I for insert to authenticated with check (public.is_admin())', t);
    execute format('create policy "%1$s: admin update" on public.%1$I for update to authenticated using (public.is_admin()) with check (public.is_admin())', t);
    execute format('create policy "%1$s: admin delete" on public.%1$I for delete to authenticated using (public.is_admin())', t);
    execute format('drop trigger if exists audit on public.%I', t);
    execute format('create trigger audit after insert or update or delete on public.%I for each row execute function public.write_audit_log()', t);
  end loop;
end;
$$;

drop trigger if exists stamp on public.recurring_jobs;
create trigger stamp before insert or update on public.recurring_jobs
  for each row execute function public.stamp_row();

grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant execute on all functions in schema public to authenticated;
revoke all on all tables in schema public from anon;
revoke insert, update, delete, truncate on public.audit_log from authenticated;
revoke all on function public.extend_recurring_jobs(date) from public, anon;
grant execute on function public.extend_recurring_jobs(date) to authenticated;

-- ---------------------------------------------------------------------
-- 6. Live updates for old + new tables (also repairs a failed 004)
-- ---------------------------------------------------------------------
do $$
declare
  t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      create publication supabase_realtime;
    exception when insufficient_privilege then
      return;  -- reported below
    end;
  end if;
  if (select puballtables from pg_publication where pubname = 'supabase_realtime') then
    return;
  end if;
  foreach t in array array['assignments', 'absences', 'demand_notes', 'people', 'person_skills', 'pump_models', 'tasks',
                           'build_types', 'equipment', 'app_settings', 'test_areas', 'test_area_shared_tasks',
                           'test_limits', 'test_limit_models', 'recurring_jobs', 'recurring_exceptions']
  loop
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      begin
        execute format('alter publication supabase_realtime add table public.%I', t);
      exception when insufficient_privilege or object_not_in_prerequisite_state then
        null;  -- not allowed from the SQL Editor in this project: reported below
      end;
    end if;
  end loop;
end;
$$;

select 'Migration 005 applied' as result,
       (select count(*) from public.test_areas) as test_areas,
       (select count(*) from public.test_limits) as limit_groups,
       (select count(*) from public.recurring_jobs) as recurring_jobs,
       coalesce(
         (select 'ACTION NEEDED: turn on live updates for: ' || string_agg(t, ', ' order by t)
                 || ' — Supabase Dashboard → Database → Publications → supabase_realtime (see README)'
          from unnest(array['assignments', 'absences', 'demand_notes', 'people', 'person_skills', 'pump_models', 'tasks',
                            'build_types', 'equipment', 'app_settings', 'test_areas', 'test_area_shared_tasks',
                            'test_limits', 'test_limit_models', 'recurring_jobs', 'recurring_exceptions']) as t
          where not coalesce((select puballtables from pg_publication where pubname = 'supabase_realtime'), false)
            and not exists (select 1 from pg_publication_tables p
                            where p.pubname = 'supabase_realtime' and p.schemaname = 'public' and p.tablename = t)
          having count(*) > 0),
         'Live updates: OK') as live_updates;
