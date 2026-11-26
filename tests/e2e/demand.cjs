const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const mock = require('./mockdb.cjs');
// Demand linked to jobs: "Plan this", "Covers demand", planned quantity from linked jobs,
// automatic status (Needs planning / Partly / Fully planned / Done) with override, "Planned too late",
// sections + card layout, planner panel, Today top 5, weekly summary, Excel export, viewer, phone.
// Run:  npm run test:demand   (needs Playwright + Chromium: npm i -D playwright && npx playwright install chromium)
// Uses an in-memory mock of Supabase (mockdb.cjs) — no real data is touched.
const root = process.argv[2] || 'dist-test', out = process.argv[3] || require('os').tmpdir();
const srv = http.createServer((q, r) => { let p = path.join(root, decodeURIComponent(q.url.split('?')[0])); if (p.endsWith('/')) p += 'index.html';
  fs.readFile(p, (e, d) => { if (e) { r.writeHead(404); return r.end(); } const ext = path.extname(p); r.writeHead(200, { 'content-type': { '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2' }[ext] || 'text/html' }); r.end(d); }); }).listen(5195);
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const add = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const now = new Date(); const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
const mon = add(today, -((today.getDay() + 6) % 7)); const T = iso(today); const dayIdx = (today.getDay() + 6) % 7;
const nextWorkday = iso(add(today, today.getDay() === 5 ? 3 : today.getDay() === 6 ? 2 : 1));
const db = mock.seed();
const M = (n) => db.pump_models.find((m) => m.name === n).id, K = (n) => db.tasks.find((t) => t.name === n).id, B = (n) => db.build_types.find((t) => t.name === n).id;
db.people.push({ id: 'pA', name: 'Amira Khan', job_title: 'Senior assembler', active: true }, { id: 'pB', name: 'Ben Carter', job_title: 'Test technician', active: true },
  { id: 'pC', name: 'Chloe Davies', job_title: 'Assembler', active: true }, { id: 'pD', name: 'Dan Hughes', job_title: 'QC & packing', active: true }, { id: 'pE', name: 'Priya Patel', job_title: 'Apprentice', active: true });
for (const [p, m] of [['pA', 'QPro 2000'], ['pC', 'Simplex'], ['pD', 'MediAir'], ['pD', 'Medicare'], ['pB', 'Mediflex'], ['pB', 'Medicare']]) db.person_skills.push({ person_id: p, pump_model_id: M(m) });
let n = 0;
const J = (p, d, m, t, b, q, o = {}) => db.assignments.push({ id: 'j' + (++n), person_id: p, work_date: d, pump_model_id: m && M(m), any_pump: false, pump_mix: null, task_id: K(t), build_type_id: b && B(b), qty_target: q,
  notes: null, background: null, start_time: null, end_time: null, end_date: null, equipment_id: null, recurring_id: null, recurring_date: null, recurring_detached: false, created_at: '2026-11-20T09:00:00Z', ...o });



const D = (n) => iso(add(today, n));
const isWd = (d) => d.getDay() % 6 !== 0;
let sug = add(today, 1); while (!isWd(sug)) sug = add(sug, -1); // working day before "today + 2"
const dueQ = D(2); let s0 = add(today, 1); while (!isWd(s0)) s0 = add(s0, -1); if (iso(s0) < T) { s0 = today; while (!isWd(s0)) s0 = add(s0, 1); }
const suggested = iso(s0);
const ts = new Date(Date.now() - 2 * 86400000).toISOString();
const N = (id, model, type, qty, due, o = {}) => db.demand_notes.push({ id, pump_model_id: model && M(model), any_pump: false, build_type_id: type && B(type), quantity: qty, needed_by: due,
  priority: 'normal', comment: null, status: 'open', status_override: null, created_by: 'other', created_at: ts, updated_by: 'other', updated_at: ts, ...o });
