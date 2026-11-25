const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const mock = require('./mockdb.cjs');
// Office work, to-dos, production stages, completed units and manual planned quantities:
// office jobs (look, form, Day timeline, Today "Who's free"), to-dos (tabs, sections, checklist, "Schedule this",
// My to-dos, viewer rules), stages per pump model (Settings), per-stage progress on the note, "+ Log completed",
// "Edit planned", "Units done" on a job, Done automatically, weekly summary, Excel export, phone layout.
// Run:  npm run test:office   (needs Playwright + Chromium: npm i -D playwright && npx playwright install chromium)
// Uses an in-memory mock of Supabase (mockdb.cjs) — no real data is touched.
const root = process.argv[2] || 'dist-test', out = process.argv[3] || require('os').tmpdir();
const srv = http.createServer((q, r) => { let p = path.join(root, decodeURIComponent(q.url.split('?')[0])); if (p.endsWith('/')) p += 'index.html';
  fs.readFile(p, (e, d) => { if (e) { r.writeHead(404); return r.end(); } const ext = path.extname(p); r.writeHead(200, { 'content-type': { '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2' }[ext] || 'text/html' }); r.end(d); }); }).listen(5196);
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const add = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const now = new Date(); const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
// work on a weekday: today, or the next Monday at the weekend
let work = today; while (work.getDay() % 6 === 0) work = add(work, 1);
const W = iso(work); const mon = add(work, -((work.getDay() + 6) % 7)); const WEEK = iso(mon);
const D = (n) => iso(add(today, n));
const db = mock.seed();
const M = (n) => db.pump_models.find((m) => m.name === n).id, K = (n) => db.tasks.find((t) => t.name === n).id, B = (n) => db.build_types.find((t) => t.name === n).id;
db.people.push({ id: 'pA', name: 'Amira Khan', job_title: 'Senior assembler', active: true }, { id: 'pP', name: 'Prince Owusu', job_title: 'Production manager', active: true, user_id: 'u1' });
db.person_skills.push({ person_id: 'pA', pump_model_id: M('QPro 2000') }, { person_id: 'pA', pump_model_id: M('Simplex') });
// stages: QPro 2000 = Sub-assembly → Final assembly → Quality testing; Mediflex skips Final assembly
db.pump_model_stages.push(...['Sub-assembly', 'Final assembly', 'Quality testing'].map((t, i) => ({ pump_model_id: M('QPro 2000'), task_id: K(t), position: i + 1 })),
  ...['Sub-assembly', 'Functional test / calibration', 'Quality testing'].map((t, i) => ({ pump_model_id: M('Mediflex'), task_id: K(t), position: i + 1 })));
const ts = new Date(Date.now() - 2 * 86400000).toISOString();
const N = (id, model, type, qty, due, o = {}) => db.demand_notes.push({ id, pump_model_id: model && M(model), any_pump: false, build_type_id: type && B(type), quantity: qty, needed_by: due,
  priority: 'normal', comment: null, status: 'open', status_override: null, created_by: 'other', created_at: ts, updated_by: 'other', updated_at: ts, ...o });
N('nQ', 'QPro 2000', 'Production', 50, iso(add(mon, 4)), { comment: 'NHS framework order' });
N('nS', 'Simplex', 'Production', 5, D(-2), { comment: 'Leeds order' });
let n = 0;
const J = (p, d, t, o = {}) => db.assignments.push({ id: 'j' + (++n), person_id: p, work_date: d, pump_model_id: null, any_pump: false, pump_mix: null, task_id: K(t), build_type_id: null, qty_target: null,
  notes: null, background: null, start_time: null, end_time: null, end_date: null, equipment_id: null, recurring_id: null, recurring_date: null, recurring_detached: false, created_at: ts, ...o });
