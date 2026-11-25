-- =====================================================================
-- RLS self-check — run in Supabase → SQL Editor after all migrations.
--
-- 1. Replace the two e-mail addresses on the next lines of the block.
-- 2. Click Run.
--
-- The whole check is ONE statement. At the end it deliberately stops
-- with an "error" whose message is the report:
--
--     RLS CHECK FINISHED: 176 passed, 0 failed ...
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
  missing text;
  pat  uuid;
  mm_area  uuid;   -- Medicare / Mediflex test area (found by its pump models, else by name)
  mm_name  text;
  mm_max   int;
  mm_mode  text;
  mm_tasks text;
  qc_area  uuid;   -- Quality Check area (found by the QPro model, else by name)
  qc_name  text;
  qc_max   int;
  qc_mode  text;
  st_names text;
  probs    text[] := '{}';
  free_task uuid;  -- a task that needs no pump (by rule, not name)
  out_task  uuid;  -- a task that counts as output
  todo_a    uuid;  -- a to-do added by the admin
  todo_v    uuid;  -- a to-do added by the viewer
  st_task   uuid;  -- a stage task
  pid3 uuid;
  pid2 uuid;
  job_h uuid;      -- a job over two days (013)
  job_p uuid;
  rows_j jsonb;
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
  select string_agg(tb, ', ' order by tb) into missing
  from unnest(array['assignments','absences','demand_notes','people','person_skills','pump_models','tasks','build_types',
                    'equipment','app_settings','test_areas','test_area_shared_tasks','test_limits','test_limit_models',
                    'recurring_jobs','recurring_exceptions','work_patterns','work_pattern_days','person_work_patterns',
                    'person_day_hours','todos','pump_model_stages','demand_progress','demand_stage_plans']) as tb
  where not coalesce((select puballtables from pg_publication where pubname = 'supabase_realtime'), false)
    and not exists (select 1 from pg_publication_tables p where p.pubname = 'supabase_realtime' and p.schemaname = 'public' and p.tablename = tb);
  res := res || case when missing is null
    then 'PASS  setup   live updates enabled for all 24 planning tables'
    else 'FAIL  setup   live updates missing for: ' || missing || ' (run 005, 008 and 012, or Dashboard → Database → Publications → supabase_realtime)' end;
  res := res || format('%s  setup   test areas, limits and recurring jobs exist (005 migration run)',
    case when to_regclass('public.recurring_jobs') is not null and to_regclass('public.test_limits') is not null then 'PASS' else 'FAIL' end);
  res := res || format('%s  setup   change log (audit_log) is never sent as a live update',
    case when exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'audit_log')
              or coalesce((select puballtables from pg_publication where pubname = 'supabase_realtime'), false)
         then 'FAIL' else 'PASS' end);
  res := res || format('%s  setup   no site-wide limit — each test area is separate (006 migration run)',
    case when exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'app_settings' and column_name = 'max_pumps_on_test')
         then 'FAIL' else 'PASS' end);
  -- Quality Check area — by rule, not exact names: max 7 at once, simultaneous.
  select m.test_area_id into qc_area from public.pump_models m
  where m.test_area_id is not null and m.name ilike '%qpro%'
  group by m.test_area_id order by count(*) desc limit 1;
  if qc_area is null then
    select a.id into qc_area from public.test_areas a where a.name ilike '%quality%' or a.name ilike 'main test area' order by a.sort_order limit 1;
  end if;
  probs := '{}';
  if qc_area is null then
    probs := probs || 'no test area found (QPro 2000 has no default test area, and no area name mentions Quality Check)'::text;
  else
    select a.name, a.max_pumps, a.capacity_mode into qc_name, qc_max, qc_mode from public.test_areas a where a.id = qc_area;
    if qc_max is distinct from 7 then probs := probs || format('max pumps is %s, should be 7', qc_max); end if;
    if qc_mode is distinct from 'simultaneous' then
      probs := probs || format('capacity mode is "%s", should be "Simultaneous"', coalesce(qc_mode, 'not set'));
    end if;
  end if;
  res := res || case when cardinality(probs) = 0
    then format('PASS  setup   Quality Check area "%s": absolute max 7 pumps at once, simultaneous', qc_name)
    else format('FAIL  setup   Quality Check area%s: %s — fix in Settings → Test areas & limits',
                case when qc_name is null then '' else format(' "%s"', qc_name) end, array_to_string(probs, '; ')) end;
  res := res || format('%s  setup   equipment can be linked to a test area (007 migration run)',
    case when exists (select 1 from information_schema.columns
                      where table_schema = 'public' and table_name = 'equipment' and column_name = 'test_area_id')
         then 'PASS' else 'FAIL' end);
  -- Stations: at least one active station counts towards each area (any station name)
  select string_agg(e.name, ', ' order by e.sort_order) into st_names from public.equipment e where e.test_area_id = qc_area and e.active;
  res := res || case when st_names is not null
    then format('PASS  setup   station(s) counting towards the Quality Check area: %s', st_names)
    else format('FAIL  setup   no active station counts towards the Quality Check area%s — link one in Settings → Equipment / test stations → Test area',
                case when qc_name is null then '' else format(' "%s"', qc_name) end) end;
  -- The rule, not exact names: the Medicare / Mediflex area has max 1, works one pump at a time, and has a
  -- calibration task and a quality-testing task that count once together (any wording / capitalisation).
  select m.test_area_id into mm_area from public.pump_models m
  where m.test_area_id is not null and (m.name ilike '%medicare%' or m.name ilike '%mediflex%')
  group by m.test_area_id order by count(*) desc limit 1;
  if mm_area is null then
    select a.id into mm_area from public.test_areas a where a.name ilike '%medicare%' or a.name ilike '%mediflex%' order by a.sort_order limit 1;
  end if;
  select string_agg(e.name, ', ' order by e.sort_order) into st_names from public.equipment e where e.test_area_id = mm_area and e.active;
  res := res || case when st_names is not null
    then format('PASS  setup   station(s) counting towards the Medicare / Mediflex area: %s', st_names)
    else format('FAIL  setup   no active station counts towards the Medicare / Mediflex area%s — link one in Settings → Equipment / test stations → Test area',
                coalesce((select format(' "%s"', a.name) from public.test_areas a where a.id = mm_area), '')) end;
  probs := '{}';
  if mm_area is null then
    probs := probs || 'no test area found (none of the Medicare / Mediflex pump models has a default test area, and no area name mentions Medicare or Mediflex)'::text;
  else
    select a.name, a.max_pumps, a.capacity_mode into mm_name, mm_max, mm_mode from public.test_areas a where a.id = mm_area;
    select string_agg(k.name, ', ' order by k.sort_order) into mm_tasks
    from public.test_area_shared_tasks s join public.tasks k on k.id = s.task_id where s.test_area_id = mm_area;
    if mm_max is distinct from 1 then
      probs := probs || format('max pumps is %s, should be 1', mm_max);
    end if;
    if mm_mode is distinct from 'sequential' then
      probs := probs || format('capacity mode is "%s", should be "One at a time" (sequential)', coalesce(mm_mode, 'not set'));
    end if;
    if not exists (select 1 from public.test_area_shared_tasks s join public.tasks k on k.id = s.task_id
                   where s.test_area_id = mm_area and k.name ilike '%calibrat%') then
      probs := probs || format('no calibration task among the tasks that count once (shared now: %s)', coalesce(mm_tasks, 'none'));
    end if;
    if not exists (select 1 from public.test_area_shared_tasks s join public.tasks k on k.id = s.task_id
                   where s.test_area_id = mm_area and k.name ilike '%quality%') then
      probs := probs || format('no quality-testing task among the tasks that count once (shared now: %s)', coalesce(mm_tasks, 'none'));
    end if;
  end if;
  res := res || case when cardinality(probs) = 0
    then format('PASS  setup   Medicare / Mediflex area "%s": max 1, one at a time, %s count once', mm_name, mm_tasks)
    else format('FAIL  setup   Medicare / Mediflex area%s: %s — fix in Settings → Test areas & limits',
                case when mm_name is null then '' else format(' "%s"', mm_name) end, array_to_string(probs, '; ')) end;
  res := res || format('%s  setup   MATS and Bari-Med 1 have no limit group (count towards Quality Check only)',
    case when exists (select 1 from public.test_limit_models x join public.pump_models m on m.id = x.pump_model_id
                      where m.name ilike '%turn sense%' or m.name ilike '%(mats)%' or m.name ilike 'bari%med%') then 'FAIL' else 'PASS' end);
  res := res || format('%s  setup   work patterns exist with exactly one default, 7 weekdays each (008 migration run)',
    case when to_regclass('public.person_day_hours') is not null
          and (select count(*) from public.work_patterns where is_default) = 1
          and not exists (select 1 from public.work_patterns p where (select count(*) from public.work_pattern_days d where d.pattern_id = p.id) <> 7)
         then 'PASS' else 'FAIL' end);
  res := res || case
    when qc_area is null or mm_area is null then 'FAIL  setup   Quality Check and Medicare / Mediflex are separate areas — one of them was not found (see above)'
    when qc_area = mm_area then format('FAIL  setup   Quality Check and Medicare / Mediflex share one test area ("%s") — they must be separate (Settings → Pump models → Default test area)', qc_name)
    else 'PASS  setup   Quality Check and Medicare / Mediflex are separate test areas (no limit across them)' end;
  res := res || format('%s  setup   default pattern: a person with no pattern works Monday, not Sunday',
    case when public.person_works(gen_random_uuid(), date '2026-11-23') and not public.person_works(gen_random_uuid(), date '2026-11-29')
         then 'PASS' else 'FAIL' end);
  res := res || format('%s  setup   jobs can pause for breaks and continue on the next working day (009 migration run)',
    case when exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'assignments' and column_name = 'pause_for_breaks')
          and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'assignments' and column_name = 'part_of')
         then 'PASS' else 'FAIL' end);
  res := res || format('%s  setup   equipment can be marked "Can be shared", default no (010 migration run)',
    case when (select column_default from information_schema.columns where table_schema = 'public' and table_name = 'equipment' and column_name = 'shareable') = 'false'
         then 'PASS' else 'FAIL' end);
  res := res || format('%s  setup   jobs can cover a demand note; note status can be overridden (011 migration run)',
    case when exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'assignments' and column_name = 'demand_id')
          and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'demand_notes' and column_name = 'status_override')
         then 'PASS' else 'FAIL' end);
  res := res || format('%s  setup   people can be linked to a login (people.user_id)',
    case when exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'people' and column_name = 'user_id')
         then 'PASS' else 'FAIL' end);
  select id into free_task from public.tasks where not requires_pump order by (category = 'production') desc, sort_order limit 1;
  select id into out_task from public.tasks where counts_as_output order by sort_order limit 1;

  -- 012: office work, to-dos, stages, completed units, manual planned — checked by rule, not names
  probs := '{}';
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tasks' and column_name = 'category') then
    probs := probs || 'tasks have no category column — run migration 012'::text;
  elsif not exists (select 1 from public.tasks where category = 'office' and active) then
    probs := probs || 'no active office task (Settings → Tasks → Category: Office)'::text;
  else
    select string_agg(name, ', ') into mm_tasks from public.tasks where category = 'office' and (requires_pump or counts_as_output or coalesce(is_testing, false));
    if mm_tasks is not null then probs := probs || format('office tasks must not need a pump, count as output or be testing: %s', mm_tasks); end if;
  end if;
  res := res || case when cardinality(probs) = 0
    then format('PASS  setup   office tasks: %s', (select string_agg(name, ', ' order by sort_order) from public.tasks where category = 'office' and active))
    else 'FAIL  setup   office work: ' || array_to_string(probs, '; ') end;
  res := res || case
    when to_regclass('public.todos') is null or to_regclass('public.demand_progress') is null or to_regclass('public.demand_stage_plans') is null
         or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'assignments' and column_name = 'qty_done')
         or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'assignments' and column_name = 'todo_id')
      then 'FAIL  setup   to-dos, units done, logged progress and manual planned are missing — run migration 012'
    else 'PASS  setup   to-dos, units done, logged progress and manual planned quantities exist (012 migration run)' end;
  select string_agg(m.name, ', ' order by m.sort_order) into st_names from public.pump_models m
  where m.active and not exists (select 1 from public.pump_model_stages s where s.pump_model_id = m.id);
  res := res || case
    when to_regclass('public.pump_model_stages') is null then 'FAIL  setup   production stages table missing — run migration 012'
    when st_names is null then 'PASS  setup   every active pump model has production stages'
    when out_task is not null then format('PASS  setup   pump models without stages use the "counts as output" task(s) instead: %s (set stages in Settings → Pump models → Stages)', st_names)
    else format('FAIL  setup   no stages and no "counts as output" task for: %s — set stages in Settings → Pump models → Stages', st_names) end;
  res := res || case when exists (select 1 from public.demand_notes where status_override in ('planned', 'partly'))
    then format('FAIL  setup   %s demand note(s) still have a hand-set Planned status (run migration 012)', (select count(*) from public.demand_notes where status_override in ('planned', 'partly')))
    else 'PASS  setup   no hand-set "Planned" statuses left — planned is worked out from jobs + manual quantities' end;

  -- 013: jobs over several days are one job; corrections to completed units
  probs := '{}';
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'assignments' and column_name = 'work_minutes')
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'assignments' and column_name = 'part_locked') then
    probs := probs || 'assignments.work_minutes / part_locked missing'::text;
  end if;
  if to_regprocedure('public.apply_job_parts(jsonb, uuid[])') is null then probs := probs || 'function apply_job_parts missing'::text; end if;
  if not exists (select 1 from pg_trigger tg where tg.tgrelid = 'public.assignments'::regclass and tg.tgconstraint <> 0 and tg.tgdeferrable) then
    probs := probs || 'no one-part-per-day guard on assignments'::text;
  end if;
  if not exists (select 1 from pg_trigger tg where tg.tgrelid = 'public.demand_progress'::regclass and tg.tgconstraint <> 0 and tg.tgdeferrable) then
    probs := probs || 'no "completed can''t go below 0" guard on demand_progress'::text;
  end if;
  res := res || case when cardinality(probs) = 0
    then 'PASS  setup   jobs over several days: total work time on part 1, locked parts, one-part-per-day guard, save-all-parts function; completed below-0 guard (013 migration run)'
    else 'FAIL  setup   run migration 013 — ' || array_to_string(probs, '; ') end;
  res := res || case
    when not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'app_settings' and column_name = 'overflow_mode')
      then 'FAIL  setup   "When a job runs past finish time" setting missing — run migration 013'
    else format('PASS  setup   "When a job runs past finish time": %s',
      coalesce((select case overflow_mode when 'continue' then 'continue next working day' when 'ask' then 'ask me' else 'allow overtime' end from public.app_settings where id = 1), 'continue next working day (default)')) end;
  select count(*) into n from (
    select 1 from public.assignments a group by coalesce(a.part_of, a.id), a.work_date having count(*) > 1) d;
  res := res || case when n = 0 then 'PASS  setup   no job has two parts on the same day'
    else format('FAIL  setup   %s job-day(s) have two or more parts of the same job — run supabase/tests/report_013_parts.sql, then cleanup_013_parts.sql', n) end;
  select count(*) into n from public.assignments where part_of is not null and qty_done is not null;
  res := res || case when n = 0 then 'PASS  setup   units done are recorded once per job (on part 1)'
    else format('FAIL  setup   %s continued part(s) carry units done — run migration 013 again', n) end;

  res := res || format('%s  setup   viewer e-mail found (%s)', case when viewer_id is null then 'FAIL' else 'PASS' end, viewer_email);
  res := res || format('%s  setup   admin e-mail found (%s)',  case when admin_id  is null then 'FAIL' else 'PASS' end, admin_email);

  -- A note "posted by the admin", so the viewer checks below always have
  -- someone else's note to try (and fail) to edit. Rolled back at the end.
  if admin_id is not null then
    insert into public.demand_notes (quantity, comment, created_by) values (1, 'RLS test: admin note', admin_id);
    insert into public.todos (title, owner_id, created_by) values ('RLS test: admin to-do', admin_id, admin_id) returning id into todo_a;
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

    update public.equipment set shareable = not shareable;
    get diagnostics n = row_count;
    res := res || format('%s  viewer  cannot change whether equipment can be shared', case when n = 0 then 'PASS' else 'FAIL' end);

    update public.equipment set test_area_id = null where test_area_id is not null;
    get diagnostics n = row_count;
    res := res || format('%s  viewer  cannot change which test area a station counts towards', case when n = 0 then 'PASS' else 'FAIL' end);

    begin
      insert into public.test_areas (name, max_pumps) values ('RLS test area', 3);
      ok := false;
    exception when insufficient_privilege then ok := true;
    end;
    res := res || format('%s  viewer  cannot add test areas', case when ok then 'PASS' else 'FAIL' end);

    update public.test_limits set max_pumps = 99;
    get diagnostics n = row_count;
    res := res || format('%s  viewer  cannot change test limits', case when n = 0 then 'PASS' else 'FAIL' end);

    begin
      insert into public.recurring_jobs (task_id, pattern) values ((select id from public.tasks limit 1), 'daily');
      ok := false;
    exception when insufficient_privilege then ok := true;
    end;
    res := res || format('%s  viewer  cannot add recurring jobs', case when ok then 'PASS' else 'FAIL' end);

    select public.extend_recurring_jobs(current_date + 14) into n;
    res := res || format('%s  viewer  cannot generate recurring jobs', case when n = 0 then 'PASS' else 'FAIL' end);

    select count(*) into n from public.work_patterns;
    res := res || format('%s  viewer  can see working hours (work patterns)', case when n > 0 then 'PASS' else 'FAIL' end);
    begin
      insert into public.work_patterns (name) values ('RLS test pattern');
      ok := false;
    exception when insufficient_privilege then ok := true;
    end;
    res := res || format('%s  viewer  cannot add a work pattern', case when ok then 'PASS' else 'FAIL' end);
    update public.work_pattern_days set end_time = '23:00' where works;
    get diagnostics n = row_count;
    res := res || format('%s  viewer  cannot change pattern hours', case when n = 0 then 'PASS' else 'FAIL' end);
    begin
      insert into public.person_work_patterns (person_id, pattern_id, effective_from)
      values ((select id from public.people limit 1), (select id from public.work_patterns limit 1), current_date);
      ok := false;
    exception when insufficient_privilege or not_null_violation then ok := true;
    end;
    res := res || format('%s  viewer  cannot assign a pattern to a person', case when ok then 'PASS' else 'FAIL' end);
    begin
      insert into public.person_day_hours (person_id, work_date, end_time) values ((select id from public.people limit 1), current_date, '14:00');
      ok := false;
    exception when insufficient_privilege or not_null_violation then ok := true;
    end;
    res := res || format('%s  viewer  cannot add a one-off change of hours', case when ok then 'PASS' else 'FAIL' end);
    update public.people set user_id = viewer_id;
    get diagnostics n = row_count;
    res := res || format('%s  viewer  cannot link a person to a login', case when n = 0 then 'PASS' else 'FAIL' end);

    select count(*) into n from public.test_areas;
    res := res || format('%s  viewer  can read test areas', case when n > 0 then 'PASS' else 'FAIL' end);

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
    values (10, 'RLS test note', (select id from public.build_types where not is_default order by sort_order limit 1),
            (select id from public.pump_models order by sort_order limit 1), current_date + 7, 'high')
    returning id into note_id;
    res := res || format('%s  viewer  can create demand note', case when note_id is not null then 'PASS' else 'FAIL' end);

    update public.demand_notes set comment = 'RLS test note (edited)', quantity = 12,
           build_type_id = (select id from public.build_types where is_default) where id = note_id;
    get diagnostics n = row_count;
    res := res || format('%s  viewer  can edit own note (comment, quantity, type)', case when n = 1 then 'PASS' else 'FAIL' end);

    update public.demand_notes set status = 'done', status_override = 'done' where id = note_id;
    get diagnostics n = row_count;
    res := res || format('%s  viewer  can mark own note done (status override)', case when n = 1 then 'PASS' else 'FAIL' end);

    update public.assignments set demand_id = note_id;
    get diagnostics n = row_count;
    res := res || format('%s  viewer  cannot link jobs to a demand note', case when n = 0 then 'PASS' else 'FAIL' end);

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
      update public.demand_notes set status_override = 'done' where id = other_note;
      get diagnostics n = row_count;
      res := res || format('%s  viewer  cannot override the status of others'' notes', case when n = 0 then 'PASS' else 'FAIL' end);
    end if;

    -- To-dos: see all, add (also for someone else), edit own, never delete
    select count(*) into n from public.todos;
    res := res || format('%s  viewer  can see to-dos', case when n > 0 then 'PASS' else 'FAIL' end);
    insert into public.todos (title, owner_id, checklist) values ('RLS test: to-do for the admin', admin_id, '[{"text":"a","done":false}]') returning id into todo_v;
    res := res || format('%s  viewer  can add a to-do for someone else', case when todo_v is not null then 'PASS' else 'FAIL' end);
    update public.todos set status = 'in_progress', checklist = '[{"text":"a","done":true}]' where id = todo_v;
    get diagnostics n = row_count;
    res := res || format('%s  viewer  can edit a to-do she added', case when n = 1 then 'PASS' else 'FAIL' end);
    update public.todos set title = 'hacked' where id = todo_a;
    get diagnostics n = row_count;
    res := res || format('%s  viewer  cannot edit others'' to-dos', case when n = 0 then 'PASS' else 'FAIL' end);
    delete from public.todos where id = todo_v;
    get diagnostics n = row_count;
    res := res || format('%s  viewer  cannot delete a to-do (even her own)', case when n = 0 then 'PASS' else 'FAIL' end);
    -- Progress: sees it, can't record it
    begin
      insert into public.demand_progress (demand_id, qty) values ((select id from public.demand_notes limit 1), 1);
      ok := false;
    exception when insufficient_privilege then ok := true;
    end;
    res := res || format('%s  viewer  cannot log completed units on a note', case when ok then 'PASS' else 'FAIL' end);
    begin
      insert into public.demand_stage_plans (demand_id, task_id, qty) values ((select id from public.demand_notes limit 1), out_task, 5);
      ok := false;
    exception when insufficient_privilege or not_null_violation then ok := true;
    end;
    res := res || format('%s  viewer  cannot enter manual planned quantities', case when ok then 'PASS' else 'FAIL' end);
    update public.assignments set qty_done = 1;
    get diagnostics n = row_count;
    res := res || format('%s  viewer  cannot record units done on jobs', case when n = 0 then 'PASS' else 'FAIL' end);
    delete from public.pump_model_stages;
    get diagnostics n = row_count;
    res := res || format('%s  viewer  cannot change production stages', case when n = 0 then 'PASS' else 'FAIL' end);
    -- 013
    begin
      perform public.apply_job_parts(jsonb_build_array(jsonb_build_object('person_id', pid3, 'task_id', free_task, 'work_date', current_date)));
      ok := false;
    exception when insufficient_privilege then ok := true;
    end;
    res := res || format('%s  viewer  cannot save or move jobs over several days', case when ok then 'PASS' else 'FAIL' end);
    update public.demand_progress set qty = qty + 1;
    get diagnostics n = row_count;
    ok := n = 0;
    delete from public.demand_progress;
    get diagnostics n = row_count;
    res := res || format('%s  viewer  cannot edit or delete logged completed units', case when ok and n = 0 then 'PASS' else 'FAIL' end);

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
      values (pid, current_date, free_task, 0);
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
        values (pid, current_date, free_task, '12:00');
        ok := false;
      exception when check_violation then ok := true;
      end;
      res := res || format('%s  admin   end time without a start time is rejected', case when ok then 'PASS' else 'FAIL' end);

      begin
        insert into public.assignments (person_id, work_date, task_id, end_date)
        values (pid, current_date, free_task, current_date - 1);
        ok := false;
      exception when check_violation then ok := true;
      end;
      res := res || format('%s  admin   end date before start date is rejected', case when ok then 'PASS' else 'FAIL' end);

      -- Test areas
      insert into public.test_areas (name, max_pumps) values ('RLS test area', 3);
      insert into public.test_limits (test_area_id, name, max_pumps)
      values ((select id from public.test_areas where name = 'RLS test area'), 'RLS group', 2);
      insert into public.test_limit_models (test_limit_id, pump_model_id)
      values ((select id from public.test_limits where name = 'RLS group'), (select id from public.pump_models order by sort_order limit 1));
      res := res || 'PASS  admin   can add test areas, limit groups and their models'::text;
      select count(*) into n from public.audit_log where table_name = 'test_limit_models' and changed_at >= now();
      res := res || format('%s  admin   test limit change written to audit log', case when n >= 1 then 'PASS' else 'FAIL' end);

      -- Any / mixed pump
      insert into public.assignments (person_id, work_date, task_id, any_pump, pump_mix)
      values (pid, current_date, (select id from public.tasks where allows_any_pump order by sort_order limit 1), true,
              '[{"qty": 2}]'::jsonb);
      res := res || 'PASS  admin   "Any / mixed pump" repair job saved'::text;
      begin
        insert into public.assignments (person_id, work_date, task_id, any_pump)
        values (pid, current_date, (select id from public.tasks where requires_pump and not allows_any_pump order by sort_order limit 1), true);
        ok := false;
      exception when check_violation then ok := true;
      end;
      res := res || format('%s  admin   "Any / mixed pump" refused on a non-repair task', case when ok then 'PASS' else 'FAIL' end);

      -- Recurring: every working day for 14 days, one removed date, one absent day
      insert into public.people (name) values ('RLS repeat person') returning id into pid2;
      insert into public.recurring_jobs (title, person_id, task_id, pattern, start_date, end_date)
      values ('RLS repeat', pid2, free_task, 'workdays', current_date, current_date + 13);
      insert into public.recurring_exceptions (recurring_id, skip_date)
      select id, (select d from generate_series(current_date, current_date + 13, interval '1 day') d
                  where extract(isodow from d) <= 5 order by d limit 1)::date
      from public.recurring_jobs where title = 'RLS repeat';
      insert into public.absences (person_id, start_date, end_date, absence_type)
      select pid2, d::date, d::date, 'holiday' from generate_series(current_date, current_date + 13, interval '1 day') d
      where extract(isodow from d) <= 5 order by d offset 1 limit 1;
      perform public.extend_recurring_jobs(current_date + 30);
      perform public.extend_recurring_jobs(current_date + 30);  -- running twice must not duplicate
      select count(*) into n from public.assignments a join public.recurring_jobs r on r.id = a.recurring_id where r.title = 'RLS repeat';
      res := res || format('%s  admin   recurring: 10 working days − 1 removed − 1 absent = 8 jobs, no duplicates (got %s)',
        case when n = 8 then 'PASS' else 'FAIL' end, n);

      -- Individual hours: a Mon–Thu pattern (Friday off) + one day off → recurring skips them
      insert into public.work_patterns (name) values ('RLS Mon–Thu') returning id into pat;
      insert into public.work_pattern_days (pattern_id, weekday, works, start_time, end_time, break_time, break_minutes, lunch_time, lunch_minutes)
      select pat, d, d <= 4, case when d <= 4 then time '07:00' end, case when d <= 4 then time '15:00' end,
             case when d <= 4 then time '09:30' end, case when d <= 4 then 15 else 0 end, case when d <= 4 then time '12:00' end, case when d <= 4 then 30 else 0 end
      from generate_series(1, 7) d;
      res := res || 'PASS  admin   can add a work pattern with its weekdays'::text;
      insert into public.people (name) values ('RLS part-timer') returning id into pid3;
      insert into public.person_work_patterns (person_id, pattern_id, effective_from, end_time) values (pid3, pat, current_date - 7, '14:30');
      insert into public.person_day_hours (person_id, work_date, works)
      select pid3, d::date, false from generate_series(current_date, current_date + 13, interval '1 day') d
      where extract(isodow from d) <= 4 order by d limit 1;
      res := res || 'PASS  admin   can assign a pattern (with an override) and add a one-off day change'::text;
      insert into public.recurring_jobs (title, person_id, task_id, pattern, start_date, end_date)
      values ('RLS part-time repeat', pid3, free_task, 'workdays', current_date, current_date + 13);
      perform public.extend_recurring_jobs(current_date + 30);
      select count(*) into n from public.assignments a join public.recurring_jobs r on r.id = a.recurring_id where r.title = 'RLS part-time repeat';
      res := res || format('%s  admin   recurring skips non-working days: 10 working days − 2 Fridays − 1 day off = 7 jobs (got %s)',
        case when n = 7 then 'PASS' else 'FAIL' end, n);
      select count(*) into n from public.audit_log
      where table_name in ('work_patterns', 'work_pattern_days', 'person_work_patterns', 'person_day_hours') and changed_at >= now();
      res := res || format('%s  admin   working-hours changes written to the change log', case when n >= 4 then 'PASS' else 'FAIL' end);

      -- Demand: a job covers a note; deleting the note only unlinks the job
      insert into public.demand_notes (quantity, comment, pump_model_id) values (4, 'RLS demand link', (select id from public.pump_models order by sort_order limit 1)) returning id into other_note;
      insert into public.assignments (person_id, work_date, task_id, pump_model_id, build_type_id, qty_target, demand_id)
      values (pid3, current_date, out_task, (select id from public.pump_models order by sort_order limit 1),
              (select id from public.build_types where is_default), 4, other_note) returning id into pid2;
      delete from public.demand_notes where id = other_note;
      select count(*) into n from public.assignments where id = pid2 and demand_id is null;
      res := res || format('%s  admin   job linked to a demand note; deleting the note keeps the job (unlinked)', case when n = 1 then 'PASS' else 'FAIL' end);

      -- 012: stages, units done, logged completed, manual planned, to-do links — all in the change log
      select id into st_task from public.tasks where category = 'production' and requires_pump order by sort_order limit 1;
      insert into public.pump_model_stages (pump_model_id, task_id, position)
      values ((select id from public.pump_models order by sort_order limit 1), st_task, 99) on conflict do nothing;
      insert into public.demand_notes (quantity, comment, pump_model_id) values (10, 'RLS progress', (select id from public.pump_models order by sort_order limit 1)) returning id into other_note;
      insert into public.assignments (person_id, work_date, task_id, pump_model_id, build_type_id, qty_target, qty_done, demand_id)
      values (pid3, current_date, out_task, (select id from public.pump_models order by sort_order limit 1), (select id from public.build_types where is_default), 5, 2, other_note)
      returning id into pid2;
      update public.assignments set qty_done = 4 where id = pid2;
      insert into public.demand_progress (demand_id, task_id, qty, note) values (other_note, out_task, 3, 'RLS log');
      insert into public.demand_stage_plans (demand_id, task_id, qty) values (other_note, out_task, 6);
      update public.demand_stage_plans set qty = 7 where demand_id = other_note and task_id = out_task;
      res := res || 'PASS  admin   can set stages, record units done, log completed units and enter manual planned'::text;
      select count(*) into n from public.audit_log where changed_at >= now() and (
        (table_name = 'assignments' and record_id = pid2 and action = 'update' and old_data ->> 'qty_done' = '2' and new_data ->> 'qty_done' = '4')
        or table_name in ('demand_progress', 'demand_stage_plans', 'pump_model_stages'));
      res := res || format('%s  admin   units done, logged completed, manual planned and stage changes written to the change log', case when n >= 4 then 'PASS' else 'FAIL' end);
      insert into public.todos (title) values ('RLS to-do link') returning id into todo_v;
      update public.assignments set todo_id = todo_v where id = pid2;
      delete from public.todos where id = todo_v;
      select count(*) into n from public.assignments where id = pid2 and todo_id is null;
      res := res || format('%s  admin   job scheduled for a to-do; deleting the to-do keeps the job (unlinked)', case when n = 1 then 'PASS' else 'FAIL' end);

      -- A job continued on the next working day: deleting part 1 removes its parts
      insert into public.assignments (person_id, work_date, task_id, start_time, end_time)
      values (pid3, current_date, free_task, '13:00', '14:30') returning id into note_id;
      insert into public.assignments (person_id, work_date, task_id, start_time, end_time, part_of)
      values (pid3, current_date + 1, free_task, '07:00', '08:00', note_id);
      delete from public.assignments where id = note_id;
      select count(*) into n from public.assignments where part_of = note_id;
      res := res || format('%s  admin   job split over two days: deleting part 1 deletes part 2; pause for breaks is on by default',
        case when n = 0 and (select column_default from information_schema.columns where table_schema = 'public' and table_name = 'assignments' and column_name = 'pause_for_breaks') = 'true'
             then 'PASS' else 'FAIL' end);

      -- 013: a job over two days saved in one step, moved and shortened without duplicates
      rows_j := jsonb_build_array(
        jsonb_build_object('person_id', pid3, 'task_id', free_task, 'work_date', current_date + 30, 'start_time', '15:00', 'end_time', '16:30', 'work_minutes', 180),
        jsonb_build_object('person_id', pid3, 'task_id', free_task, 'work_date', current_date + 31, 'start_time', '08:30', 'end_time', '10:00', 'qty_done', 9));
      job_h := public.apply_job_parts(rows_j);
      select id into job_p from public.assignments where part_of = job_h;
      select count(*) into n from public.assignments where coalesce(part_of, id) = job_h;
      res := res || format('%s  admin   job over two days saved in one step: total work time on part 1, part 2 points at it',
        case when n = 2 and (select work_minutes from public.assignments where id = job_h) = 180
                  and (select qty_done is null and work_minutes is null from public.assignments where id = job_p) then 'PASS' else 'FAIL' end);
      perform public.apply_job_parts(jsonb_build_array(
        jsonb_build_object('id', job_h, 'work_date', current_date + 31),
        jsonb_build_object('id', job_p, 'work_date', current_date + 32)));
      select count(*) into n from public.assignments where coalesce(part_of, id) = job_h;
      res := res || format('%s  admin   moving the job moves both parts (same rows, no duplicates)',
        case when n = 2 and (select work_date from public.assignments where id = job_p) = current_date + 32 then 'PASS' else 'FAIL' end);
      begin
        perform public.apply_job_parts(jsonb_build_array(
          jsonb_build_object('id', job_h, 'work_date', current_date + 33),
          jsonb_build_object('person_id', pid3, 'task_id', free_task, 'work_date', current_date + 33)));
        ok := false;
      exception when unique_violation then ok := true;
      end;
      select count(*) into n from public.assignments where coalesce(part_of, id) = job_h;
      res := res || format('%s  admin   saving two parts of one job on the same day is refused and nothing is saved',
        case when ok and n = 2 and (select work_date from public.assignments where id = job_h) = current_date + 31 then 'PASS' else 'FAIL' end);
      begin
        insert into public.assignments (person_id, work_date, task_id, part_of) values (pid3, current_date + 32, free_task, job_h);
        execute 'set constraints all immediate';
        ok := false;
      exception when unique_violation then ok := true;
      end;
      execute 'set constraints all deferred';
      res := res || format('%s  admin   a second part on the same day is refused by the database', case when ok then 'PASS' else 'FAIL' end);
      perform public.apply_job_parts(jsonb_build_array(jsonb_build_object('id', job_h, 'end_time', '17:00', 'work_minutes', null)), array[job_p]);
      select count(*) into n from public.assignments where coalesce(part_of, id) = job_h;
      res := res || format('%s  admin   shortening the job removes the part it no longer needs', case when n = 1 then 'PASS' else 'FAIL' end);

      -- 013: corrections to completed units (note "RLS progress": 4 units done + 3 logged = 7 at out_task)
      begin
        insert into public.demand_progress (demand_id, task_id, qty, note, kind) values (other_note, out_task, -2, 'counted twice', 'correction') returning id into job_p;
        insert into public.demand_progress (demand_id, task_id, qty, note, kind) values (other_note, out_task, 1, 'Adjusted from 5 to 6', 'adjust') returning id into job_h;
        update public.demand_progress set qty = -3 where id = job_p;
        delete from public.demand_progress where id = job_h;
        execute 'set constraints all immediate';
        ok := true;
      exception when others then ok := false;
      end;
      execute 'set constraints all deferred';
      res := res || format('%s  admin   corrections: negative entry, adjust, edit and delete a logged entry', case when ok then 'PASS' else 'FAIL' end);
      begin
        insert into public.demand_progress (demand_id, task_id, qty, kind) values (other_note, out_task, -100, 'correction');
        execute 'set constraints all immediate';
        ok := false;
      exception when check_violation then ok := true;
      end;
      execute 'set constraints all deferred';
      res := res || format('%s  admin   completed can''t go below 0', case when ok then 'PASS' else 'FAIL' end);
      select count(*) into n from public.audit_log where changed_at >= now() and table_name = 'demand_progress'
        and ((action = 'update' and old_data ->> 'qty' = '-2' and new_data ->> 'qty' = '-3') or (action = 'delete' and old_data ->> 'kind' = 'adjust'));
      res := res || format('%s  admin   corrections written to the change log (who, old → new)', case when n >= 2 then 'PASS' else 'FAIL' end);

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
