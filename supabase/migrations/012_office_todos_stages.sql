-- =====================================================================
-- 012 — Office work, to-dos, production stages, completed units,
--        manual planned quantities
-- Run in Supabase → SQL Editor AFTER 011. Safe to run again: the one-off
-- set-up (section 7) only happens the first time.
--
--  1. tasks.category — 'production' (default) or 'office'. Office tasks:
--     Documentation, Odoo / ERP, Meetings, Admin / Email. Tasks you already
--     have with similar names (any capitalisation) are re-used — only their
--     category is set — and missing ones are added.
--  2. todos (+ assignments.todo_id) — to-dos in Demand & Notes; "Schedule
--     this" links office time blocks to a to-do.
--  3. pump_model_stages — production stages per pump model, in order. The
--     LAST stage counts as "planned / complete" for demand.
--  4. assignments.qty_done — units done on a job (admin).
--     demand_progress — "+ Log completed" on a demand note (admin).
--  5. demand_stage_plans — "Planned (manual)" per stage on a note (admin).
--  6. Notes whose status was set to "Planned" by hand go back to automatic
--     (hand-set "Done" is kept). See supabase/tests/report_012.sql for
--     how many notes changed.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Task category
-- ---------------------------------------------------------------------
alter table public.tasks add column if not exists category text not null default 'production';
alter table public.tasks drop constraint if exists tasks_category_check;
alter table public.tasks add constraint tasks_category_check check (category in ('production', 'office'));

