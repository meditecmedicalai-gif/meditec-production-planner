-- =====================================================================
-- RLS self-check. Run in Supabase → SQL Editor AFTER 001_init.sql and
-- after creating both users. Replace the two e-mail addresses below.
-- Everything runs inside a transaction that is ROLLED BACK, so no test
-- data is left behind. The final SELECT shows PASS / FAIL per check.
-- =====================================================================
begin;

create temp table rls_results (n serial, who text, check_name text, result text) on commit drop;
grant all on rls_results to authenticated, anon;
grant usage on sequence rls_results_n_seq to authenticated, anon;

-- ---------------------------------------------------------------- viewer
select set_config('request.jwt.claims',
       json_build_object('sub', id, 'role', 'authenticated')::text, true)
from auth.users where email = 'VIEWER_EMAIL_HERE';   -- <== Elaine's e-mail
set local role authenticated;

do $$
declare n int; note_id uuid; other_note uuid;
begin
  if auth.uid() is null then
    insert into rls_results (who, check_name, result) values ('viewer', 'viewer e-mail found', 'FAIL - check the e-mail address');
    return;
  end if;

  select count(*) into n from public.pump_models;
  insert into rls_results (who, check_name, result) values ('viewer', 'can read pump models', case when n > 0 then 'PASS' else 'FAIL' end);

  select count(*) into n from public.audit_log;
  insert into rls_results (who, check_name, result) values ('viewer', 'cannot read audit log', case when n = 0 then 'PASS' else 'FAIL' end);

  begin
    insert into public.people (name) values ('RLS test person');
    insert into rls_results (who, check_name, result) values ('viewer', 'cannot add people', 'FAIL');
  exception when insufficient_privilege then
    insert into rls_results (who, check_name, result) values ('viewer', 'cannot add people', 'PASS');
  end;

  begin
    insert into public.assignments (person_id, work_date, task_id)
    select (select id from public.people limit 1), current_date, (select id from public.tasks limit 1);
    insert into rls_results (who, check_name, result) values ('viewer', 'cannot add assignments', 'FAIL');
  exception when insufficient_privilege or not_null_violation then
    insert into rls_results (who, check_name, result) values ('viewer', 'cannot add assignments', 'PASS');
  end;

  update public.pump_models set name = name || ' x';
  get diagnostics n = row_count;
  insert into rls_results (who, check_name, result) values ('viewer', 'cannot edit pump models', case when n = 0 then 'PASS' else 'FAIL' end);

  update public.profiles set app_role = 'admin' where id = auth.uid();
  get diagnostics n = row_count;
  insert into rls_results (who, check_name, result) values ('viewer', 'cannot promote self to admin', case when n = 0 then 'PASS' else 'FAIL' end);

  update public.app_settings set work_start = '06:00';
  get diagnostics n = row_count;
  insert into rls_results (who, check_name, result) values ('viewer', 'cannot edit working hours', case when n = 0 then 'PASS' else 'FAIL' end);

  insert into public.demand_notes (quantity, comment) values (10, 'RLS test note') returning id into note_id;
  insert into rls_results (who, check_name, result) values ('viewer', 'can create demand note', case when note_id is not null then 'PASS' else 'FAIL' end);

  update public.demand_notes set status = 'done' where id = note_id;
  get diagnostics n = row_count;
  insert into rls_results (who, check_name, result) values ('viewer', 'can mark own note done', case when n = 1 then 'PASS' else 'FAIL' end);

  delete from public.demand_notes where id = note_id;
  get diagnostics n = row_count;
  insert into rls_results (who, check_name, result) values ('viewer', 'cannot delete own note', case when n = 0 then 'PASS' else 'FAIL' end);

  select id into other_note from public.demand_notes where created_by is distinct from auth.uid() limit 1;
  if other_note is not null then
    update public.demand_notes set comment = 'hacked' where id = other_note;
    get diagnostics n = row_count;
    insert into rls_results (who, check_name, result) values ('viewer', 'cannot edit others'' notes', case when n = 0 then 'PASS' else 'FAIL' end);
  end if;
end;
$$;

reset role;

-- ----------------------------------------------------------------- admin
select set_config('request.jwt.claims',
       json_build_object('sub', id, 'role', 'authenticated')::text, true)
from auth.users where email = 'ADMIN_EMAIL_HERE';    -- <== your e-mail
set local role authenticated;

do $$
declare n int; pid uuid;
begin
  if not public.is_admin() then
    insert into rls_results (who, check_name, result) values ('admin', 'user is admin', 'FAIL - run the make-admin SQL from the README');
    return;
  end if;

  insert into public.people (name) values ('RLS test person') returning id into pid;
  insert into rls_results (who, check_name, result) values ('admin', 'can add people', case when pid is not null then 'PASS' else 'FAIL' end);

  insert into public.assignments (person_id, work_date, task_id, qty_target)
  values (pid, current_date, (select id from public.tasks where name = 'Training'), 0);
  select count(*) into n from public.audit_log where table_name = 'assignments' and changed_by = auth.uid()
    and changed_at >= now();
  insert into rls_results (who, check_name, result) values ('admin', 'assignment change written to audit log', case when n >= 1 then 'PASS' else 'FAIL' end);

  begin
    insert into public.audit_log (table_name, action) values ('x', 'insert');
    insert into rls_results (who, check_name, result) values ('admin', 'audit log cannot be written directly', 'FAIL');
  exception when insufficient_privilege then
    insert into rls_results (who, check_name, result) values ('admin', 'audit log cannot be written directly', 'PASS');
  end;
end;
$$;

reset role;

-- ------------------------------------------------------------ logged out
select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;
do $$
begin
  perform 1 from public.pump_models limit 1;
  insert into rls_results (who, check_name, result) values ('anon', 'logged-out user cannot read data', 'FAIL');
exception when insufficient_privilege then
  insert into rls_results (who, check_name, result) values ('anon', 'logged-out user cannot read data', 'PASS');
end;
$$;
reset role;

select who, check_name, result from rls_results order by n;
rollback;
