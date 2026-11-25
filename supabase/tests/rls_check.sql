-- =====================================================================
-- RLS self-check — run in Supabase → SQL Editor after all migrations.
--
-- 1. Replace the two e-mail addresses on the next lines of the block.
-- 2. Click Run.
--
-- The whole check is ONE statement. At the end it deliberately stops
-- with an "error" whose message is the report:
--
--     RLS CHECK FINISHED: 138 passed, 0 failed ...
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
  pid3 uuid;
  pid2 uuid;
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
                    'person_day_hours']) as tb
  where not coalesce((select puballtables from pg_publication where pubname = 'supabase_realtime'), false)
    and not exists (select 1 from pg_publication_tables p where p.pubname = 'supabase_realtime' and p.schemaname = 'public' and p.tablename = tb);
  res := res || case when missing is null
    then 'PASS  setup   live updates enabled for all 20 planning tables'
    else 'FAIL  setup   live updates missing for: ' || missing || ' (run 005 and 008, or Dashboard → Database → Publications → supabase_realtime)' end;
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
                      where m.name in ('MediAir Turn Sense (MATS)', 'Bari-Med 1')) then 'FAIL' else 'PASS' end);
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
    values (10, 'RLS test note', (select id from public.build_types where name = 'Trial'),
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
      values ('RLS repeat', pid2, (select id from public.tasks where name = 'Training'), 'workdays', current_date, current_date + 13);
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
      values ('RLS part-time repeat', pid3, (select id from public.tasks where name = 'Training'), 'workdays', current_date, current_date + 13);
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
      values (pid3, current_date, (select id from public.tasks where name = 'Final assembly'), (select id from public.pump_models order by sort_order limit 1),
              (select id from public.build_types where is_default), 4, other_note) returning id into pid2;
      delete from public.demand_notes where id = other_note;
      select count(*) into n from public.assignments where id = pid2 and demand_id is null;
      res := res || format('%s  admin   job linked to a demand note; deleting the note keeps the job (unlinked)', case when n = 1 then 'PASS' else 'FAIL' end);

      -- A job continued on the next working day: deleting part 1 removes its parts
      insert into public.assignments (person_id, work_date, task_id, start_time, end_time)
      values (pid3, current_date, (select id from public.tasks where name = 'Training'), '13:00', '14:30') returning id into note_id;
      insert into public.assignments (person_id, work_date, task_id, start_time, end_time, part_of)
      values (pid3, current_date + 1, (select id from public.tasks where name = 'Training'), '07:00', '08:00', note_id);
      delete from public.assignments where id = note_id;
      select count(*) into n from public.assignments where part_of = note_id;
      res := res || format('%s  admin   job split over two days: deleting part 1 deletes part 2; pause for breaks is on by default',
        case when n = 0 and (select column_default from information_schema.columns where table_schema = 'public' and table_name = 'assignments' and column_name = 'pause_for_breaks') = 'true'
             then 'PASS' else 'FAIL' end);

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