N('nS', 'Simplex', 'Production', 5, D(-2), { comment: 'Leeds order' });
N('nQ', 'QPro 2000', 'Production', 10, dueQ, { priority: 'high', comment: 'NHS order — ten QPro 2000 units.\nPlease build them before Friday.\nThe customer collects on Friday afternoon.\nCall Sam if anything changes.' });
N('nM', 'MediAir', 'Production', 4, D(1));
N('nT', 'QPro 2000', 'Trial', 3, D(5), { comment: 'Trial units for the new valve', created_by: 'u1' });
N('nL', 'Mediflex', 'Customer', 2, D(1), { comment: 'Hospital loan' });
N('nD', 'Bari-Med 1', 'Production', 1, D(3), { status: 'done', status_override: 'done', comment: 'Already sent' });
N('nP', 'Medicare', 'Customer', 2, D(3), { comment: 'Built last week' });
J('pD', T, 'MediAir', 'Final assembly', 'Production', 4, { id: 'jM', demand_id: 'nM' });
J('pA', T, 'QPro 2000', 'Final assembly', 'Trial', 1, { id: 'jT', demand_id: 'nT' });
J('pB', D(2), 'Mediflex', 'Final assembly', 'Customer', 2, { id: 'jL', demand_id: 'nL' });
J('pB', D(-2), 'Medicare', 'Final assembly', 'Customer', 2, { id: 'jP', demand_id: 'nP', qty_done: 2 }); // both units done
J('pA', T, 'QPro 2000', 'Quality testing', 'Trial', 9, { id: 'jQT', demand_id: 'nT' }); // testing: not "counts as output"
let fails = 0; const ok = (c, msg) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + msg); };
const BASE = 'http://localhost:5195/';
async function login(role, vp) {
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: vp, timezoneId: 'Europe/London' }); const pg = await ctx.newPage();
  const errs = []; pg.on('pageerror', (e) => errs.push(e.message));
  await pg.route('https://example.supabase.co/**', mock(role, db)); await mock.mockRealtime(pg);
  await pg.goto(BASE); await pg.fill('#email', 'p@x.com'); await pg.fill('#password', 'x'); await pg.click('button[type=submit]');
  await pg.waitForSelector('#main[data-loaded="1"]'); return { b, pg, errs };
}
const dlg = (pg) => pg.locator('dialog').last();
const settle = (pg, ms = 400) => pg.waitForTimeout(ms);
const row = (pg, name) => pg.locator('.planner tbody tr:not(.cap-row)', { hasText: name });
const cellOf = (pg, name) => row(pg, name).locator('td.day-cell').nth(dayIdx);
async function sel(loc, text) { const v = await loc.locator('option', { hasText: text }).first().getAttribute('value'); await loc.selectOption(v); }
async function closeAll(pg) { for (let i = 0; i < 4 && await pg.locator('dialog').count(); i++) { const primary = dlg(pg).locator('.modal-actions .btn-primary'); if (await primary.count()) await primary.click(); await settle(pg, 350); } }



