const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const mock = require('./mockdb.cjs');
// Completed units: corrections — Edit / Delete each logged entry (admin), negative corrections,
// "Set the total (adjust)", Undo on the notice, never below 0, status recalculated at once;
// units done on a job lowered / cleared; the viewer sees progress but can't change it.
// Run:  npm run test:corrections   (needs Playwright + Chromium) — in-memory mock of Supabase (mockdb.cjs).
const root = process.argv[2] || 'dist-test', out = process.argv[3] || require('os').tmpdir();
const srv = http.createServer((q, r) => { let p = path.join(root, decodeURIComponent(q.url.split('?')[0])); if (p.endsWith('/')) p += 'index.html';
  fs.readFile(p, (e, d) => { if (e) { r.writeHead(404); return r.end(); } const ext = path.extname(p); r.writeHead(200, { 'content-type': { '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2' }[ext] || 'text/html' }); r.end(d); }); }).listen(5198);
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const add = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const now = new Date(); const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
const D = (n) => iso(add(today, n));
const mon = add(today, -((today.getDay() + 6) % 7)); const WEEK = iso(mon);
const db = mock.seed();
const M = (n) => db.pump_models.find((m) => m.name === n).id, K = (n) => db.tasks.find((t) => t.name === n).id, B = (n) => db.build_types.find((t) => t.name === n).id;
db.people.push({ id: 'pA', name: 'Amira Khan', active: true });
const ts = new Date(Date.now() - 86400000).toISOString();
db.demand_notes.push({ id: 'n1', pump_model_id: M('QPro 2000'), any_pump: false, build_type_id: B('Production'), quantity: 10, needed_by: D(5), priority: 'normal',
  comment: 'NHS order', status: 'open', status_override: null, created_by: 'other', created_at: ts, updated_by: 'other', updated_at: ts });
db.demand_progress.push({ id: 'lg1', demand_id: 'n1', task_id: K('Final assembly'), qty: 6, work_date: D(-2), note: null, kind: 'log', created_by: 'u1', created_at: ts },
  { id: 'lg2', demand_id: 'n1', task_id: K('Final assembly'), qty: 4, work_date: D(-1), note: null, kind: 'log', created_by: 'u1', created_at: ts });
db.assignments.push({ id: 'jD', person_id: 'pA', work_date: iso(mon), task_id: K('Final assembly'), pump_model_id: M('QPro 2000'), any_pump: false, pump_mix: null, build_type_id: B('Production'),
  qty_target: 5, qty_done: 3, demand_id: 'n1', notes: null, background: null, start_time: '09:00:00', end_time: '10:00:00', end_date: null, equipment_id: null,
  recurring_id: null, recurring_date: null, recurring_detached: false, part_of: null, created_at: ts });
let fails = 0; const ok = (c, msg) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + msg); };
const BASE = 'http://localhost:5198/';
async function login(role, vp) {
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: vp, timezoneId: 'Europe/London' }); const pg = await ctx.newPage();
  const errs = []; pg.on('pageerror', (e) => errs.push(e.message));
  await pg.route('https://example.supabase.co/**', mock(role, db)); await mock.mockRealtime(pg);
  await pg.goto(BASE); await pg.fill('#email', 'p@x.com'); await pg.fill('#password', 'x'); await pg.click('button[type=submit]');
  await pg.waitForSelector('#main[data-loaded="1"]'); return { b, pg, errs };
}
const dlg = (pg) => pg.locator('dialog').last();
const settle = (pg, ms = 500) => pg.waitForTimeout(ms);
const card = (pg) => pg.locator('.dcard[data-note="n1"]');
const txt = async (loc) => (await loc.textContent()).replace(/\s+/g, ' ');
const toastAction = (pg, name) => pg.locator('.toast').last().getByRole('button', { name });
const doneSum = () => db.demand_progress.filter((l) => l.demand_id === 'n1').reduce((t, l) => t + l.qty, 0) + (db.assignments.find((a) => a.id === 'jD').qty_done || 0);
async function demand(pg) {
  await pg.goto(BASE + '#/demand'); await pg.waitForSelector('.dcard[data-note="n1"]', { state: 'attached' }); await settle(pg, 300);
  await pg.evaluate(() => document.querySelectorAll('details.dsec').forEach((d) => { d.open = true; })); await settle(pg, 200);   // Done is collapsed
}
async function openLog(pg) { await card(pg).getByRole('button', { name: '+ Log completed' }).click(); await dlg(pg).waitFor(); }