-- ---------------------------------------------------------------------
-- 2. To-dos
-- ---------------------------------------------------------------------
create table if not exists public.todos (
  id          uuid primary key default gen_random_uuid(),
  title       text not null check (length(trim(title)) > 0),
  details     text,
  due_date    date,
  priority    text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  owner_id    uuid default auth.uid() references auth.users (id) on delete set null,   -- whose to-do (a login)
  status      text not null default 'todo' check (status in ('todo', 'in_progress', 'done')),
  checklist   jsonb not null default '[]'::jsonb,                                       -- [{ "text": "…", "done": false }]
  created_by  uuid default auth.uid() references auth.users (id) on delete set null,
  updated_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists todos_owner_idx on public.todos (owner_id, status);

alter table public.assignments add column if not exists todo_id uuid references public.todos (id) on delete set null;
create index if not exists assignments_todo_idx on public.assignments (todo_id) where todo_id is not null;

-- ---------------------------------------------------------------------
-- 3. Production stages per pump model
-- ---------------------------------------------------------------------
create table if not exists public.pump_model_stages (
  pump_model_id uuid not null references public.pump_models (id) on delete cascade,
  task_id       uuid not null references public.tasks (id) on delete cascade,
  position      smallint not null default 1,
  primary key (pump_model_id, task_id)
);

-- ---------------------------------------------------------------------
-- 4. Completed units
-- ---------------------------------------------------------------------
alter table public.assignments add column if not exists qty_done integer;
alter table public.assignments drop constraint if exists assignments_qty_done_check;
alter table public.assignments add constraint assignments_qty_done_check check (qty_done is null or qty_done >= 0);

create table if not exists public.demand_progress (
  id          uuid primary key default gen_random_uuid(),
  demand_id   uuid not null references public.demand_notes (id) on delete cascade,
  task_id     uuid references public.tasks (id) on delete set null,      -- the stage (empty = the last stage)
  qty         integer not null check (qty > 0),
  work_date   date not null default current_date,
  note        text,
  created_by  uuid default auth.uid() references auth.users (id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists demand_progress_demand_idx on public.demand_progress (demand_id);

-- ---------------------------------------------------------------------
-- 5. Manual planned quantity per stage
-- ---------------------------------------------------------------------
create table if not exists public.demand_stage_plans (
  demand_id   uuid not null references public.demand_notes (id) on delete cascade,
  task_id     uuid not null references public.tasks (id) on delete cascade,
  qty         integer not null check (qty >= 0),
  updated_by  uuid default auth.uid() references auth.users (id) on delete set null,
  updated_at  timestamptz not null default now(),
  primary key (demand_id, task_id)
);

-- ---------------------------------------------------------------------
-- 6. Security: everyone signed in reads; admin writes (to-dos: see below)
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['pump_model_stages', 'demand_progress', 'demand_stage_plans']
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
  end loop;
  foreach t in array array['todos', 'pump_model_stages', 'demand_progress', 'demand_stage_plans']
  loop
    execute format('drop trigger if exists audit on public.%I', t);
    execute format('create trigger audit after insert or update or delete on public.%I for each row execute function public.write_audit_log()', t);
  end loop;
end;
$$;

-- To-dos: everyone reads; anyone adds (for themselves or someone else) in their own name;
-- the admin, whoever added it and its owner can edit; only the admin deletes.
alter table public.todos enable row level security;
drop policy if exists "todos: members read" on public.todos;
drop policy if exists "todos: members insert" on public.todos;
drop policy if exists "todos: update" on public.todos;
drop policy if exists "todos: admin delete" on public.todos;
create policy "todos: members read" on public.todos for select to authenticated using (public.is_member());
create policy "todos: members insert" on public.todos for insert to authenticated
  with check (public.is_member() and created_by = auth.uid());
create policy "todos: update" on public.todos for update to authenticated
  using (public.is_admin() or (public.is_member() and (created_by = auth.uid() or owner_id = auth.uid())))
  with check (public.is_admin() or (public.is_member() and (created_by = auth.uid() or owner_id = auth.uid())));
create policy "todos: admin delete" on public.todos for delete to authenticated using (public.is_admin());

create or replace function public.stamp_updated()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;
drop trigger if exists stamp on public.demand_stage_plans;
create trigger stamp before insert or update on public.demand_stage_plans
  for each row execute function public.stamp_updated();

drop trigger if exists stamp on public.todos;
create trigger stamp before insert or update on public.todos
  for each row execute function public.stamp_row();

-- ---------------------------------------------------------------------
-- 7. One-off set-up (first run only)
-- ---------------------------------------------------------------------
do $$
declare
  spec record;
  found uuid;
  pos int;
  m record;
begin
  if coalesce(obj_description('public.pump_model_stages'::regclass, 'pg_class'), '') = '012 set up' then
    return;  -- already done: never undo your later changes
  end if;

  -- Office tasks: re-use similar names (any capitalisation), else add
  for spec in
    select * from (values
      (1, 'Documentation', array['%document%']),
      (2, 'Odoo / ERP',    array['%odoo%', '%erp%']),
      (3, 'Meetings',      array['%meeting%']),
      (4, 'Admin / Email', array['admin%', '%admin /%', '%e-mail%', '%email%'])
    ) as v(n, name, pats)
  loop
    select t.id into found from public.tasks t
    where t.name ilike any (spec.pats) and not coalesce(t.is_testing, false) and not t.counts_as_output
    order by (lower(t.name) = lower(spec.name)) desc, t.sort_order limit 1;
    if found is not null then
      update public.tasks set category = 'office', requires_pump = false where id = found;
    else
      insert into public.tasks (name, requires_pump, counts_as_output, is_background, is_testing, allows_any_pump, category, sort_order)
      values (spec.name, false, false, false, false, false, 'office', 900 + spec.n)
      on conflict (name) do update set category = 'office', requires_pump = false;
    end if;
  end loop;

  -- Default stages for every pump model: Sub-assembly → Final assembly →
  -- Functional test / calibration → Quality testing (whichever of these tasks exist)
  for m in select id from public.pump_models loop
    if exists (select 1 from public.pump_model_stages s where s.pump_model_id = m.id) then continue; end if;
    pos := 0;
    for spec in
      select * from (values (1, '%sub%assembl%'), (2, '%final%assembl%'), (3, '%calibrat%'), (4, '%quality%')) as v(n, pat)
      order by n
    loop
      select t.id into found from public.tasks t
      where t.name ilike spec.pat and t.category = 'production' and t.active
      order by t.sort_order limit 1;
      if found is not null then
        pos := pos + 1;
        insert into public.pump_model_stages (pump_model_id, task_id, position) values (m.id, found, pos)
        on conflict do nothing;
      end if;
    end loop;
  end loop;

  -- "Planned" is now worked out from jobs + manual planned quantities: hand-set
  -- Planned (and Partly) go back to automatic. Hand-set Done is kept.
  update public.demand_notes set status_override = null where status_override in ('planned', 'partly');

  comment on table public.pump_model_stages is '012 set up';
end;
$$;

-- ---------------------------------------------------------------------
-- 8. Live updates for the new tables
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     or (select puballtables from pg_publication where pubname = 'supabase_realtime') then
    return;
  end if;
  foreach t in array array['todos', 'pump_model_stages', 'demand_progress', 'demand_stage_plans']
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

-- Tell the API (PostgREST) about the new tables and columns straight away.
notify pgrst, 'reload schema';