J('pA', W, 'Sub-assembly', { id: 'jSub', pump_model_id: M('QPro 2000'), build_type_id: B('Production'), qty_target: 20, qty_done: 5, demand_id: 'nQ', start_time: '13:00:00', end_time: '15:00:00' });
J('pA', W, 'Quality testing', { id: 'jQT', pump_model_id: M('QPro 2000'), build_type_id: B('Production'), qty_target: 10, demand_id: 'nQ', start_time: '15:00:00', end_time: '16:00:00' });
J('pA', W, 'Meetings', { id: 'jMeet', notes: 'Weekly production meeting', start_time: '09:00:00', end_time: '10:00:00' });
db.demand_stage_plans.push({ demand_id: 'nQ', task_id: K('Quality testing'), qty: 10 });
db.demand_progress.push({ id: 'lg1', demand_id: 'nQ', task_id: K('Quality testing'), qty: 2, work_date: D(-1), note: null, created_by: 'u1', created_at: ts },
  { id: 'lg2', demand_id: 'nS', task_id: null, qty: 1, work_date: D(-1), note: 'Saturday shift', created_by: 'u1', created_at: ts });
const TD = (id, title, o = {}) => db.todos.push({ id, title, details: null, due_date: null, priority: 'normal', owner_id: 'u1', status: 'todo', checklist: [],
  created_by: 'u1', updated_by: null, created_at: ts, updated_at: ts, ...o });
TD('tdA', 'Update QPro build instructions', { due_date: D(-1), priority: 'high', details: 'New valve step.',
  checklist: [{ text: 'Photos', done: true }, { text: 'Torque values', done: true }, { text: 'Valve step', done: false }, { text: 'Review', done: false }, { text: 'Publish', done: false }] });
TD('tdB', 'Write up supplier meetings', { due_date: D(3) });
TD('tdC', 'Order labels', { status: 'done' });
TD('tdO', 'Other person’s to-do', { owner_id: 'other', created_by: 'other' });
let fails = 0; const ok = (c, msg) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + msg); };
const BASE = 'http://localhost:5196/';
async function login(role, vp, opts = {}) {
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: vp, timezoneId: 'Europe/London' }); const pg = await ctx.newPage();
  const errs = []; pg.on('pageerror', (e) => errs.push(e.message));
  await pg.route('https://example.supabase.co/**', mock(role, db)); await mock.mockRealtime(pg);
  if (opts.at) await pg.clock.setFixedTime(opts.at);
  await pg.goto(BASE); await pg.fill('#email', 'p@x.com'); await pg.fill('#password', 'x'); await pg.click('button[type=submit]');
  await pg.waitForSelector('#main[data-loaded="1"]'); return { b, pg, errs };
}
const dlg = (pg) => pg.locator('dialog').last();
const settle = (pg, ms = 400) => pg.waitForTimeout(ms);
const card = (pg, id) => pg.locator(`.dcard[data-note="${id}"]`);
const tcard = (pg, id) => pg.locator(`.tcard[data-todo="${id}"]`);
async function sel(loc, text) { const v = await loc.locator('option', { hasText: text }).first().getAttribute('value'); await loc.selectOption(v); }
const selText = (loc) => loc.evaluate((s) => s.options[s.selectedIndex]?.textContent || '');
// screenshots without toasts over them
const shot = async (pg, name) => { await pg.addStyleTag({ content: '.toast-host{display:none!important}' }); await pg.screenshot({ path: out + '/' + name, fullPage: false }); };
const txt = async (loc) => (await loc.textContent()).replace(/\s+/g, ' ');