(async () => {
  let { b, pg, errs } = await login('admin', { width: 1440, height: 1000 });
  await demand(pg);
  ok(/10 needed · 5 planned · 13 done · 0 still to do/.test(await txt(card(pg))) && await pg.locator('details.dsec .dcard[data-note="n1"]').count() === 1, 'start: 13 done (6 + 4 logged + 3 on a job) → Done');
  ok(await card(pg).locator('.dc-logs li[data-log]').count() === 2 && await card(pg).locator('.dc-logs').getByRole('button', { name: /^Edit entry/ }).count() === 2
    && await card(pg).locator('.dc-logs').getByRole('button', { name: /^Delete entry/ }).count() === 2, 'each logged entry has Edit and Delete (admin)');

  // negative correction → status recalculates at once; Undo on the notice
  await openLog(pg);
  await dlg(pg).getByLabel('Quantity done').fill('-5'); await dlg(pg).getByLabel('Note').fill('counted twice');
  await dlg(pg).locator('.modal-actions .btn-primary').click(); await settle(pg, 800);
  const corr = db.demand_progress.find((l) => l.qty === -5);
  ok(corr && corr.kind === 'correction' && corr.note === 'counted twice', 'negative entry saved as a correction ("−5, counted twice")');
  ok(/8 done · 2 still to do/.test(await txt(card(pg))) && await pg.locator('details.dsec .dcard[data-note="n1"]').count() === 0, 'completed 8 → no longer Done (recalculated at once)');
  ok(/↺/.test(await card(pg).locator('.dc-logs li.log-neg').evaluate((e) => getComputedStyle(e, '::before').content)) && /−5 · Prince — counted twice/.test(await txt(card(pg).locator('.dc-logs'))), 'history shows "−5 · Prince — counted twice" (correction)');
  await toastAction(pg, 'Undo').click(); await settle(pg, 800);
  ok(!db.demand_progress.some((l) => l.qty === -5) && /13 done/.test(await txt(card(pg))), 'Undo on the notice removes the entry: 13 done again');

  // can't go below 0
  await openLog(pg);
  await dlg(pg).getByLabel('Quantity done').fill('-20');
  await dlg(pg).locator('.modal-actions .btn-primary').click(); await settle(pg, 300);
  ok(/can’t go below 0 — Final assembly has 13 done/.test(await dlg(pg).locator('.form-error').textContent()), 'below 0 refused: "Completed can’t go below 0 — Final assembly has 13 done"');
  // adjust: set the total directly (recorded as the difference)
  await dlg(pg).getByLabel('Set the total (adjust)').check();
  ok(/New total at Final assembly/.test(await dlg(pg).locator('label', { hasText: 'New total' }).textContent()), 'adjust mode: "New total at Final assembly"');
  await dlg(pg).getByLabel(/New total/).fill('9');
  await dlg(pg).locator('.modal-actions .btn-primary').click(); await settle(pg, 800);
  const adj = db.demand_progress.find((l) => l.kind === 'adjust');
  ok(adj && adj.qty === -4 && /Adjusted from 13 to 9/.test(adj.note) && doneSum() === 9, 'adjust to 9: recorded as −4 ("Adjusted from 13 to 9")');
  ok(/9 done · 1 still to do/.test(await txt(card(pg))), 'card: 9 done · 1 still to do');

  // edit an entry
  await card(pg).locator('.dc-logs li[data-log="lg1"]').getByRole('button', { name: /^Edit entry/ }).click(); await dlg(pg).waitFor();
  ok(await dlg(pg).getByLabel('Quantity').inputValue() === '6', 'edit opens with the entry’s quantity');
  await dlg(pg).getByLabel('Quantity').fill('7'); await dlg(pg).getByLabel('Note').fill('recounted');
  await dlg(pg).locator('.modal-actions .btn-primary').click(); await settle(pg, 800);
  ok(db.demand_progress.find((l) => l.id === 'lg1').qty === 7 && db.demand_progress.find((l) => l.id === 'lg1').note === 'recounted' && /10 done/.test(await txt(card(pg))), 'entry edited 6 → 7: 10 done → Done again');
  ok(await pg.locator('details.dsec .dcard[data-note="n1"]').count() === 1, 'status back to Done automatically');

  // delete an entry (asks first), Undo re-adds it
  await card(pg).locator('.dc-logs li[data-log="lg2"]').getByRole('button', { name: /^Delete entry/ }).click(); await settle(pg, 300);
  ok(/Delete this entry\?/.test(await dlg(pg).textContent()) && /goes down by 4/.test(await dlg(pg).textContent()), 'delete asks first ("the completed total goes down by 4")');
  await dlg(pg).locator('.modal-actions .btn-danger, .modal-actions .btn-primary').last().click(); await settle(pg, 800);
  ok(!db.demand_progress.some((l) => l.id === 'lg2') && /6 done/.test(await txt(card(pg))), 'entry deleted: 6 done');
  await toastAction(pg, 'Undo').click(); await settle(pg, 800);
  ok(db.demand_progress.some((l) => l.qty === 4 && l.demand_id === 'n1') && /10 done/.test(await txt(card(pg))), 'Undo re-adds the deleted entry');

  // units done on a job: lowered / cleared (Clear button)
  await pg.goto(BASE + `#/planner?week=${WEEK}`); await pg.waitForSelector('.planner'); await settle(pg, 300);
  await pg.locator('.chip', { hasText: '3 done' }).first().click(); await dlg(pg).waitFor(); await settle(pg, 300);
  ok(await dlg(pg).getByLabel('Units done').inputValue() === '3', 'job form: units done 3');
  await dlg(pg).getByRole('button', { name: 'Clear' }).click();
  await dlg(pg).locator('.modal-actions .btn-primary').click(); await settle(pg, 800);
  for (let i = 0; i < 2 && await pg.locator('dialog[open]').count(); i++) { await dlg(pg).locator('.modal-actions .btn-primary').click(); await settle(pg, 400); }
  ok(db.assignments.find((a) => a.id === 'jD').qty_done === null, 'units done cleared on the job');
  await demand(pg);
  ok(/7 done · 3 still to do/.test(await txt(card(pg))), 'note recalculated: 7 done · 3 still to do');
  await pg.evaluate(() => document.querySelector('.toast-host')?.replaceChildren()); await pg.screenshot({ path: out + '/corrections-card.png' });
  ok(errs.length === 0, 'no page errors ' + errs.join(';')); await b.close();

  // viewer: sees progress and history, can't change it
  ({ b, pg, errs } = await login('viewer', { width: 390, height: 844 }));
  await demand(pg);
  ok(/7 done/.test(await txt(card(pg))) && await card(pg).locator('.dc-logs li[data-log]').count() >= 2, 'viewer sees progress and the history');
  ok(await card(pg).locator('.dc-logs button').filter({ hasText: /Edit|Delete/ }).count() === 0 && await card(pg).getByRole('button', { name: '+ Log completed' }).count() === 0, 'viewer: no Edit / Delete / Log completed');
  ok(await pg.evaluate(() => document.documentElement.scrollWidth) <= 390, 'phone: no sideways scroll');
  await pg.evaluate(() => document.querySelector('.toast-host')?.replaceChildren()); await pg.screenshot({ path: out + '/corrections-phone.png' });
  ok(errs.length === 0, 'no page errors ' + errs.join(';')); await b.close(); srv.close();
  console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
})().catch((e) => { console.error(e); process.exit(1); });
