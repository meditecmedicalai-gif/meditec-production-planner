-- =====================================================================
-- 002 — Build types (Production / Trial / Rental / Customer)
-- Run in Supabase → SQL Editor AFTER 001_init.sql. Safe to run again.
--
-- * New reference table build_types (admin-editable, colour per type).
-- * assignments.build_type_id  — required when the task needs a pump;
--                                 defaults to the default type (Production).
-- * demand_notes.build_type_id — optional.
-- * Retires pump_models.is_trial: work/demand already recorded against a
--   "trial" pump model is re-tagged with the Trial build type, then the
--   column is dropped. The models themselves are kept (see the result
--   table printed at the end).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Table
-- ---------------------------------------------------------------------
create table if not exists public.build_types (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique check (length(trim(name)) > 0),
  color       text not null default '#64748b' check (color ~ '^#[0-9a-fA-F]{6}$'),
  is_default  boolean not null default false,
  active      boolean not null default true,
  sort_order  integer not null default 100,
  created_at  timestamptz not null default now()
);
-- At most one default type.
create unique index if not exists build_types_one_default
  on public.build_types (is_default) where is_default;

insert into public.build_types (name, color, is_default, sort_order) values
  ('Production', '#475569', true,  10),
  ('Trial',      '#b45309', false, 20),
  ('Rental',     '#7c3aed', false, 30),
  ('Customer',   '#0369a1', false, 40)
on conflict (name) do nothing;

-- Make sure a default exists even if Production was renamed/removed.
update public.build_types set is_default = true
where id = (select id from public.build_types where active order by sort_order, name limit 1)
  and not exists (select 1 from public.build_types where is_default);

-- ---------------------------------------------------------------------
-- 2. New columns
-- ---------------------------------------------------------------------
alter table public.assignments
  add column if not exists build_type_id uuid references public.build_types (id) on delete restrict;
alter table public.demand_notes
  add column if not exists build_type_id uuid references public.build_types (id) on delete restrict;

-- ---------------------------------------------------------------------
-- 3. Retire pump_models.is_trial
-- ---------------------------------------------------------------------
drop table if exists pg_temp._trial_migration;
create temp table _trial_migration (pump_model text, assignments_retagged int, demand_retagged int);

do $$
declare
  trial_id uuid;
  prod_id  uuid;
  m record;
  a int; d int;
begin
  select id into trial_id from public.build_types where name = 'Trial';
  select id into prod_id  from public.build_types where is_default;

  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'pump_models' and column_name = 'is_trial') then
    for m in execute 'select id, name from public.pump_models where is_trial' loop
      update public.assignments  set build_type_id = trial_id where pump_model_id = m.id and build_type_id is null;
      get diagnostics a = row_count;
      update public.demand_notes set build_type_id = trial_id where pump_model_id = m.id and build_type_id is null;
      get diagnostics d = row_count;
      insert into _trial_migration values (m.name, a, d);
    end loop;
    alter table public.pump_models drop column is_trial;
  end if;

  -- Everything else that needs a type becomes Production.
  update public.assignments a2 set build_type_id = prod_id
  from public.tasks t
  where t.id = a2.task_id and t.requires_pump and a2.build_type_id is null;
end;
$$;

-- ---------------------------------------------------------------------
-- 4. Assignment rules (enforced in the database, not just the app)
--    * task requires a pump  -> pump model required, build type
--      defaults to the default type when not given
--    * task without a pump   -> pump model / build type optional
-- ---------------------------------------------------------------------
create or replace function public.check_assignment()
returns trigger
language plpgsql
set search_path = ''
as $$
-- Job rules. The same function is defined in migrations 002, 005 and 014 so that
-- re-running any migration, in any order, keeps the current rules.
-- Columns added by later migrations are read via jsonb so this also works
-- before they exist.
declare
  task     jsonb;
  any_pump boolean := coalesce((to_jsonb(new) ->> 'any_pump')::boolean, false);
  mix      jsonb := to_jsonb(new) -> 'pump_mix';
  e        jsonb;
  q        numeric;
  mid      text;
  total    int := 0;
  seen     text[] := '{}';
  unknowns int := 0;
