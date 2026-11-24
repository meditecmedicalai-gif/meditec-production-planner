-- =====================================================================
-- RLS self-check — run in Supabase → SQL Editor after all migrations.
--
-- 1. Replace the two e-mail addresses on the next lines of the block.
-- 2. Click Run.
--
-- The whole check is ONE statement. At the end it deliberately stops
-- with an "error" whose message is the report:
--
--     RLS CHECK FINISHED: 75 passed, 0 failed ...
--
-- Raising that error is what undoes every bit of test data, so nothing
-- is left behind. Every line should start with PASS.
-- (One statement, no temp tables: works however the SQL Editor runs it.)
-- =====================================================================
do $rls$
declare
  viewer_email text := 'VIEWER_EMAIL_HERE';   -- <== Elaine's e-mail
  admin_email  text := 'ADMIN_EMAIL_HERE';    -- <== your e-mail

  viewer_id uuid;
  admin_id  uuid;
  res  text[] := '{}';     -- one line per check: "PASS  who  check"
  n    int;
  ok   boolean;
  note_id    uuid;
  other_note uuid;
  pid  uuid;
  t    record;
  passed int;
  failed int;
begin
  select id into viewer_id from auth.users where lower(email) = lower(viewer_email);
  select id into admin_id  from auth.users where lower(email) = lower(admin_email);

  -- ------------------------------------------------------ table settings
  -- Every table must have RLS on, and signed-in users need table
  -- privileges (otherwise the app shows "permission denied for table").
  for t in
    select c.relname, c.relrowsecurity,
           has_table_privilege('authenticated', c.oid, 'SELECT') as can_reach
    from pg_class c join pg_namespace s on s.oid = c.relnamespace
    where s.nspname = 'public' and c.relkind = 'r'
    order by c.relname
  loop
    res := res || format('%s  setup   RLS enabled: %s',
      case when t.relrowsecurity then 'PASS' else 'FAIL' end, t.relname);
    res := res || format('%s  setup   signed-in users can reach table: %s',
      case when t.can_reach then 'PASS' else 'FAIL' end, t.relname);
  end loop;

  res := res || format('%s  setup   pump_models.is_trial retired (002 migration run)',
    case when exists (select 1 from information_schema.columns
                      where table_schema = 'public' and table_name = 'pump_models' and column_name = 'is_trial')
         then 'FAIL' else 'PASS' end);
  res := res || format('%s  setup   exactly one default build type',
    case when (select count(*) from public.build_types where is_default) = 1 then 'PASS' else 'FAIL' end);
  res := res || format('%s  setup   equipment table and background-job columns exist (003 migration run)',
    case when exists (select 1 from information_schema.columns
                      where table_schema = 'public' and table_name = 'assignments' and column_name = 'equipment_id')
         then 'PASS' else 'FAIL' end);
  res := res || format('%s  setup   viewer e-mail found (%s)', case when viewer_id is null then 'FAIL' else 'PASS' end, viewer_email);
  res := res || format('%s  setup   admin e-mail found (%s)',  case when admin_id  is null then 'FAIL' else 'PASS' end, admin_email);

  -- A note "posted by the admin", so the viewer checks below always have
  -- someone else's note to try (and fail) to edit. Rolled back at the end.
  if admin_id is not null then
    insert into public.demand_notes (quantity, comment, created_by) values (1, 'RLS test: admin note', admin_id);
  end if;

  -- ------------------------------------------------------------- viewer
  if viewer_id is not null then
    perform set_config('request.jwt.claims', json_build_object('sub', viewer_id, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';

    select count(*) into n from public.profiles where id = auth.uid();
    res := res || format('%s  viewer  can read own profile', case when n = 1 then 'PASS' else 'FAIL' end);

    select count(*) into n from public.pump_models;
    res := res || format('%s  viewer  can read pump models', case when n > 0 then 'PASS' else 'FAIL' end);

    select count(*) into n from public.build_types;
    res := res || format('%s  viewer  can read build types', case when n > 0 then 'PASS' else 'FAIL' end);

    select count(*) into n from public.audit_log;
    res := res || format('%s  viewer  cannot read audit log', case when n = 0 then 'PASS' else 'FAIL' end);

    begin
      insert into public.people (name) values ('RLS test person');
      ok := false;
    exception when insufficient_privilege then ok := true;
    end;
    res := res || format('%s  viewer  cannot add people', case when ok then 'PASS' else 'FAIL' end);

    begin
      insert into public.assignments (person_id, work_date, task_id)
      select (select id from public.people limit 1), current_date, (select id from public.tasks limit 1);
      ok := false;
    exception when insufficient_privilege or not_null_violation then ok := true;
    end;
    res := res || format('%s  viewer  cannot add assignments', case when ok then 'PASS' else 'FAIL' end);

    begin
      insert into public.absences (person_id, start_date, end_date, absence_type)
      select id, current_date, current_date, 'holiday' from public.people limit 1;
      get diagnostics n = row_count;
      ok := n = 0;
    exception when insufficient_privilege then ok := true;
    end;
    res := res || format('%s  viewer  cannot add absences', case when ok then 'PASS' else 'FAIL' end);

    update public.pump_models set name = name || ' x';
    get diagnostics n = row_count;
    res := res || format('%s  viewer  cannot edit pump models', case when n = 0 then 'PASS' else 'FAIL' end);

    update public.people set name = name || ' x';
    get diagnostics n = row_count;
    res := res || format('%s  viewer  cannot edit people', case when n = 0 then 'PASS' else 'FAIL' end);

    begin
      insert into public.person_skills (person_id, pump_model_id)
      select p.id, m.id from public.people p cross join public.pump_models m limit 1;
      get diagnostics n = row_count;
      ok := n = 0;
    exception when insufficient_privilege then ok := true;
    end;
    res := res || format('%s  viewer  cannot change skills', case when ok then 'PASS' else 'FAIL' end);

    begin
      insert into public.build_types (name) values ('RLS test type');
      ok := false;
    exception when insufficient_privilege then ok := true;
    end;
    res := res || format('%s  viewer  cannot add build types', case when ok then 'PASS' else 'FAIL' end);

    update public.build_types set color = '#000000';
    get diagnostics n = row_count;
    res := res || format('%s  viewer  cannot edit build types', case when n = 0 then 'PASS' else 'FAIL' end);

    select count(*) into n from public.equipment;
    res := res || format('%s  viewer  can read equipment', case when n > 0 then 'PASS' else 'FAIL' end);

    begin
      insert into public.equipment (name) values ('RLS test rig');
      ok := false;
    exception when insufficient_privilege then ok := true;
    end;
    res := res || format('%s  viewer  cannot add equipment', case when ok then 'PASS' else 'FAIL' end);

    update public.equipment set notes = 'hacked';
    get diagnostics n = row_count;
    res := res || format('%s  viewer  cannot edit equipment', case when n = 0 then 'PASS' else 'FAIL' end);

    update public.tasks set is_background = not is_background;
    get diagnostics n = row_count;
    res := res || format('%s  viewer  cannot change task background flag', case when n = 0 then 'PASS' else 'FAIL' end);

    begin
      insert into public.tasks (name) values ('RLS test task');
      ok := false;
    exception when insufficient_privilege then ok := true;
    end;
    res := res || format('%s  viewer  cannot add tasks', case when ok then 'PASS' else 'FAIL' end);

    update public.profiles set app_role = 'admin' where id = auth.uid();
    get diagnostics n = row_count;
    res := res || format('%s  viewer  cannot promote self to admin', case when n = 0 then 'PASS' else 'FAIL' end);

    update public.app_settings set work_start = '06:00';
    get diagnostics n = row_count;
    res := res || format('%s  viewer  cannot edit working hours', case when n = 0 then 'PASS' else 'FAIL' end);

    -- Demand notes: create, edit own, mark done, no delete
    insert into public.demand_notes (quantity, comment, build_type_id, pump_model_id, needed_by, priority)
    values (10, 'RLS test note', (select id from public.build_types where name = 'Trial'),
            (select id from public.pump_models order by sort_order limit 1), current_date + 7, 'high')
    returning id into note_id;
    res := res || format('%s  viewer  can create demand note', case when note_id is not null then 'PASS' else 'FAIL' end);

    update public.demand_notes set comment = 'RLS test note (edited)', quantity = 12,
           build_type_id = (select id from public.build_types where is_default) where id = note_id;
    get diagnostics n = row_count;
    res := res || format('%s  viewer  can edit own note (comment, quantity, type)', case when n = 1 then 'PASS' else 'FAIL' end);

    update public.demand_notes set status = 'done' where id = note_id;
    get diagnostics n = row_count;
    res := res || format('%s  viewer  can mark own note done', case when n = 1 then 'PASS' else 'FAIL' end);

    delete from public.demand_notes where id = note_id;
    get diagnostics n = row_count;
    res := res || format('%s  viewer  cannot delete own note', case when n = 0 then 'PASS' else 'FAIL' end);

    begin
      insert into public.demand_notes (quantity, comment, created_by) values (1, 'RLS spoof', admin_id);
      ok := admin_id is null;  -- only meaningful when the admin exists
    exception when insufficient_privilege then ok := true;
    end;
    res := res || format('%s  viewer  cannot post a note in someone else''s name', case when ok then 'PASS' else 'FAIL' end);

    select id into other_note from public.demand_notes where created_by is distinct from auth.uid() limit 1;
    if other_note is null then
      res := res || 'FAIL  viewer  cannot edit others'' notes (no other note found to test with)'::text;
    else
      update public.demand_notes set comment = 'hacked' where id = other_note;
      get diagnostics n = row_count;
      res := res || format('%s  viewer  cannot edit others'' notes', case when n = 0 then 'PASS' else 'FAIL' end);
    end if;

    execute 'reset role';
  end if;

  -- -------------------------------------------------------------- admin
  if admin_id is not null then
    perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';

    if not public.is_admin() then
      res := res || 'FAIL  admin   user is admin (run the make-admin SQL from the README)'::text;
    else
      insert into public.people (name) values ('RLS test person') returning id into pid;
      res := res || format('%s  admin   can add people', case when pid is not null then 'PASS' else 'FAIL' end);

      insert into public.person_skills (person_id, pump_model_id)
      values (pid, (select id from public.pump_models order by sort_order limit 1));
      get diagnostics n = row_count;
      res := res || format('%s  admin   can set skills', case when n = 1 then 'PASS' else 'FAIL' end);

      update public.app_settings set lunch_minutes = lunch_minutes where id = 1;
      get diagnostics n = row_count;
      res := res || format('%s  admin   can edit working hours', case when n = 1 then 'PASS' else 'FAIL' end);

      insert into public.pump_models (name) values ('RLS test pump model');
      res := res || 'PASS  admin   can add pump models'::text;

      insert into public.assignments (person_id, work_date, task_id, qty_target)
      values (pid, current_date, (select id from public.tasks where name = 'Training'), 0);
      select count(*) into n from public.audit_log
      where table_name = 'assignments' and changed_by = auth.uid() and changed_at >= now();
      res := res || format('%s  admin   assignment change written to audit log', case when n >= 1 then 'PASS' else 'FAIL' end);

      insert into public.absences (person_id, start_date, end_date, absence_type) values (pid, current_date, current_date, 'sick');
      res := res || 'PASS  admin   can add absences'::text;

      insert into public.build_types (name, color) values ('RLS test type', '#123456');
      res := res || 'PASS  admin   can add build types'::text;
      select count(*) into n from public.audit_log where table_name = 'build_types' and changed_at >= now();
      res := res || format('%s  admin   build type change written to audit log', case when n >= 1 then 'PASS' else 'FAIL' end);

      insert into public.assignments (person_id, work_date, task_id, pump_model_id, qty_target)
      values (pid, current_date, (select id from public.tasks where requires_pump order by sort_order limit 1),
              (select id from public.pump_models order by sort_order limit 1), 5);
      select count(*) into n from public.assignments a join public.build_types b on b.id = a.build_type_id
      where a.person_id = pid and b.is_default;
      res := res || format('%s  admin   pump job without a type gets the default type', case when n = 1 then 'PASS' else 'FAIL' end);

      begin
        insert into public.assignments (person_id, work_date, task_id)
        values (pid, current_date, (select id from public.tasks where requires_pump order by sort_order limit 1));
        ok := false;
      exception when not_null_violation then ok := true;
      end;
      res := res || format('%s  admin   pump job without a pump model is rejected', case when ok then 'PASS' else 'FAIL' end);

      -- Demand notes: admin edits the viewer's note; author is preserved; admin deletes
      if note_id is not null then
        update public.demand_notes set status = 'planned', created_by = auth.uid() where id = note_id;
        get diagnostics n = row_count;
        res := res || format('%s  admin   can edit the viewer''s note', case when n = 1 then 'PASS' else 'FAIL' end);
        select count(*) into n from public.demand_notes where id = note_id and created_by = viewer_id and updated_by = admin_id;
        res := res || format('%s  admin   note keeps its author; editor recorded', case when n = 1 then 'PASS' else 'FAIL' end);
        delete from public.demand_notes where id = note_id;
        get diagnostics n = row_count;
        res := res || format('%s  admin   can delete demand notes', case when n = 1 then 'PASS' else 'FAIL' end);
        select count(*) into n from public.audit_log where table_name = 'demand_notes' and record_id = note_id;
        res := res || format('%s  admin   demand note history in audit log (%s entries)', case when n >= 4 then 'PASS' else 'FAIL' end, n);
      end if;

      -- Equipment and background / overnight jobs
      insert into public.equipment (name) values ('RLS test rig');
      res := res || 'PASS  admin   can add equipment'::text;
      select count(*) into n from public.audit_log where table_name = 'equipment' and changed_at >= now();
      res := res || format('%s  admin   equipment change written to audit log', case when n >= 1 then 'PASS' else 'FAIL' end);

      insert into public.assignments (person_id, work_date, task_id, pump_model_id, background, start_time, end_time, equipment_id, qty_target)
      values (pid, current_date, (select id from public.tasks where requires_pump order by sort_order limit 1),
              (select id from public.pump_models order by sort_order limit 1), true, '16:00', '08:00',
              (select id from public.equipment where name = 'RLS test rig'), 2);
      select count(*) into n from public.audit_log
      where table_name = 'assignments' and changed_at >= now() and new_data ? 'equipment_id' and (new_data ->> 'background') = 'true';
      res := res || format('%s  admin   overnight background job saved and audited with new fields', case when n >= 1 then 'PASS' else 'FAIL' end);

      begin
        insert into public.assignments (person_id, work_date, task_id, end_time)
        values (pid, current_date, (select id from public.tasks where name = 'Training'), '12:00');
        ok := false;
      exception when check_violation then ok := true;
      end;
      res := res || format('%s  admin   end time without a start time is rejected', case when ok then 'PASS' else 'FAIL' end);

      begin
        insert into public.assignments (person_id, work_date, task_id, end_date)
        values (pid, current_date, (select id from public.tasks where name = 'Training'), current_date - 1);
        ok := false;
      exception when check_violation then ok := true;
      end;
      res := res || format('%s  admin   end date before start date is rejected', case when ok then 'PASS' else 'FAIL' end);

      begin
        insert into public.audit_log (table_name, action) values ('x', 'insert');
        ok := false;
      exception when insufficient_privilege then ok := true;
      end;
      res := res || format('%s  admin   audit log cannot be written directly', case when ok then 'PASS' else 'FAIL' end);
    end if;

    execute 'reset role';
  end if;

  -- --------------------------------------------------------- logged out
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  execute 'set local role anon';
  begin
    perform 1 from public.pump_models limit 1;
    ok := false;
  exception when insufficient_privilege then ok := true;
  end;
  res := res || format('%s  anon    logged-out user cannot read data', case when ok then 'PASS' else 'FAIL' end);
  execute 'reset role';

  -- ------------------------------------------------------------- report
  select count(*) filter (where x like 'PASS%'), count(*) filter (where x like 'FAIL%')
  into passed, failed from unnest(res) x;

  raise exception using
    errcode = 'P0001',
    message = format(E'RLS CHECK FINISHED: %s passed, %s failed.\n'
                     'This "error" is deliberate: it undoes all test data.\n\n%s',
                     passed, failed,
                     (select string_agg(x, E'\n' order by x like 'PASS%', ord)
                      from unnest(res) with ordinality as u(x, ord)));
end;
$rls$;
