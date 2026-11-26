-- =====================================================================
-- 014 — Mixed pumps on a job (e.g. Rework: QPro 2000 × 3, MediAir × 2, Mediflex × 1)
-- Run in Supabase → SQL Editor AFTER 013. Safe to run again.
--
--  1. The task setting "Allows mixed pumps" (tasks.allows_any_pump) replaces the
--     hard-coded "repair only" rule. First run only: ON for tasks named like Repair
--     or Rework (any capitalisation), and for tasks that already have mixed-pump jobs
--     (so nothing existing breaks); OFF for every other task. Change it later in
--     Settings → Tasks.
--  2. The job rule (check_assignment): mixed pumps only on tasks with the setting; the
--     list of pumps per model (assignments.pump_mix) is checked — whole quantities
--     above 0, real pump models, each model once, "Any / unknown" (no model) at most
--     once — and the job's quantity is set to the sum.
--  3. Existing mixed jobs whose quantity was more than the pumps listed: the rest is
--     added as "Any / unknown", so totals stay the same.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. "Allows mixed pumps" (first run only)
-- ---------------------------------------------------------------------
do $$
declare
  col_note text := col_description('public.tasks'::regclass,
    (select attnum from pg_attribute where attrelid = 'public.tasks'::regclass and attname = 'allows_any_pump'));
begin
  if coalesce(col_note, '') like '014 set up%' then
    return;   -- already done: never undo later changes made in Settings
  end if;
  update public.tasks t set allows_any_pump =
    (t.name ilike any (array['%repair%', '%rework%']) and coalesce(to_jsonb(t) ->> 'category', 'production') <> 'office')
    or exists (select 1 from public.assignments a where a.task_id = t.id and a.any_pump)
    or exists (select 1 from public.recurring_jobs r where r.task_id = t.id and r.any_pump);
  comment on column public.tasks.allows_any_pump is '014 set up — "Allows mixed pumps" (several pump models on one job)';
end;
$$;

-- ---------------------------------------------------------------------
-- 2. Job rule (also defined in 002 and 005: kept identical)
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
-- 3. Existing mixed jobs: quantity beyond the pumps listed becomes "Any / unknown"
-- ---------------------------------------------------------------------
do $$
declare
  a record;
  listed int;
  rest int;
  has_unknown boolean;
begin
  for a in
    select id, qty_target, pump_mix from public.assignments
    where any_pump and jsonb_typeof(pump_mix) = 'array' and jsonb_array_length(pump_mix) > 0
  loop
    select coalesce(sum((x ->> 'qty')::numeric), 0)::int, bool_or(nullif(x ->> 'pump_model_id', '') is null)
      into listed, has_unknown
    from jsonb_array_elements(a.pump_mix) x where jsonb_typeof(x -> 'qty') = 'number' and (x ->> 'qty')::numeric > 0;
    rest := coalesce(a.qty_target, 0) - listed;
    if rest <= 0 then continue; end if;
    begin
    update public.assignments set pump_mix = case
        when has_unknown then (select jsonb_agg(case when nullif(x ->> 'pump_model_id', '') is null
                                                     then jsonb_set(x, '{qty}', to_jsonb((x ->> 'qty')::int + rest)) else x end)
                               from jsonb_array_elements(a.pump_mix) x)
        else a.pump_mix || jsonb_build_array(jsonb_build_object('pump_model_id', null, 'qty', rest)) end
    where id = a.id;
    exception when others then
      raise notice 'Job % left as it is (%): open it and save to fix its list of pumps', a.id, sqlerrm;
    end;
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

-- Tell the API (PostgREST) about the change straight away.
notify pgrst, 'reload schema';
