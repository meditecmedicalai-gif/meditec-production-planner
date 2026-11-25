-- =====================================================================
-- 013 — Jobs over several days as ONE job; corrections to completed units
-- Run in Supabase → SQL Editor AFTER 012. Safe to run again.
--
--  1. assignments.work_minutes — a job's TOTAL work time, stored once on part 1.
--     assignments.part_locked  — a part whose times were set by hand ("Adjust this
--     part only" → lock), kept when the job re-flows.
--  2. app_settings.overflow_mode — "When a job runs past finish time":
--     'continue' (next working day, default) / 'ask' / 'overtime'.
--  3. One part per job per day: a guard that rejects a second part of the same job
--     on the same day (checked at the end of each save).
--  4. apply_job_parts(rows, remove) — saves all parts of a job in ONE step: updates
--     the existing parts, adds only what is missing, removes the rest. If anything
--     fails nothing is saved, so a job can't end up half-moved or with duplicates.
--  5. Units done count once per job: any "units done" recorded on parts 2, 3 …
--     move onto part 1 (the totals you saw are kept).
--  6. Completed units: corrections. A log entry may be negative ("−3, counted
--     twice"), kind = log / correction / adjust; entries can be edited (who and
--     when are stamped; the audit log keeps old → new). A stage's completed total
--     can't go below 0.
--
-- Existing duplicate / stray parts: see supabase/tests/report_013_parts.sql (report)
-- and supabase/tests/cleanup_013_parts.sql (optional clean-up, run after the report).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Total work time on part 1; locked parts
-- ---------------------------------------------------------------------
alter table public.assignments add column if not exists work_minutes integer;
alter table public.assignments drop constraint if exists assignments_work_minutes_check;
alter table public.assignments add constraint assignments_work_minutes_check check (work_minutes is null or work_minutes >= 0);
alter table public.assignments add column if not exists part_locked boolean not null default false;

-- ---------------------------------------------------------------------
-- 2. Planner setting: when a job runs past the person's finish time
-- ---------------------------------------------------------------------
alter table public.app_settings add column if not exists overflow_mode text not null default 'continue';
alter table public.app_settings drop constraint if exists app_settings_overflow_mode_check;
alter table public.app_settings add constraint app_settings_overflow_mode_check check (overflow_mode in ('continue', 'ask', 'overtime'));

-- ---------------------------------------------------------------------
-- 3. One part per job per day (and parts point at part 1, never at another part)
-- ---------------------------------------------------------------------
create index if not exists assignments_series_day_idx on public.assignments ((coalesce(part_of, id)), work_date);

create or replace function public.check_job_parts()
returns trigger language plpgsql set search_path = '' as $$
declare
  k uuid := coalesce(new.part_of, new.id);
begin
  if not exists (select 1 from public.assignments where id = new.id) then return null; end if;  -- deleted since
  if new.part_of is not null and exists (select 1 from public.assignments h where h.id = new.part_of and h.part_of is not null) then
    raise exception 'A continued part must point at part 1 of its job.' using errcode = '23514';
  end if;
  if exists (select 1 from public.assignments a
             where coalesce(a.part_of, a.id) = k and a.work_date = new.work_date and a.id <> new.id) then
    raise exception 'This job already has a part on % — a job has at most one part per day.', to_char(new.work_date, 'Dy DD Mon')
      using errcode = '23505';
  end if;
  return null;
end;
$$;
drop trigger if exists one_part_per_day on public.assignments;
create constraint trigger one_part_per_day
  after insert or update of work_date, part_of on public.assignments
  deferrable initially deferred
  for each row when (new.part_of is not null or new.work_minutes is not null)
  execute function public.check_job_parts();

-- ---------------------------------------------------------------------
-- 4. Save all parts of a job in one step
--    p_rows:   [{ id?, …fields }] in date order; the first is part 1. Rows with an id are
--              updated (fields not sent keep their value); rows without an id are added.
--    p_remove: ids of parts to delete (after the others are saved).
--    → the id of part 1. Runs with the caller's rights: only the admin can change jobs (RLS).
-- ---------------------------------------------------------------------
create or replace function public.apply_job_parts(p_rows jsonb, p_remove uuid[] default '{}')
returns uuid language plpgsql security invoker set search_path = '' as $$
declare
  r jsonb;
  i int;
  rec public.assignments;
  v_head uuid;
  v_id uuid;
  n int;
begin
  if not public.is_admin() then
    raise exception 'Only the admin can change the plan.' using errcode = '42501';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'No parts to save.' using errcode = '22023';
  end if;
  for r, i in select e.value, e.ord from jsonb_array_elements(p_rows) with ordinality as e(value, ord) order by e.ord
  loop
    v_id := nullif(r ->> 'id', '')::uuid;
    if v_id is not null then
      select * into rec from public.assignments where id = v_id for update;
      if not found then raise exception 'Part % no longer exists — reload and try again.', v_id using errcode = '40001'; end if;
      rec := jsonb_populate_record(rec, r - 'id' - 'part_of' - 'created_at' - 'created_by');
    else
      rec := jsonb_populate_record(null::public.assignments, r - 'id' - 'part_of');
      rec.id := gen_random_uuid();
      rec.created_at := now();
      rec.updated_at := now();
      rec.created_by := auth.uid();
      rec.any_pump := coalesce(rec.any_pump, false);
      rec.pause_for_breaks := coalesce(rec.pause_for_breaks, true);
      rec.recurring_detached := coalesce(rec.recurring_detached, false);
      rec.part_locked := coalesce(rec.part_locked, false);
    end if;
    if i = 1 then
      rec.part_of := null;
      v_head := rec.id;
    else
      rec.part_of := v_head;
      rec.work_minutes := null;   -- the total lives on part 1
      rec.qty_done := null;       -- units done count once, on part 1
      if v_id is null then rec.recurring_id := null; rec.recurring_date := null; end if;
    end if;
    rec.end_date := null;         -- parts are one day each
    if v_id is not null then
      update public.assignments set
        person_id = rec.person_id, work_date = rec.work_date, pump_model_id = rec.pump_model_id, task_id = rec.task_id,
        qty_target = rec.qty_target, notes = rec.notes, build_type_id = rec.build_type_id, background = rec.background,
        start_time = rec.start_time, end_time = rec.end_time, end_date = rec.end_date, equipment_id = rec.equipment_id,
        any_pump = rec.any_pump, pump_mix = rec.pump_mix, pause_for_breaks = rec.pause_for_breaks, part_of = rec.part_of,
        demand_id = rec.demand_id, todo_id = rec.todo_id, qty_done = rec.qty_done,
        work_minutes = rec.work_minutes, part_locked = rec.part_locked
      where id = rec.id;
    else
      insert into public.assignments select rec.*;
    end if;
  end loop;
  -- parts no longer needed (after re-pointing the others, so nothing else is deleted with them)
  if coalesce(array_length(p_remove, 1), 0) > 0 then
    delete from public.assignments where id = any (p_remove) and id <> v_head;
  end if;
  -- the last check: never two parts of this job on one day
  select count(*) - count(distinct work_date) into n from public.assignments where coalesce(part_of, id) = v_head;
  if n > 0 then
    raise exception 'This job would have two parts on the same day — nothing was saved.' using errcode = '23505';
  end if;
  return v_head;
end;
$$;

-- ---------------------------------------------------------------------
-- 5. Units done count once per job: move them from parts 2, 3 … onto part 1
-- ---------------------------------------------------------------------
with moved as (
  select p.part_of as head, sum(p.qty_done) as qty
  from public.assignments p
  where p.part_of is not null and p.qty_done is not null
  group by p.part_of
)
update public.assignments h set qty_done = coalesce(h.qty_done, 0) + m.qty
from moved m where h.id = m.head;
update public.assignments set qty_done = null where part_of is not null and qty_done is not null;

-- ---------------------------------------------------------------------
-- 6. Completed units: corrections
-- ---------------------------------------------------------------------
alter table public.demand_progress drop constraint if exists demand_progress_qty_check;
alter table public.demand_progress drop constraint if exists demand_progress_qty_not_zero;
alter table public.demand_progress add constraint demand_progress_qty_not_zero check (qty <> 0);
alter table public.demand_progress add column if not exists kind text not null default 'log';
alter table public.demand_progress drop constraint if exists demand_progress_kind_check;
alter table public.demand_progress add constraint demand_progress_kind_check check (kind in ('log', 'correction', 'adjust'));
alter table public.demand_progress add column if not exists updated_by uuid references auth.users (id) on delete set null;
alter table public.demand_progress add column if not exists updated_at timestamptz not null default now();

create or replace function public.stamp_progress()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  if tg_op = 'UPDATE' then new.created_by := old.created_by; new.created_at := old.created_at; end if;
  return new;
end;
$$;
drop trigger if exists stamp on public.demand_progress;
create trigger stamp before insert or update on public.demand_progress
  for each row execute function public.stamp_progress();

-- The stage an entry without a stage counts at: the pump model's last stage,
-- else the "counts as output" task (as the app does).
create or replace function public.demand_last_stage(p_demand uuid)
returns uuid language sql stable set search_path = '' as $$
  select coalesce(
    (select s.task_id from public.pump_model_stages s join public.demand_notes n on n.pump_model_id = s.pump_model_id
      where n.id = p_demand and not coalesce(n.any_pump, false) order by s.position desc limit 1),
    (select t.id from public.tasks t where t.counts_as_output order by t.sort_order desc limit 1));
$$;

-- Completed at one stage of a note: units done on linked jobs (part 1) + logged entries.
create or replace function public.demand_stage_done(p_demand uuid, p_task uuid)
returns integer language sql stable set search_path = '' as $$
  select coalesce((select sum(p.qty) from public.demand_progress p
                   where p.demand_id = p_demand and coalesce(p.task_id, public.demand_last_stage(p_demand)) = p_task), 0)::int
       + coalesce((select sum(a.qty_done) from public.assignments a
                   where a.demand_id = p_demand and a.part_of is null and a.task_id = p_task), 0)::int;
$$;

create or replace function public.check_progress_not_negative()
returns trigger language plpgsql set search_path = '' as $$
declare
  d uuid; t uuid; done int;
begin
  for d, t in
    select x.demand_id, coalesce(x.task_id, public.demand_last_stage(x.demand_id))
    from (select new.demand_id, new.task_id where tg_op <> 'DELETE'
          union all select old.demand_id, old.task_id where tg_op <> 'INSERT') x
  loop
    if not exists (select 1 from public.demand_notes where id = d) then continue; end if;  -- note deleted
    done := public.demand_stage_done(d, t);
    if done < 0 then
      raise exception 'Completed can''t go below 0 (% would have %).', coalesce((select name from public.tasks where id = t), 'this stage'), done
        using errcode = '23514';
    end if;
  end loop;
  return null;
end;
$$;
drop trigger if exists not_below_zero on public.demand_progress;
create constraint trigger not_below_zero
  after insert or update or delete on public.demand_progress
  deferrable initially deferred
  for each row execute function public.check_progress_not_negative();

-- Grants (repeat in every migration; see README "Updating the database").
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant execute on all functions in schema public to authenticated;
revoke all on all tables in schema public from anon;
revoke execute on function public.apply_job_parts(jsonb, uuid[]) from anon, public;
grant execute on function public.apply_job_parts(jsonb, uuid[]) to authenticated;
revoke insert, update, delete, truncate on public.audit_log from authenticated;

-- Tell the API (PostgREST) about the new columns and function straight away.
notify pgrst, 'reload schema';