(async () => {
  // ---- app name + credit line (login page, then sidebar)
  { const b0 = await chromium.launch(); const p0 = await (await b0.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    await p0.route('https://example.supabase.co/**', mock('admin', db)); await mock.mockRealtime(p0);
    await p0.goto(BASE); await p0.waitForSelector('#email');
    ok(/Meditec Production Room Planning/.test(await p0.title()) && /Meditec Production Room Planning/.test(await p0.textContent('.login')), 'login: app name "Meditec Production Room Planning"');
    ok((await p0.textContent('.login-card .credit')).trim() === 'Built by Prince Tony', 'login: credit line under the form');
    await shot(p0, 'login-desktop.png'); await b0.close(); }
  let { b, pg, errs } = await login('admin', { width: 1440, height: 1000 });
  ok(/· Production Room Planning$/.test(await pg.title()) && (await pg.textContent('.brand-sub')).trim() === 'Production Room Planning', 'sidebar + tab title: "Production Room Planning"');
  ok((await pg.textContent('.side-foot .credit')).trim() === 'Built by Prince Tony' && await pg.locator('.side-foot .credit').isVisible(), 'sidebar footer: credit line');

  // ---- Settings: stages per pump model, task category
  await pg.goto(BASE + '#/settings'); await pg.waitForSelector('button[title="Production stages for QPro 2000"]');
  ok(/Stages \(3\)/.test(await pg.textContent('button[title="Production stages for QPro 2000"]')), 'Settings → Pump models: "Stages (3)" for QPro 2000');
  await pg.click('button[title="Production stages for Simplex"]'); await dlg(pg).waitFor();
  await dlg(pg).getByRole('button', { name: /Use the default/ }).click();
  ok(/Sub-assembly[\s\S]*Final assembly[\s\S]*Functional test[\s\S]*Quality testing/.test(await dlg(pg).locator('.stage-list').textContent()), 'default stages: Sub-assembly → Final assembly → Functional test / calibration → Quality testing');
  await dlg(pg).locator('.modal-actions .btn-primary').click(); await settle(pg);
  const simplexStages = db.pump_model_stages.filter((s) => s.pump_model_id === M('Simplex')).sort((a, c) => a.position - c.position).map((s) => db.tasks.find((t) => t.id === s.task_id).name);
  ok(simplexStages.join(' → ') === 'Sub-assembly → Final assembly → Functional test / calibration → Quality testing', 'Simplex stages saved in order: ' + simplexStages.join(' → '));
  // put Simplex back to no stages (its note then uses the "Counts as output" fallback)
  db.pump_model_stages = db.pump_model_stages.filter((s) => s.pump_model_id !== M('Simplex'));
  await pg.locator('.card', { hasText: 'Tasks' }).getByRole('button', { name: 'Edit' }).first().waitFor();
  const meetingsRow = pg.locator('li, tr', { hasText: 'Meetings' }).filter({ has: pg.getByRole('button', { name: 'Edit' }) }).last();
  await meetingsRow.getByRole('button', { name: 'Edit' }).click(); await dlg(pg).waitFor();
  ok(/Office/.test(await selText(dlg(pg).getByLabel('Category'))), 'task "Meetings": Category = Office / non-production');
  await dlg(pg).getByRole('button', { name: 'Cancel' }).click(); await settle(pg, 250);

  // ---- Demand card: stages, needed · planned · done · still to do
  await pg.goto(BASE + '#/demand'); await pg.waitForSelector('.dcard'); await settle(pg, 300);
  ok(await pg.locator('.demand-tabs').getByText('Pump demand').count() === 1 && await pg.locator('.demand-tabs').getByText('To-dos').count() === 1 && await pg.locator('.demand-tabs').getByText('All').count() === 1, 'tabs: Pump demand | To-dos | All');
  const q = await txt(card(pg, 'nQ'));
  ok(/50 needed · 20 planned · 2 done · 48 still to do/.test(q), 'QPro note: "50 needed · 20 planned · 2 done · 48 still to do" (last stage = Quality testing: 10 jobs + 10 manual; 2 logged)');
  ok(await card(pg, 'nQ').locator('.dc-progress .bar-planned').count() === 1 && await card(pg, 'nQ').locator('.dc-progress .bar-done').count() === 1, 'two-colour bar (planned + done)');
  ok(/10 from jobs/.test(await card(pg, 'nQ').locator('.dc-pl').getAttribute('title')) && /10 entered manually/.test(await card(pg, 'nQ').locator('.dc-pl').getAttribute('title')), 'hover shows planned = jobs + manual: ' + await card(pg, 'nQ').locator('.dc-pl').getAttribute('title'));
  const stages = await card(pg, 'nQ').locator('.dc-stages li').allTextContents();
  ok(stages.length === 3 && /Sub-assembly\s*20\/50 · 5 done/.test(stages[0]) && /Final assembly\s*0\/50/.test(stages[1]) && /Quality testing\s*20\/50 · 2 done/.test(stages[2]), 'mini bar per stage: ' + stages.join(' | '));
  const jobsTxt = await txt(card(pg, 'nQ').locator('.dc-jobs'));
  ok(/Sub-assembly × 20/.test(jobsTxt) && /5 done/.test(jobsTxt) && !/not counted/.test(jobsTxt), 'linked jobs show their stage and units done; no "not counted": ' + jobsTxt);
  ok(/Overdue 2 days — 4 still to do/.test(await txt(card(pg, 'nS'))), 'overdue note: "Overdue 2 days — 4 still to do" (1 logged; no stages → output task)');
  ok(/Saturday shift/.test(await txt(card(pg, 'nS').locator('.dc-logs'))) && /\+1 · Prince/.test(await txt(card(pg, 'nS').locator('.dc-logs'))), 'log history: "<day> · +1 · Prince — Saturday shift"');
  await shot(pg, 'office-demand-desktop.png');

  // + Log completed (default stage = the last one)
  await card(pg, 'nQ').getByRole('button', { name: '+ Log completed' }).click(); await dlg(pg).waitFor();
  ok(/Quality testing \(last stage\)/.test(await selText(dlg(pg).getByLabel('Stage'))), 'Log completed: stage defaults to the last stage');
  await dlg(pg).getByLabel('Quantity done').fill('3'); await dlg(pg).getByLabel('Note').fill('Finished after hours');
  await dlg(pg).locator('.modal-actions .btn-primary').click(); await settle(pg, 600);
  const lg = db.demand_progress.find((l) => l.qty === 3);
  ok(lg && lg.demand_id === 'nQ' && lg.task_id === K('Quality testing') && lg.note === 'Finished after hours', 'logged +3 at Quality testing (saved to demand_progress)');
  ok(/50 needed · 20 planned · 5 done · 45 still to do/.test(await txt(card(pg, 'nQ'))) && /\+3 · Prince/.test(await txt(card(pg, 'nQ').locator('.dc-logs'))), 'card updates: 5 done · 45 still to do; history "+3 · Prince"');

  // more than needed asks first; then Done automatically
  await card(pg, 'nS').getByRole('button', { name: '+ Log completed' }).click(); await dlg(pg).waitFor();
  await dlg(pg).getByLabel('Quantity done').fill('6'); await dlg(pg).locator('.modal-actions .btn-primary').click(); await settle(pg, 300);
  ok(/More than needed/.test(await dlg(pg).textContent()), 'completed above needed asks to confirm');
  await dlg(pg).locator('.modal-actions .btn-primary').click(); await settle(pg, 700);
  ok(await pg.locator('details.dsec .dcard[data-note="nS"]').count() === 1, 'last stage completed ≥ needed → Done automatically');

  // Edit planned (manual per stage)
  await card(pg, 'nQ').getByRole('button', { name: 'Edit planned' }).click(); await dlg(pg).waitFor();
  await dlg(pg).getByLabel('Sub-assembly planned manually').fill('30');
  ok(/50/.test(await dlg(pg).locator('tr', { hasText: 'Sub-assembly' }).locator('td').last().textContent()), 'Edit planned: total updates as you type (20 + 30)');
  await dlg(pg).locator('.modal-actions .btn-primary').click(); await settle(pg, 600);
  ok(db.demand_stage_plans.some((p) => p.demand_id === 'nQ' && p.task_id === K('Sub-assembly') && p.qty === 30), 'manual planned saved (Sub-assembly 30)');
  ok(/Sub-assembly\s*50\/50/.test((await card(pg, 'nQ').locator('.dc-stages li').allTextContents())[0]), 'Sub-assembly now 50/50 planned');

  // status: only Automatic / Done by hand
  await card(pg, 'nQ').getByRole('button', { name: 'Edit', exact: true }).click(); await dlg(pg).waitFor();
  const statusOpts = await dlg(pg).getByLabel('Status').locator('option').allTextContents();
  ok(statusOpts.length === 2 && /Automatic/.test(statusOpts[0]) && /Done/.test(statusOpts[1]), 'status: only "Automatic" or "Done (set by hand)" — ' + statusOpts.join(' | '));
  await dlg(pg).getByRole('button', { name: 'Cancel' }).click(); await settle(pg, 250);

  // ---- To-dos tab
  await pg.locator('.demand-tabs').getByText('To-dos').click(); await pg.waitForSelector('.tcard'); await settle(pg, 300);
  ok(await pg.locator('.dcard[data-note]').count() === 0 && await pg.locator('.tcard').count() >= 3, 'To-dos tab shows to-do cards only');
  const order = await pg.locator('[data-todos="todo"] .tcard').evaluateAll((els) => els.map((e) => e.dataset.todo));
  ok(order[0] === 'tdA', 'overdue to-do first: ' + order.join(','));
  ok(/2 \/ 5/.test(await txt(tcard(pg, 'tdA'))) && /Overdue/.test(await txt(tcard(pg, 'tdA'))), 'to-do card: checklist "2 / 5" and due words');
  ok(await pg.locator('details.tsec-done-wrap').evaluate((d) => !d.open), 'Done to-dos collapsed');
  await tcard(pg, 'tdA').locator('.td-check input').nth(2).check(); await settle(pg, 500);
  ok(db.todos.find((t) => t.id === 'tdA').checklist[2].done === true && /3 \/ 5/.test(await txt(tcard(pg, 'tdA'))), 'ticking a checklist item → 3 / 5');
  await pg.getByRole('button', { name: '+ New to-do' }).click(); await dlg(pg).waitFor();
  ok(/Prince \(me\)/.test(await selText(dlg(pg).getByLabel('Owner'))), 'new to-do: owner defaults to me');
  await dlg(pg).getByLabel('Title').fill('Ring the valve supplier'); await dlg(pg).getByLabel('Checklist').fill('Get price\nAsk lead time');
  await dlg(pg).locator('.modal-actions .btn-primary').click(); await settle(pg, 500);
  const nt = db.todos.find((t) => t.title === 'Ring the valve supplier');
  ok(nt && nt.owner_id === 'u1' && nt.checklist.length === 2 && nt.status === 'todo', 'to-do added (owner me, checklist of 2)');
  await tcard(pg, 'tdA').getByRole('button', { name: 'Start' }).click(); await settle(pg, 500);
  ok(db.todos.find((t) => t.id === 'tdA').status === 'in_progress' && await pg.locator('[data-todos="in_progress"] .tcard[data-todo="tdA"]').count() === 1, 'Start → In progress');
  await shot(pg, 'office-todos-desktop.png');

  // ---- Schedule this → Add work as an office job, linked
  await tcard(pg, 'tdB').getByRole('button', { name: 'Schedule this' }).click();
  await dlg(pg).waitFor(); await settle(pg, 300);
  const d = dlg(pg);
  ok(/Add work/.test(await d.locator('h2').textContent()) && await selText(d.getByLabel('Task / operation')) === 'Meetings', 'Schedule this: Add work with an office task (matched "meetings")');
  ok(await d.getByLabel('What are you working on?').inputValue() === 'Write up supplier meetings', 'notes = the to-do title, labelled "What are you working on?"');
  ok(!(await d.getByLabel('Pump model').isVisible()) && !(await d.getByLabel('Quantity target').isVisible()) && !(await d.getByLabel('Build type').isVisible()) && !(await d.getByLabel('Equipment / test station').isVisible()), 'office job hides pump model, build type, quantity and station');
  ok(/Prince/.test(await selText(d.getByLabel('Person'))), 'person = the to-do owner’s linked person');
  ok(await d.getByLabel('For to-do').inputValue() === 'tdB', 'linked to the to-do');
  await d.getByLabel('Start time').fill('10:30'); await d.getByLabel('Start time').press('Tab');
  await d.locator('.modal-actions .btn-primary').click(); await settle(pg, 700);
  for (let i = 0; i < 3 && await pg.locator('dialog[open]').count(); i++) { await dlg(pg).locator('.modal-actions .btn-primary').click(); await settle(pg, 400); }
  const sj = db.assignments.find((a) => a.todo_id === 'tdB');
  ok(sj && sj.task_id === K('Meetings') && sj.person_id === 'pP' && !sj.pump_model_id && sj.qty_target == null && sj.notes === 'Write up supplier meetings', 'office job saved: Meetings, Prince, no pump / quantity, linked');

  // ---- planner chips
  await pg.goto(BASE + `#/planner?week=${WEEK}`); await pg.waitForSelector('.planner'); await settle(pg, 300);
  const office = pg.locator('.chip.chip-office', { hasText: 'Weekly production meeting' }).first();
  ok(await office.count() === 1 && /💻/.test(await office.textContent()), 'planner: office job is a 💻 office chip');
  ok(await office.evaluate((e) => getComputedStyle(e).borderLeftColor) !== await pg.locator('.chip:not(.chip-office)').first().evaluate((e) => getComputedStyle(e).borderLeftColor), 'office chip has its own colour');
  ok(/× 20 · 5 done/.test(await txt(pg.locator('.chip', { hasText: 'Sub-assembly' }).first())), 'chip "× 20 · 5 done"');
  ok(await pg.locator('.chip .todo-tag').count() >= 1, 'chip linked to a to-do shows "☑ to-do"');
  ok(!/Weekly production meeting/.test(await pg.locator('#weekly-summary').textContent()), 'office jobs are not in the pump summary');
  const sumHead = await pg.locator('table.summary thead').textContent();
  ok(/Done/.test(sumHead) && /Still to do/.test(sumHead), 'weekly summary: "Done" and "Still to do" columns');
  const stageRow = await txt(pg.locator('table.summary tr.stage-row').first());
  ok(/Sub-assembly 50\/50 planned · 5 done/.test(stageRow) && /Quality testing 20\/50 planned · 5 done/.test(stageRow), 'weekly summary: planned / done per stage — ' + stageRow);
  await shot(pg, 'office-planner-desktop.png');

  // Units done on a job (admin)
  await pg.locator('.chip', { hasText: 'Sub-assembly' }).first().click(); await dlg(pg).waitFor();
  ok(await dlg(pg).getByLabel('Units done').inputValue() === '5', 'job form: "Units done" = 5');
  await dlg(pg).getByLabel('Units done').fill('8'); await dlg(pg).locator('.modal-actions .btn-primary').click(); await settle(pg, 600);
  for (let i = 0; i < 3 && await pg.locator('dialog[open]').count(); i++) { await dlg(pg).locator('.modal-actions .btn-primary').click(); await settle(pg, 400); }
  ok(db.assignments.find((a) => a.id === 'jSub').qty_done === 8, 'units done saved (8)');

  // Day timeline
  await pg.goto(BASE + `#/planner?view=day&day=${W}`); await pg.waitForSelector('.dt-job'); await settle(pg, 300);
  ok(/💻/.test(await pg.locator('.dt-job.dt-office').first().textContent()) && /Office — Meetings: Weekly production meeting/.test(await pg.locator('.dt-job.dt-office').first().getAttribute('title') + await pg.locator('.dt-job.dt-office').first().textContent()), 'Day timeline: office block "Office — Meetings: …" with 💻');

  // ---- Export
  await pg.goto(BASE + `#/planner?week=${WEEK}`); await pg.waitForSelector('.planner');
  await pg.getByRole('button', { name: 'Export to Excel' }).click(); await dlg(pg).getByLabel('Dates').waitFor();
  const [dl] = await Promise.all([pg.waitForEvent('download', { timeout: 60000 }), dlg(pg).getByText('Download .xlsx').click()]);
  const f = out + '/office-export.xlsx'; await dl.saveAs(f);
  const ExcelJS = require('exceljs'); const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(f);
  const sheetRows = (name) => { const ws = wb.getWorksheet(name); const head = ws.getRow(1).values.slice(1); const rows = []; ws.eachRow((r, i) => { if (i > 1) rows.push(r.values.slice(1)); }); return { head, rows, c: (r, h) => r[head.indexOf(h)] }; };
  const tsx = sheetRows('Timesheet');
  const meet = tsx.rows.find((r) => tsx.c(r, 'Task') === 'Meetings' && tsx.c(r, 'Person') === 'Amira Khan');
  ok(meet && tsx.c(meet, 'Category') === 'Office' && !tsx.c(meet, 'Pump model'), 'export Timesheet: Category "Office" for the meeting');
  ok(tsx.rows.some((r) => tsx.c(r, 'Task') === 'Sub-assembly' && tsx.c(r, 'Category') === 'Production' && tsx.c(r, 'Units done') === 8), 'export Timesheet: Production job with Units done');
  const spx = sheetRows('Summary by person'); const am = spx.rows.find((r) => r[0] === 'Amira Khan');
  ok(am && spx.c(am, 'Office / non-production (h)') === 1 && spx.c(am, 'Production (h)') === 3, `export Summary by person: production vs office hours (${am && spx.c(am, 'Production (h)')} / ${am && spx.c(am, 'Office / non-production (h)')})`);
  const tdx = sheetRows('To-dos');
  ok(tdx.rows.some((r) => tdx.c(r, 'To-do') === 'Update QPro build instructions' && tdx.c(r, 'Checklist') === '3 / 5' && tdx.c(r, 'Overdue') === 'Y') && tdx.rows.some((r) => tdx.c(r, 'To-do') === 'Write up supplier meetings' && /Prince/.test(tdx.c(r, 'Scheduled time blocks'))), 'export To-dos sheet (checklist, overdue, scheduled blocks)');
  const dmx = sheetRows('Demand'); const qx = dmx.rows.find((r) => r[0] === 'QPro 2000');
  ok(qx && dmx.c(qx, 'Completed') === 5 && dmx.c(qx, 'Still to do') === 45 && /Sub-assembly 50\/50 planned, 8 done/.test(dmx.c(qx, 'Stages (planned / done)')), 'export Demand: completed 5, still to do 45, stages — ' + (qx && dmx.c(qx, 'Stages (planned / done)')));
  const pux = sheetRows('Summary by pump'); const qp = pux.rows.find((r) => r[0] === 'QPro 2000');
  ok(qp && pux.c(qp, 'Completed (last stage)') === 5 && pux.c(qp, 'Still to do') === 45, 'export Summary by pump: Completed and Still to do');
  ok(errs.length === 0, 'no page errors ' + errs.join(';')); await b.close();

  // ---- Today: My to-dos, Who's free now ("Office — Meetings until 10:00"), progress
  ({ b, pg, errs } = await login('admin', { width: 1440, height: 1000 }, W === iso(today) ? { at: new Date(`${W}T09:20:00`) } : {}));
  await pg.goto(BASE + '#/today'); await pg.waitForSelector('.my-todos'); await settle(pg, 500);
  const mine = await pg.locator('.my-todos [data-todo]').evaluateAll((els) => els.map((e) => e.dataset.todo));
  ok(mine[0] === 'tdA' && !mine.includes('tdC') && !mine.includes('tdO') && mine.length <= 5, 'Today: My to-dos (mine, not done, overdue first): ' + mine.join(','));
  if (W === iso(today)) {
    const amira = pg.locator('li.who[data-person="pA"]');
    const t = (await amira.count()) ? (await amira.textContent()).replace(/\s+/g, ' ') : '';
    ok(await amira.locator('.pill-office').count() === 1, 'Who’s free now: Amira has the "Office" pill');
    ok(/Office/.test(t) && /Meetings: Weekly production meeting until 10:00/.test(t), 'Who’s free now: "Office — Meetings: Weekly production meeting until 10:00" — ' + t);
  } else console.log('SKIP Who’s free now (not a weekday)');
  ok(/completed · \d+ still to do/.test(await pg.locator('.glance').textContent()) || !/needed by Friday/.test(await pg.locator('.glance').textContent()), 'Today: completed · still to do by Friday');
  await shot(pg, 'office-today-desktop.png');
  ok(errs.length === 0, 'no page errors ' + errs.join(';')); await b.close();

  // ---- viewer (Elaine): sees progress, adds to-dos for Prince, cannot record or delete
  ({ b, pg, errs } = await login('viewer', { width: 390, height: 844 }));
  await pg.goto(BASE + '#/demand'); await pg.waitForSelector('.dcard'); await settle(pg, 300);
  ok(/still to do/.test(await txt(card(pg, 'nQ'))) && await card(pg, 'nQ').locator('.dc-stages li').count() === 3, 'viewer sees progress and stages');
  ok(await pg.getByRole('button', { name: '+ Log completed' }).count() === 0 && await pg.getByRole('button', { name: 'Edit planned' }).count() === 0, 'viewer: no "+ Log completed" / "Edit planned"');
  ok(await pg.evaluate(() => document.documentElement.scrollWidth) <= 390, 'phone: Demand page has no sideways scroll');
  await shot(pg, 'office-demand-phone.png');
  await pg.goto(BASE + '#/demand?tab=todos'); await pg.waitForSelector('.tcard'); await settle(pg, 300);
  ok(await pg.getByRole('button', { name: 'Delete' }).count() === 0 && await pg.getByRole('button', { name: 'Schedule this' }).count() === 0, 'viewer: no Delete, no Schedule this');
  ok(await tcard(pg, 'tdO').getByRole('button', { name: 'Edit' }).count() === 0 && await tcard(pg, 'tdB').getByRole('button', { name: 'Edit' }).count() === 1, 'viewer edits her own to-dos only');
  await pg.getByRole('button', { name: '+ New to-do' }).click(); await dlg(pg).waitFor();
  await dlg(pg).getByLabel('Title').fill('Check the rental returns'); await sel(dlg(pg).getByLabel('Owner'), 'Prince');
  await dlg(pg).locator('.modal-actions .btn-primary').click(); await settle(pg, 500);
  const vt = db.todos.find((t) => t.title === 'Check the rental returns');
  ok(vt && vt.owner_id === 'other' && vt.created_by === 'u1', 'viewer adds a to-do for Prince');
  ok(await pg.evaluate(() => document.documentElement.scrollWidth) <= 390, 'phone: To-dos tab has no sideways scroll');
  await shot(pg, 'office-todos-phone.png');
  await pg.goto(BASE + `#/planner?week=${WEEK}`); await pg.waitForSelector('.planner', { state: 'attached' }); await settle(pg, 500);
  ok(await pg.evaluate(() => document.documentElement.scrollWidth) <= 390, 'phone: planner has no sideways scroll');
  ok(errs.length === 0, 'no page errors ' + errs.join(';')); await b.close(); srv.close();
  console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
})().catch((e) => { console.error(e); process.exit(1); });
