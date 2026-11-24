-- =====================================================================
-- 008 — Individual working hours + capacity mode
-- Run in Supabase → SQL Editor AFTER 007. Safe to run again; never
-- overwrites anything you changed yourself.
--
--  * work_patterns / work_pattern_days: named templates ("Standard
--    08:30–16:30", "Early 07:00–15:00"), different per weekday, with
--    non-working days. The current working hours become "Standard"
--    (the default pattern).
--  * person_work_patterns: which pattern a person works, from a date
--    ("effective from", so past weeks keep their hours), with optional
--    per-person overrides of start / end / break / lunch.
--  * person_day_hours: one-off changes for a single day ("leaving at
--    14:00 Thursday", "lunch at 13:30 today", "not working").
--  * people.user_id: links a person to a login (Today's shift bar shows
--    the signed-in person's own hours).
--  * test_areas.capacity_mode: 'simultaneous' (Quality Check) or
--    'sequential' (one at a time — Medicare / Mediflex bench).
--  * Recurring jobs skip a person's non-working days.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------
create table if not exists public.work_patterns (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique check (length(trim(name)) > 0),
  is_default  boolean not null default false,
  notes       text,
  active      boolean not null default true,
  sort_order  integer not null default 100,
  created_by  uuid references auth.users (id) on delete set null,
  updated_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index if not exists work_patterns_one_default on public.work_patterns ((true)) where is_default;

create table if not exists public.work_pattern_days (
  pattern_id     uuid not null references public.work_patterns (id) on delete cascade,
  weekday        smallint not null check (weekday between 1 and 7),   -- 1 = Monday … 7 = Sunday
  works          boolean not null default true,
  start_time     time,
  end_time       time,
  break_time     time,
  break_minutes  integer not null default 0 check (break_minutes between 0 and 240),
  lunch_time     time,
  lunch_minutes  integer not null default 0 check (lunch_minutes between 0 and 240),
  primary key (pattern_id, weekday),
  check (not works or (start_time is not null and end_time is not null and end_time > start_time))
);

create table if not exists public.person_work_patterns (
  id              uuid primary key default gen_random_uuid(),
  person_id       uuid not null references public.people (id) on delete cascade,
  pattern_id      uuid not null references public.work_patterns (id) on delete restrict,
  effective_from  date not null,
  -- optional overrides for this person (empty = use the pattern)
  start_time      time,
  end_time        time,
  break_time      time,
  break_minutes   integer check (break_minutes between 0 and 240),
  lunch_time      time,
  lunch_minutes   integer check (lunch_minutes between 0 and 240),
  notes           text,
  created_at      timestamptz not null default now(),
  unique (person_id, effective_from)
);
create index if not exists person_work_patterns_person_idx on public.person_work_patterns (person_id, effective_from);

create table if not exists public.person_day_hours (
  id             uuid primary key default gen_random_uuid(),
  person_id      uuid not null references public.people (id) on delete cascade,
  work_date      date not null,
  works          boolean not null default true,   -- false = not working that day
  start_time     time,
  end_time       time,
  break_time     time,
  break_minutes  integer check (break_minutes between 0 and 240),
  lunch_time     time,
  lunch_minutes  integer check (lunch_minutes between 0 and 240),
  notes          text,
  created_at     timestamptz not null default now(),
  unique (person_id, work_date)
);

alter table public.people add column if not exists user_id uuid references auth.users (id) on delete set null;
create unique index if not exists people_user_id_key on public.people (user_id) where user_id is not null;

-- Capacity mode: only set the Medicare / Mediflex area to "one at a time" the
-- first time this runs (when the column is new), so a later change is kept.
do $$
declare
  is_new boolean := not exists (select 1 from information_schema.columns
                                where table_schema = 'public' and table_name = 'test_areas' and column_name = 'capacity_mode');
begin
  alter table public.test_areas add column if not exists capacity_mode text not null default 'simultaneous'
    check (capacity_mode in ('simultaneous', 'sequential'));
  if is_new then
    update public.test_areas set capacity_mode = 'sequential' where name = 'Medicare / Mediflex test area';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- 2. Seed: "Standard" from the current working hours (Mon–Fri)
-- ---------------------------------------------------------------------
insert into public.work_patterns (name, is_default, notes, sort_order)
select 'Standard', true, 'Default working hours', 10
where not exists (select 1 from public.work_patterns);

insert into public.work_pattern_days (pattern_id, weekday, works, start_time, end_time, break_time, break_minutes, lunch_time, lunch_minutes)
select p.id, d, d <= 5,
       case when d <= 5 then s.work_start end, case when d <= 5 then s.work_end end,
       case when d <= 5 then s.break_time end, case when d <= 5 then s.break_minutes else 0 end,
       case when d <= 5 then s.lunch_time end, case when d <= 5 then s.lunch_minutes else 0 end
from public.work_patterns p
cross join generate_series(1, 7) as d
cross join (select * from public.app_settings where id = 1) s
where p.name = 'Standard'
  and not exists (select 1 from public.work_pattern_days x where x.pattern_id = p.id);

-- ---------------------------------------------------------------------
-- 3. Does a person work on a date? (one-off change → their pattern → default)
-- ---------------------------------------------------------------------
create or replace function public.person_works(p_person uuid, d date)
returns boolean
language sql stable
set search_path = ''
as $$
  select coalesce(
    (select dh.works from public.person_day_hours dh where dh.person_id = p_person and dh.work_date = d),
    (select pd.works
       from public.person_work_patterns pw
       join public.work_pattern_days pd on pd.pattern_id = pw.pattern_id and pd.weekday = extract(isodow from d)
      where pw.person_id = p_person and pw.effective_from <= d
      order by pw.effective_from desc limit 1),
    (select pd.works
       from public.work_patterns wp
       join public.work_pattern_days pd on pd.pattern_id = wp.id and pd.weekday = extract(isodow from d)
      where wp.is_default limit 1),
    extract(isodow from d) <= 5);
$$;

-- Recurring jobs: as in 005, and also skip the person's non-working days.
create or replace function public.extend_recurring_jobs(p_until date default null)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
-- Newer version of 005's generator (also skips non-working days: person_works).
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
         and public.person_works(r.person_id, d)
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

-- ---------------------------------------------------------------------
-- 4. Security: RLS (everyone signed in reads, admin writes), change log
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['work_patterns', 'work_pattern_days', 'person_work_patterns', 'person_day_hours']
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

drop trigger if exists stamp on public.work_patterns;
create trigger stamp before insert or update on public.work_patterns
  for each row execute function public.stamp_row();

-- ---------------------------------------------------------------------
-- 5. Live updates for the new tables
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     or (select puballtables from pg_publication where pubname = 'supabase_realtime') then
    return;
  end if;
  foreach t in array array['work_patterns', 'work_pattern_days', 'person_work_patterns', 'person_day_hours']
  loop
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      begin
        execute format('alter publication supabase_realtime add table public.%I', t);
      exception when insufficient_privilege or object_not_in_prerequisite_state then
        null;  -- not allowed from the SQL Editor: rls_check names the table; see README "Live updates"
      end;
    end if;
  end loop;
end;
$$;

-- Grants (repeat in every migration; see README "Updating the database").
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant execute on all functions in schema public to authenticated;
revoke all on all tables in schema public from anon;
revoke insert, update, delete, truncate on public.audit_log from authenticated;
revoke all on function public.extend_recurring_jobs(date) from public, anon;
grant execute on function public.extend_recurring_jobs(date) to authenticated;
revoke all on function public.person_works(uuid, date) from public, anon;
grant execute on function public.person_works(uuid, date) to authenticated;

select 'Migration 008 applied' as result,
       (select string_agg(p.name || case when p.is_default then ' (default)' else '' end, ' · ' order by p.sort_order) from public.work_patterns p) as work_patterns,
       (select string_agg(a.name || ': ' || a.capacity_mode, ' · ' order by a.sort_order) from public.test_areas a) as capacity_modes;

-- Tell the API (PostgREST) about the new tables and columns straight away.
notify pgrst, 'reload schema';