begin
  select to_jsonb(t) into task from public.tasks t where t.id = new.task_id;
  -- Mixed pumps (several pump models on one job) only on tasks with "Allows mixed pumps"
  if any_pump and not coalesce((task ->> 'allows_any_pump')::boolean, false) then
    raise exception '"%" doesn''t allow mixed pumps (Settings → Tasks → Allows mixed pumps)', coalesce(task ->> 'name', 'This task')
      using errcode = '23514';
  end if;
  -- The pumps per model: [{ "pump_model_id": "…" or null (= Any / unknown), "qty": n }]; quantity = the sum
  if mix is not null and jsonb_typeof(mix) = 'array' and jsonb_array_length(mix) > 0 then
    if not any_pump then
      raise exception 'A list of pumps per model is only for jobs with mixed pumps' using errcode = '23514';
    end if;
    for e in select value from jsonb_array_elements(mix) loop
      if jsonb_typeof(e) <> 'object' or jsonb_typeof(e -> 'qty') is distinct from 'number' then
        raise exception 'Each pump model in the list needs a quantity' using errcode = '23514';
      end if;
      q := (e ->> 'qty')::numeric;
      if q <= 0 or q <> trunc(q) then
        raise exception 'Pump quantities must be whole numbers above 0' using errcode = '23514';
      end if;
      mid := nullif(e ->> 'pump_model_id', '');
      if mid is null then
        unknowns := unknowns + 1;
      else
        if not exists (select 1 from public.pump_models m where m.id::text = mid) then
          raise exception 'Unknown pump model in the list of pumps' using errcode = '23503';
        end if;
        if mid = any (seen) then
          raise exception 'A pump model is listed twice — give it one quantity' using errcode = '23514';
        end if;
        seen := seen || mid;
      end if;
      total := total + q::int;
    end loop;
    if unknowns > 1 then
      raise exception 'List "Any / unknown" once' using errcode = '23514';
    end if;
    new.qty_target := total;
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

drop trigger if exists check_assignment on public.assignments;
create trigger check_assignment before insert or update on public.assignments
  for each row execute function public.check_assignment();

-- ---------------------------------------------------------------------
-- 5. Security: RLS, policies, grants, audit
-- ---------------------------------------------------------------------
alter table public.build_types enable row level security;

drop policy if exists "build_types: members read"  on public.build_types;
drop policy if exists "build_types: admin insert"  on public.build_types;
drop policy if exists "build_types: admin update"  on public.build_types;
drop policy if exists "build_types: admin delete"  on public.build_types;
create policy "build_types: members read" on public.build_types
  for select to authenticated using (public.is_member());
create policy "build_types: admin insert" on public.build_types
  for insert to authenticated with check (public.is_admin());
create policy "build_types: admin update" on public.build_types
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "build_types: admin delete" on public.build_types
  for delete to authenticated using (public.is_admin());

drop trigger if exists audit on public.build_types;
create trigger audit after insert or update or delete on public.build_types
  for each row execute function public.write_audit_log();

-- Grants (repeat in every migration; see README "Updating the database").
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant execute on all functions in schema public to authenticated;
revoke all on all tables in schema public from anon;
revoke insert, update, delete, truncate on public.audit_log from authenticated;

-- ---------------------------------------------------------------------
-- 6. Report what happened to former trial models
-- ---------------------------------------------------------------------
select coalesce(pump_model, '(no pump models were flagged as trial)') as former_trial_model,
       coalesce(assignments_retagged, 0) as assignments_set_to_trial,
       coalesce(demand_retagged, 0)      as demand_notes_set_to_trial
from (select 1) x left join _trial_migration on true;
