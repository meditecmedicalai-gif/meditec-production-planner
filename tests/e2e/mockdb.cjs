// Tiny in-memory stand-in for the Supabase REST API, enough for UI tests.
let seq = 0; const uid = () => 'id' + (++seq);
function seed() {
  const models = ['QPro 2000','Simplex','MediAir','MediAir Turn','MediAir Turn Sense (MATS)','Mediflex','Medicare','Bari-Med 1']
    .map((n,i)=>({id:uid(),name:n,short_code:['QPro','Simplex','MediAir','MA Turn','MATS','Mediflex','Medicare','Bari-Med'][i],active:true,sort_order:(i+1)*10}));
  const tasks = ['Sub-assembly','Final assembly','Functional test / calibration','QC & Packing','Rework','Repair','Training','Stock room / 5S','Other']
    .map((n,i)=>({id:uid(),name:n,requires_pump:i<6,counts_as_output:n==='Final assembly',is_background:false,active:true,sort_order:(i+1)*10}));
  tasks.push({ id: uid(), name: 'Soak / burn-in test', requires_pump: true, counts_as_output: false, is_background: true, active: true, sort_order: 35 });
  tasks.push({ id: uid(), name: 'Quality testing', requires_pump: true, counts_as_output: false, is_background: false, active: true, sort_order: 36 });
  for (const [i, n] of ['Documentation', 'Odoo / ERP', 'Meetings', 'Admin / Email'].entries()) tasks.push({ id: uid(), name: n, requires_pump: false, counts_as_output: false, is_background: false, active: true, sort_order: 900 + i, category: 'office' });
  for (const t of tasks) { t.is_testing = ['Functional test / calibration', 'Quality testing', 'Soak / burn-in test'].includes(t.name); t.allows_any_pump = t.name === 'Repair'; t.category = t.category || 'production'; }
  tasks.sort((a, b) => a.sort_order - b.sort_order);
  const equipment = [['Quality Check','areaMain',5],['Medicare / Mediflex test bench','areaMM',6],['Test rig 1',null,10],['Test rig 2',null,20],['Soak rack',null,30]].map(([n,a,o])=>({ id: n === 'Quality Check' ? 'eqQC' : n.startsWith('Medicare') ? 'eqMM' : uid(), name: n, notes: null, test_area_id: a, active: true, sort_order: o }));
  const build_types = [['Production','#475569'],['Trial','#b45309'],['Rental','#7c3aed'],['Customer','#0369a1']].map(([n,c],i)=>({id:uid(),name:n,color:c,is_default:i===0,active:true,sort_order:(i+1)*10}));
  const test_areas = [{ id: 'areaMain', name: 'Quality Check', max_pumps: 7, capacity_mode: 'simultaneous', notes: null, active: true, sort_order: 10 }, { id: 'areaMM', name: 'Medicare / Mediflex test area', max_pumps: 1, capacity_mode: 'sequential', notes: null, active: true, sort_order: 20 }];
  for (const m of models) m.test_area_id = ['Medicare', 'Mediflex'].includes(m.name) ? 'areaMM' : 'areaMain';
  const mid = (n) => models.find((m) => m.name === n).id, tid = (n) => tasks.find((t) => t.name === n).id;
  const test_limits = [{ id: 'L1', test_area_id: 'areaMain', name: 'QPro 2000', max_pumps: 7, active: true, sort_order: 10 }, { id: 'L2', test_area_id: 'areaMain', name: 'MediAir + Simplex', max_pumps: 6, active: true, sort_order: 20 }, { id: 'L3', test_area_id: 'areaMain', name: 'MediAir Turn', max_pumps: 3, active: true, sort_order: 30 }];
  const test_limit_models = [{ test_limit_id: 'L1', pump_model_id: mid('QPro 2000') }, { test_limit_id: 'L2', pump_model_id: mid('MediAir') }, { test_limit_id: 'L2', pump_model_id: mid('Simplex') }, { test_limit_id: 'L3', pump_model_id: mid('MediAir Turn') }];
  const test_area_shared_tasks = [{ test_area_id: 'areaMM', task_id: tid('Functional test / calibration') }, { test_area_id: 'areaMM', task_id: tid('Quality testing') }];
  const work_patterns = [{ id: 'patStd', name: 'Standard', is_default: true, notes: 'Default working hours', active: true, sort_order: 10 }];
  const work_pattern_days = [1, 2, 3, 4, 5, 6, 7].map((w) => ({ pattern_id: 'patStd', weekday: w, works: w <= 5, start_time: w <= 5 ? '08:30:00' : null, end_time: w <= 5 ? '16:30:00' : null,
    break_time: w <= 5 ? '10:30:00' : null, break_minutes: w <= 5 ? 15 : 0, lunch_time: w <= 5 ? '12:30:00' : null, lunch_minutes: w <= 5 ? 30 : 0 }));
  return { todos: [], pump_model_stages: [], demand_progress: [], demand_stage_plans: [], work_patterns, work_pattern_days, person_work_patterns: [], person_day_hours: [], test_areas, test_limits, test_limit_models, test_area_shared_tasks, recurring_jobs: [], recurring_exceptions: [], pump_models: models, tasks, build_types, people: [], person_skills: [], assignments: [], absences: [], demand_notes: [], audit_log: [], equipment,
    app_settings: [{id:1,work_start:'08:30:00',work_end:'16:30:00',break_time:'10:30:00',break_minutes:15,lunch_time:'12:30:00',lunch_minutes:30,max_pumps_on_test:7}] };
}
function filt(rows, params) {
  for (const [k, v] of params) {
    if (['select','order','limit','offset','columns'].includes(k)) continue;
    if (k === 'or') { const parts = v.replace(/^\(|\)$/g,'').split(',');
      const test = (r, c) => { let m = c.match(/^(\w+)->>(\w+)\.eq\.(.+)$/); if (m) return r[m[1]] && String(r[m[1]][m[2]]) === m[3];
        m = c.match(/^(\w+)\.(eq|gte|lte)\.(.+)$/); if (!m) return false; const x = r[m[1]]; if (x == null) return false;
        return m[2] === 'eq' ? String(x) === m[3] : m[2] === 'gte' ? String(x) >= m[3] : String(x) <= m[3]; };
      rows = rows.filter(r => parts.some(c => test(r, c))); continue; }
    const [op, ...rest] = v.split('.'); const val = rest.join('.');
    if (op === 'eq') rows = rows.filter(r => String(r[k]) === val);
    else if (op === 'gte') rows = rows.filter(r => String(r[k]) >= val);
    else if (op === 'lte') rows = rows.filter(r => String(r[k]) <= val);
    else if (op === 'is') rows = rows.filter(r => val === 'null' ? r[k] == null : String(r[k]) === val);
    else if (op === 'lt') rows = rows.filter(r => r[k] != null && String(r[k]) < val);
    else if (op === 'neq') rows = rows.filter(r => String(r[k]) !== val);
    else if (op === 'gt') rows = rows.filter(r => r[k] != null && String(r[k]) > val);
    else if (op === 'in') { const set = val.replace(/^\(|\)$/g,'').split(',').map(s=>s.replace(/"/g,'')); rows = rows.filter(r => set.includes(String(r[k]))); }
  }
  return rows;
}
function sort(rows, order) {
  if (!order) return rows;
  const keys = order.split(',').map(o => [o.split('.')[0], o.includes('.desc') ? -1 : 1]);
  return rows.slice().sort((a,b)=>{ for (const [k,d] of keys) { const x = a[k] ?? '', y = b[k] ?? ''; if (x<y) return -d; if (x>y) return d; } return 0; });
}
module.exports = function makeHandler(role, db) {
  return async (rt) => {
    const req = rt.request(); const u = new URL(req.url()); const m = req.method();
    const json = (status, b) => rt.fulfill({ status, contentType: 'application/json', body: b === undefined ? '' : JSON.stringify(b) });
    if (u.pathname.includes('/auth/v1/token')) return json(200, { access_token: 'x.eyJzdWIiOiJ1MSJ9.x', token_type:'bearer', expires_in:3600, expires_at:Math.floor(Date.now()/1000)+3600, refresh_token:'r', user:{id:'u1',email:'p@x.com',aud:'authenticated',role:'authenticated'} });
    if (u.pathname.includes('/auth/v1/')) return json(200, {});
    const table = u.pathname.split('/rest/v1/')[1];
    if (table === 'rpc/extend_recurring_jobs') {
      if (role !== 'admin') return json(200, 0);
      return json(200, module.exports.generate(db));
    }
    if (table === 'profiles') {
      const me = { id:'u1', email:'p@x.com', full_name: role==='admin'?'Prince':'Elaine', app_role: role, active: true };
      const other = { id:'other', email:'o@x.com', full_name: role==='admin'?'Elaine':'Prince', app_role: role==='admin'?'viewer':'admin', active: true };
      const list = filt([me, other], [...u.searchParams]);
      return json(200, (req.headers()['accept']||'').includes('vnd.pgrst.object') ? list[0] : list);
    }
    const single = (req.headers()['accept']||'').includes('vnd.pgrst.object');
    const wantRep = (req.headers()['prefer']||'').includes('return=representation');
    const params = [...u.searchParams];
    let rows = db[table];
    // viewer rules for demand notes (mirrors the RLS policies)
    if (table === 'demand_notes' && role !== 'admin' && m !== 'GET' && m !== 'HEAD') {
      if (m === 'DELETE') return json(204);                       // RLS: silently 0 rows
      if (m === 'PATCH') { const hit = filt(rows, params).filter(r => r.created_by === 'u1'); const body = JSON.parse(req.postData());
        for (const r of hit) Object.assign(r, body, { updated_by: 'u1', updated_at: new Date().toISOString() }); return json(204); }
    } else if (table === 'todos' && role !== 'admin' && m !== 'GET' && m !== 'HEAD') {
      // viewer rules for to-dos (mirror RLS): add in her own name; edit her own or ones for her; never delete
      if (m === 'DELETE') return json(204);
      if (m === 'PATCH') { const hit = filt(rows, params).filter(r => r.created_by === 'u1' || r.owner_id === 'u1'); const body = JSON.parse(req.postData());
        for (const r of hit) Object.assign(r, body, { updated_by: 'u1', updated_at: new Date().toISOString() }); return json(204); }
    } else if (m !== 'GET' && m !== 'HEAD' && role !== 'admin') return json(403, { code:'42501', message:'new row violates row-level security policy' });
    if (m === 'HEAD') { const n = filt(rows, params).length; return rt.fulfill({ status: 200, headers: { 'content-range': `0-${Math.max(n-1,0)}/${n}`, 'access-control-expose-headers': 'Content-Range', 'access-control-allow-origin': '*' }, body: '' }); }
    if (m === 'GET') { let r = sort(filt(rows, params), u.searchParams.get('order'));
      const off = Number(u.searchParams.get('offset') || 0), lim = u.searchParams.get('limit'); if (lim) r = r.slice(off, off + Number(lim)); return json(200, single ? r[0] : r); }
    if (m === 'POST') {
      let body = JSON.parse(req.postData()); body = Array.isArray(body) ? body : [body];
      const onConflict = u.searchParams.get('on_conflict');
      if (onConflict && /merge-duplicates/.test(req.headers()['prefer'] || '')) {
        const keys = onConflict.split(','); const fresh = [];
        for (const b of body) { const hit = rows.find(r => keys.every(k => String(r[k]) === String(b[k]))); if (hit) Object.assign(hit, b); else fresh.push(b); }
        body = fresh; if (!body.length) return json(201, []);
      }
      for (const b of body) { if (b.name && rows.some(r => r.name === b.name)) return json(409, { code:'23505', message:'duplicate key' }); }
      const now = new Date(Date.now() + seq).toISOString();
      const created = body.map(b => ({ id: uid(), active: true, created_at: now, ...(table === 'demand_notes' ? { created_by: 'u1', updated_by: 'u1', updated_at: now } : {}),
        ...(table === 'todos' ? { created_by: 'u1', owner_id: 'u1', status: 'todo', priority: 'normal', checklist: [], updated_at: now } : {}),
        ...(table === 'demand_progress' ? { created_by: 'u1' } : {}), ...b }));
      if (table === 'assignments') for (const a of created) { if (a.end_time && !a.start_time) return json(400, { code: '23514', message: 'violates check constraint' });
        const t = db.tasks.find(t => t.id === a.task_id);
        a.any_pump = !!a.any_pump; a.recurring_id = a.recurring_id ?? null; a.recurring_detached = !!a.recurring_detached;
        if (a.any_pump && !(t && t.allows_any_pump)) return json(400, { code: '23514', message: '"Any / mixed pump" is only allowed for repair-type tasks' });
        if (t && t.requires_pump && !a.pump_model_id && !a.any_pump) return json(400, { code: '23502', message: 'A pump model is required for this task' });
        if (t && t.requires_pump && !a.build_type_id) a.build_type_id = db.build_types.find(b => b.is_default).id; } rows.push(...created);
      return wantRep ? json(201, single ? created[0] : created) : json(201);
    }
    if (m === 'PATCH') { const body = JSON.parse(req.postData()); const hit = filt(rows, params);
      for (const b of Object.values(body)) {} for (const r of hit) Object.assign(r, body, table === 'demand_notes' ? { updated_by: 'u1', updated_at: new Date().toISOString() } : {}); return json(204); }
    if (m === 'DELETE') { const hit = filt(rows, params);
      for (const r of hit) { if (db.assignments.some(a => a.person_id === r.id || a.pump_model_id === r.id || a.task_id === r.id)) return json(409, { code:'23503', message:'violates foreign key constraint' }); }
      if (table === 'todos') for (const a of db.assignments) if (hit.some(r => r.id === a.todo_id)) a.todo_id = null;
      db[table] = rows.filter(r => !hit.includes(r)); return json(204); }
  };
};
module.exports.seed = seed;

// ---- Supabase Realtime (Phoenix protocol v2: [join_ref, ref, topic, event, payload])
module.exports.mockRealtime = async function (page) {
  const state = { sockets: [], joins: [] };
  await page.routeWebSocket(/realtime\/v1\/websocket/, (ws) => {
    state.sockets.push(ws);
    ws.onMessage((raw) => {
      let m; try { m = JSON.parse(String(raw)); } catch { return; }
      const [joinRef, ref, topic, event, payload] = m;
      if (event === 'phx_join') {
        const pc = (payload?.config?.postgres_changes || []).map((c, i) => ({ ...c, id: 1000 + i }));
        state.joins.push({ topic, joinRef, pc });
        ws.send(JSON.stringify([joinRef, ref, topic, 'phx_reply', { status: 'ok', response: { postgres_changes: pc } }]));
      } else if (ref) {
        ws.send(JSON.stringify([joinRef, ref, topic, 'phx_reply', { status: 'ok', response: {} }]));
      }
    });
  });
  state.push = (table, type, record) => {
    const j = state.joins.at(-1); if (!j) return false;
    const ids = j.pc.filter((c) => c.table === table).map((c) => c.id);
    const columns = Object.keys(record).map((name) => ({ name, type: 'text' }));
    const msg = [null, null, j.topic, 'postgres_changes', { ids, data: { type, table, schema: 'public', record, old_record: type === 'INSERT' ? null : { id: record.id }, columns, commit_timestamp: new Date().toISOString(), errors: null } }];
    state.sockets.at(-1).send(JSON.stringify(msg));
    return true;
  };
  return state;
};

// ---- port of public.extend_recurring_jobs (migration 005)
const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const fromIso = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
function matches(r, iso) {
  if (iso < r.start_date || (r.end_date && iso > r.end_date)) return false;
  const dow = ((fromIso(iso).getDay() + 6) % 7) + 1;
  if (r.pattern === 'daily') return true;
  if (r.pattern === 'workdays') return dow <= 5;
  if (!(r.weekdays || []).includes(dow)) return false;
  const sd = fromIso(r.start_date); const mon = new Date(sd.getFullYear(), sd.getMonth(), sd.getDate() - ((sd.getDay() + 6) % 7));
  return Math.floor(Math.round((fromIso(iso) - mon) / 864e5) / 7) % Math.max(r.interval_weeks || 1, 1) === 0;
}
module.exports.generate = function (db, untilDays = 84) {
  const now = new Date(); const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let added = 0;
  for (const r of db.recurring_jobs.filter((x) => x.active !== false && x.person_id)) {
    for (let i = 0; i <= untilDays; i++) {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i); const iso = isoOf(d);
      if (iso < r.start_date || (r.end_date && iso > r.end_date) || !matches(r, iso)) continue;
      if (db.recurring_exceptions.some((e) => e.recurring_id === r.id && e.skip_date === iso)) continue;
      if (db.absences.some((a) => a.person_id === r.person_id && iso >= a.start_date && iso <= a.end_date)) continue;
      if (!personWorks(db, r.person_id, iso)) continue;
      if (db.assignments.some((a) => a.recurring_id === r.id && a.recurring_date === iso)) continue;
      db.assignments.push({ id: 'g' + Math.random().toString(36).slice(2, 9), person_id: r.person_id, work_date: iso, task_id: r.task_id, pump_model_id: r.pump_model_id ?? null,
        any_pump: !!r.any_pump, pump_mix: r.pump_mix ?? null, build_type_id: r.build_type_id ?? null, qty_target: r.qty_target ?? null, notes: r.notes ?? null,
        start_time: r.start_time ?? null, end_time: r.end_time ?? null, end_date: null, background: r.background ?? null, equipment_id: r.equipment_id ?? null,
        recurring_id: r.id, recurring_date: iso, recurring_detached: false, created_at: new Date().toISOString() });
      added++;
    }
  }
  return added;
};

// ---- port of public.person_works (migration 008)
function personWorks(db, personId, iso) {
  const dow = ((new Date(iso + 'T12:00:00').getDay() + 6) % 7) + 1;
  const one = (db.person_day_hours || []).find((d) => d.person_id === personId && d.work_date === iso);
  if (one) return !!one.works;
  const asg = (db.person_work_patterns || []).filter((p) => p.person_id === personId && p.effective_from <= iso).sort((a, b) => (a.effective_from < b.effective_from ? 1 : -1))[0];
  const dayOf = (pid) => (db.work_pattern_days || []).find((d) => d.pattern_id === pid && d.weekday === dow);
  if (asg && dayOf(asg.pattern_id)) return !!dayOf(asg.pattern_id).works;
  const def = (db.work_patterns || []).find((p) => p.is_default);
  if (def && dayOf(def.id)) return !!dayOf(def.id).works;
  return dow <= 5;
}