const section = (pg, key) => pg.locator(`.dsec[data-section="${key}"] .dcard`);
const card = (pg, id) => pg.locator(`.dcard[data-note="${id}"]`);
(async () => {
  let { b, pg, errs } = await login('admin', { width: 1440, height: 1000 });
  await pg.goto(BASE + '#/demand'); await pg.waitForSelector('.dsec'); await settle(pg, 300);
  // ---- sections + automatic status
  const counts = await pg.$$eval('.dsec-title', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
  ok(/Needs planning 2/.test(counts[0]) && /Partly planned 1/.test(counts[1]) && /Fully planned 2/.test(counts[2]) && /Done 2/.test(counts[3]), 'sections with counts: ⚠ Needs planning 2 · ◐ Partly 1 · ✓ Fully 2 · Done 2 — ' + counts.join(' | '));
  ok(await pg.locator('details.dsec').evaluate((d) => !d.open), 'Done is collapsed');
  ok(JSON.stringify(await section(pg, 'open').evaluateAll((els) => els.map((e) => e.dataset.note))) === JSON.stringify(['nS', 'nQ']), 'sorted: overdue first (Simplex), then by needed-by');
  ok(/3 needed · 1 planned/.test(await card(pg, 'nT').textContent()) && /Partly planned/.test(await card(pg, 'nT').textContent()), 'partly planned "3 needed · 1 planned" (no stages set: the output task is the last stage, so the quality-testing job is not counted)');
  ok(/4 needed · 4 planned/.test(await card(pg, 'nM').textContent()) && /Fully planned/.test(await card(pg, 'nM').textContent()), 'fully planned "4 needed · 4 planned"');
  ok(await pg.locator('details.dsec .dcard[data-note="nP"]').count() === 1, 'units done on the linked job ≥ needed → Done automatically');
  ok(/⚠ Planned too late — /.test(await card(pg, 'nL').textContent()), '"⚠ Planned too late — <day>" when a linked job finishes after the needed-by date');
  ok(await card(pg, 'nM').evaluate((e) => Number(getComputedStyle(e).opacity) < 1) && await card(pg, 'nQ').evaluate((e) => getComputedStyle(e).opacity === '1'), 'fully planned notes faded; open ones stand out');
  // ---- card layout (order) + due words + comment
  const order = await card(pg, 'nQ').evaluate((e) => [...e.children].map((c) => c.className.split(' ')[0]));
  ok(order.join(',') === 'dc-head,dc-need,dc-progress,dc-meta,dc-comment,dc-actions', 'card order: model + type · needed by · progress · priority + who · comment · actions — ' + order.join(','));
  ok(/10 needed by/.test(await card(pg, 'nQ').locator('.dc-need').textContent()) && /In 2 days/.test(await card(pg, 'nQ').locator('.due-words').textContent()), '"10 needed by <day>" + "In 2 days"');
  ok(/Overdue 2 days/.test(await card(pg, 'nS').locator('.due-words').textContent()) && await card(pg, 'nS').locator('.due-words.due-overdue').count() === 1 && /Due tomorrow/.test(await card(pg, 'nM').textContent()), 'due words coloured by urgency: "Overdue 2 days", "Due tomorrow"');
  ok(/High/.test(await card(pg, 'nQ').locator('.dc-meta').textContent()) && /Asked by Elaine · 2 days ago/.test(await card(pg, 'nQ').locator('.dc-meta').textContent()), 'priority tag and who asked + when');
  const cmt = card(pg, 'nQ').locator('.dc-comment');
  const h1 = await cmt.evaluate((e) => e.getBoundingClientRect().height); await cmt.click(); await settle(pg, 100);
  ok(h1 < 50 && await cmt.evaluate((e) => e.getBoundingClientRect().height) > h1 + 10, 'comment shows 2 lines, expands on click');
  ok(/Amira · Final assembly × 1/.test(await card(pg, 'nT').locator('.dc-jobs').textContent()), 'linked jobs listed: "<day> · Amira · Final assembly × 1"');
  // ---- hide fully planned
  await pg.getByText('Hide fully planned').click(); await settle(pg);
  ok(await pg.locator('.dsec[data-section="planned"]').count() === 0, '"Hide fully planned" toggle');
  await pg.getByText('Hide fully planned').click(); await settle(pg);
  // ---- override + back to automatic
  await card(pg, 'nT').getByText('Mark done').click(); await settle(pg);
  ok(db.demand_notes.find((n) => n.id === 'nT').status_override === 'done' && await pg.locator('details.dsec .dcard[data-note="nT"]').count() === 1, 'override: Mark done moves it to Done');
  await pg.locator('details.dsec summary').click(); await settle(pg);
  await card(pg, 'nT').getByText('Back to automatic').click(); await settle(pg);
  ok(db.demand_notes.find((n) => n.id === 'nT').status_override === null && await section(pg, 'partly').count() === 1, 'Back to automatic → Partly planned again');
  await pg.screenshot({ path: out + '/demand-page.png', fullPage: true });
  // ---- nav badge
  ok((await pg.locator('.nav-count').first().textContent()) === '1', 'overdue badge counts notes not done (1)');
  // ---- Plan this → planner, pre-filled, linked
  await card(pg, 'nQ').getByRole('button', { name: 'Plan this' }).click();
  await pg.waitForSelector('dialog'); await settle(pg, 300);
  const d = dlg(pg);
  const selText = async (label) => d.getByLabel(label).evaluate((s) => s.options[s.selectedIndex].text);
  ok(/Add work/.test(await d.locator('h2').textContent()) && await selText('Task / operation') === 'Final assembly' && await selText('Pump model') === 'QPro 2000' && await selText('Build type') === 'Production' && await d.getByLabel('Quantity target').inputValue() === '10',
    'Plan this: Add work pre-filled — Final assembly, QPro 2000, Production, quantity still needed (10)');
  ok(await d.getByLabel('Covers demand').inputValue() === 'nQ', 'Plan this: linked to the note ("Covers demand")');
  const ticked = await d.locator('fieldset').first().locator('input:checked').count();
  ok(ticked === 1 && (await pg.evaluate(() => location.hash)).includes('planner'), `suggested date before the needed-by date is ticked (${suggested})`);
  ok(await selText('Person') === 'Amira Khan', 'suggests a person trained on the model with the most free time');
  await d.getByLabel('Start time').fill('');
  await d.locator('.modal-actions .btn-primary').click(); await settle(pg, 700); await closeAll(pg);
  const planned = db.assignments.find((a) => a.demand_id === 'nQ');
  ok(planned && planned.qty_target === 10 && planned.work_date === suggested && planned.person_id === 'pA', 'job saved, linked to the note');
  // ---- Covers demand from the job form
  await pg.goto(BASE + '#/planner'); await pg.waitForSelector('.planner'); await settle(pg, 300);
  await pg.locator('.planner tbody tr[data-person="pC"] td.day-cell').nth(dayIdx % 5).getByText('+ Add').click(); await settle(pg, 200);
  await sel(dlg(pg).getByLabel('Task / operation'), 'Final assembly'); await sel(dlg(pg).getByLabel('Pump model'), 'Simplex'); await settle(pg, 150);
  const opts = await dlg(pg).getByLabel('Covers demand').locator('option').allTextContents();
  ok(opts.length === 2 && /Simplex · Production × 5 · by .* · 0\/5 planned · Elaine/.test(opts[1]), '"Covers demand" lists open notes for that pump: ' + opts[1]);
  await dlg(pg).getByLabel('Covers demand').selectOption('nS'); await dlg(pg).getByLabel('Quantity target').fill('3'); await dlg(pg).getByLabel('Start time').fill('');
  await dlg(pg).locator('.modal-actions .btn-primary').click(); await settle(pg, 700); await closeAll(pg);
  ok(db.assignments.some((a) => a.demand_id === 'nS' && a.qty_target === 3), 'job saved covering the Simplex note');
  ok(await pg.locator('.chip .demand-tag').count() >= 1, 'planner chip shows "📋 demand"');
  // planner panel: only Needs planning / Partly planned, with Plan this
  const panel = pg.locator('.demand-panel:not(.recurring-panel)');
  const titles = await panel.locator('.dpanel-title').allTextContents();
  ok(titles.length === 1 && /Partly planned \(2\)/.test(titles[0]) && !/Fully|Needs/.test(titles.join()), 'planner panel: only notes still to plan (Partly planned 2; the fully planned QPro note has left) — ' + titles.join(' | '));
  ok(await panel.getByRole('button', { name: 'Plan this' }).count() >= 2, 'planner panel: "Plan this" buttons');
  // weekly summary uses the linked quantities (the week the QPro note is due, so it counts as "demand due")
  // (a note due on a weekend counts in the following week: the summary counts demand due by Friday)
  { const dq = new Date(`${dueQ}T12:00:00`); const wk = iso(add(dq, dq.getDay() === 6 ? 2 : dq.getDay() === 0 ? 1 : 0));
    await pg.goto(BASE + `#/planner?week=${wk}`); await pg.waitForSelector('table.summary'); await settle(pg, 300); }
  const sumTxt = await pg.locator('table.summary').textContent();
  ok(/Planned for it/.test(sumTxt) && /Still to plan/.test(sumTxt), 'weekly summary: "Planned for it" and "Still to plan" columns');
  const qRow = (await pg.$$eval('table.summary tr', (rows) => rows.map((r) => [...r.children].map((c) => c.textContent.trim()).join(' | ')))).find((r) => /QPro 2000 \| Production/.test(r)) || '';
  ok(/\| 10 \| 10 \| ✓ 0 \|/.test(qRow), 'summary: QPro Production demand 10, planned for it 10, still to plan ✓ 0 — ' + qRow);
  await pg.screenshot({ path: out + '/demand-planner.png', clip: { x: 0, y: 0, width: 1440, height: 1000 } });
  // ---- demand page after planning
  await pg.goto(BASE + '#/demand'); await pg.waitForSelector('.dsec'); await settle(pg, 300);
  ok(/10 needed · 10 planned/.test(await card(pg, 'nQ').textContent()) && await section(pg, 'planned').locator('[data-note="nQ"]').count() + (await pg.locator('.dsec[data-section="planned"] .dcard[data-note="nQ"]').count()) >= 1, 'after Plan this: QPro note fully planned (10 / 10)');
  ok(/5 needed · 3 planned/.test(await card(pg, 'nS').textContent()) && /Partly planned/.test(await card(pg, 'nS').textContent()), 'Simplex note partly planned (3 / 5)');
  // ---- Today: top 5 most urgent
  await pg.goto(BASE + '#/today'); await pg.waitForSelector('.urgent-demand'); await settle(pg, 400);
  const urgent = await pg.locator('.urgent-demand .dc-row').evaluateAll((els) => els.map((e) => e.dataset.note));
  ok(urgent.length >= 2 && urgent.length <= 5 && urgent[0] === 'nS' && !urgent.includes('nQ'), 'Today: most urgent first (overdue Simplex); fully planned not listed — ' + urgent.join(','));
  ok(urgent.includes('nL'), 'Today: a note planned too late is still listed');
  // ---- export: Demand sheet
  await pg.goto(BASE + '#/planner'); await pg.waitForSelector('.planner');
  await pg.getByRole('button', { name: 'Export to Excel' }).click(); await dlg(pg).getByLabel('Dates').waitFor();
  await sel(dlg(pg).getByLabel('Dates'), 'Custom'); await dlg(pg).getByLabel('From').fill(D(-3)); await dlg(pg).getByLabel('To').fill(D(6));
  const [dl] = await Promise.all([pg.waitForEvent('download', { timeout: 60000 }), dlg(pg).getByText('Download .xlsx').click()]);
  const f = out + '/demand-export.xlsx'; await dl.saveAs(f);
  const ExcelJS = require('exceljs'); const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(f);
  const dm = wb.getWorksheet('Demand'); const rows = []; dm.eachRow((r, i) => { if (i > 1) rows.push(r.values.slice(1)); });
  const dh = dm.getRow(1).values.slice(1); const c = (r, name) => r[dh.indexOf(name)];
  const q = rows.find((r) => r[0] === 'QPro 2000' && r[1] === 'Production');
  const l = rows.find((r) => r[0] === 'Mediflex');
  ok(q && c(q, 'Needed') === 10 && c(q, 'Planned (jobs + manual)') === 10 && c(q, 'Still to plan') === 0 && c(q, 'Completed') === 0 && c(q, 'Still to do') === 10
    && /Fully planned/.test(c(q, 'Status')) && /Amira Final assembly ×10/.test(c(q, 'Linked jobs')), 'export Demand sheet: needed 10, planned 10, still to plan 0, completed 0, still to do 10, linked job listed');
  ok(l && c(l, 'Planned too late (finishes)') instanceof Date, 'export: "Planned too late" date for the Mediflex note');
  const pu = wb.getWorksheet('Summary by pump'); const head = pu.getRow(1).values.slice(1);
  ok(head.includes('Built for demand notes (linked)'), 'export Summary by pump: linked column');
  ok(errs.length === 0, 'no page errors ' + errs.join(';')); await b.close();
  // ---- viewer (manager): read-only cards, can post / edit own notes
  ({ b, pg, errs } = await login('viewer', { width: 390, height: 844 }));
  await pg.goto(BASE + '#/demand'); await pg.waitForSelector('.dsec'); await settle(pg, 300);
  ok(await pg.getByRole('button', { name: 'Plan this' }).count() === 0, 'viewer: no "Plan this"');
  ok(await card(pg, 'nQ').getByRole('button').count() === 0 && await card(pg, 'nT').getByRole('button', { name: 'Edit' }).count() === 1 && await card(pg, 'nT').getByRole('button', { name: 'Delete' }).count() === 0, 'viewer: others’ notes read-only; own note: Edit, no Delete');
  await pg.getByText('+ New note').click(); await settle(pg, 150);
  await sel(dlg(pg).getByLabel('Pump model'), 'Simplex'); await dlg(pg).getByLabel('Quantity').fill('6'); await dlg(pg).getByLabel('Comment').fill('Six more Simplex please');
  await dlg(pg).locator('.modal-actions .btn-primary').click(); await settle(pg, 500);
  ok(db.demand_notes.some((n) => n.comment === 'Six more Simplex please' && n.created_by === 'u1'), 'viewer posts a note');
  ok(await pg.evaluate(() => document.documentElement.scrollWidth) <= 390, 'phone: no sideways scroll on the Demand page');
  await pg.screenshot({ path: out + '/demand-phone.png', fullPage: false });
  ok(errs.length === 0, 'no page errors ' + errs.join(';')); await b.close(); srv.close();
  console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
})().catch((e) => { console.error(e); process.exit(1); });
