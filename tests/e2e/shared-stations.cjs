const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const mock = require('./mockdb.cjs');
// Shared stations: overlapping jobs on a "Simultaneous" test-area station (Quality Check) or a
// station marked "Can be shared" get NO double-booking warning (only capacity / per-model limits warn);
// "One at a time" stations (Medicare / Mediflex bench) and ordinary equipment still warn.
// Checked on chips, tooltips, the Day timeline, the job form, Settings and the Today page.
// Run:  npm run test:shared   (needs Playwright + Chromium: npm i -D playwright && npx playwright install chromium)
// Uses an in-memory mock of Supabase (mockdb.cjs) — no real data is touched.
const root = process.argv[2] || 'dist-test', out = process.argv[3] || require('os').tmpdir();
const srv = http.createServer((q, r) => { let p = path.join(root, decodeURIComponent(q.url.split('?')[0])); if (p.endsWith('/')) p += 'index.html';
  fs.readFile(p, (e, d) => { if (e) { r.writeHead(404); return r.end(); } const ext = path.extname(p); r.writeHead(200, { 'content-type': { '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2' }[ext] || 'text/html' }); r.end(d); }); }).listen(5194);
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


const E = (n) => db.equipment.find((e) => e.name === n).id;
db.equipment.push({ id: 'eqA1', name: 'Assembly 1', notes: null, test_area_id: null, shareable: true, active: true, sort_order: 40 },
  { id: 'eqA2', name: 'Assembly 2', notes: null, test_area_id: null, shareable: false, active: true, sort_order: 50 });
for (const p of ['pA', 'pB', 'pC', 'pD', 'pE']) for (const m of ['QPro 2000', 'Mediflex', 'Medicare']) db.person_skills.push({ person_id: p, pump_model_id: M(m) });
const t = (s) => s + ':00';
// Quality Check (Simultaneous, max 7): three overlapping jobs → 9/7 only from 10:30
J('pA', T, 'QPro 2000', 'Quality testing', 'Production', 3, { id: 'qc1', start_time: t('09:00'), end_time: t('11:00'), equipment_id: E('Quality Check') });
J('pB', T, 'QPro 2000', 'Quality testing', 'Production', 3, { id: 'qc2', start_time: t('10:00'), end_time: t('12:00'), equipment_id: E('Quality Check') });
J('pC', T, 'QPro 2000', 'Quality testing', 'Production', 3, { id: 'qc3', start_time: t('10:30'), end_time: t('11:30'), equipment_id: E('Quality Check') });
// Medicare / Mediflex bench (One at a time): overlap still warns
J('pE', T, 'Mediflex', 'Quality testing', 'Customer', 2, { id: 'b1', start_time: t('13:00'), end_time: t('14:00'), equipment_id: E('Medicare / Mediflex test bench') });
J('pD', T, 'Medicare', 'Quality testing', 'Customer', 1, { id: 'b2', start_time: t('13:30'), end_time: t('14:30'), equipment_id: E('Medicare / Mediflex test bench') });
// Test rig 1 (not linked, not shared): warns
J('pA', T, 'QPro 2000', 'Final assembly', 'Production', 1, { id: 'r1', start_time: t('14:00'), end_time: t('15:00'), equipment_id: E('Test rig 1') });
J('pB', T, 'QPro 2000', 'Final assembly', 'Production', 1, { id: 'r2', start_time: t('14:30'), end_time: t('15:30'), equipment_id: E('Test rig 1') });
// Assembly 1 (Can be shared): no warning · Assembly 2 (not shared): warns
J('pA', T, 'QPro 2000', 'Final assembly', 'Production', 1, { id: 'a1', start_time: t('11:30'), end_time: t('12:30'), equipment_id: 'eqA1' });
J('pC', T, 'QPro 2000', 'Final assembly', 'Production', 1, { id: 'a1b', start_time: t('11:45'), end_time: t('12:15'), equipment_id: 'eqA1' });
J('pB', T, 'QPro 2000', 'Final assembly', 'Production', 1, { id: 'a2', start_time: t('08:30'), end_time: t('09:30'), equipment_id: 'eqA2' });
J('pD', T, 'QPro 2000', 'Final assembly', 'Production', 1, { id: 'a2b', start_time: t('09:00'), end_time: t('10:00'), equipment_id: 'eqA2' });
let fails = 0; const ok = (c, msg) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + msg); };
const BASE = 'http://localhost:5194/';
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


const ALSO = /is also booked for/;
const chipTitle = async (pg, id) => {
  const job = db.assignments.find((a) => a.id === id);
  const who = db.people.find((p) => p.id === job.person_id).name;
  const chips = pg.locator(`.planner tbody tr[data-person="${job.person_id}"] td.day-cell`).nth(dayIdx).locator('.chip');
  for (let i = 0; i < await chips.count(); i++) {
    const tt = await chips.nth(i).getAttribute('title');
    if (tt && tt.includes(job.start_time.slice(0, 5))) return { tt, warn: await chips.nth(i).evaluate((e) => e.classList.contains('chip-warn')), who };
  }
  return { tt: '', warn: false, who };
};
(async () => {
  const isWeekday = today.getDay() % 6 !== 0;
  if (!isWeekday) { console.log('weekend: the seeded day is not shown in the planner — run on a weekday'); srv.close(); return; }
  let { b, pg, errs } = await login('admin', { width: 1440, height: 1000 });
  await pg.goto(BASE + '#/planner'); await pg.waitForSelector('.planner'); await settle(pg, 500);
  // ---- chips + tooltips
  for (const id of ['qc1', 'qc2']) {
    const c = await chipTitle(pg, id);
    const warnLines = c.tt.split('\n').filter((l) => l.startsWith('⚠'));
    ok(!ALSO.test(c.tt) && warnLines.length > 0 && warnLines.every((l) => /^⚠ Test capacity — /.test(l)), `Quality Check ${id}: no "also booked" — its only ⚠ are capacity limits (9/7 at 10:30, QPro 9/7)`);
  }
  const qc3 = await chipTitle(pg, 'qc3');
  ok(!ALSO.test(qc3.tt) && /Test capacity — Quality Check: 9\/7 pumps at 10:30/.test(qc3.tt) && qc3.warn, 'Quality Check over its limit: ⚠ for capacity (9/7) only, not double-booking');
  ok(/Equipment: Quality Check \(shared — up to 7 pumps\)/.test(qc3.tt), 'tooltip: "Equipment: Quality Check (shared — up to 7 pumps)"');
  for (const id of ['b1', 'b2']) {
    const c = await chipTitle(pg, id);
    ok(/Medicare \/ Mediflex test bench is also booked for/.test(c.tt) && c.warn && /\(one at a time\)/.test(c.tt), `bench ${id} (one at a time): overlap still warns`);
  }
  for (const id of ['r1', 'r2']) ok(/Test rig 1 is also booked for/.test((await chipTitle(pg, id)).tt), `Test rig 1 ${id}: not shared → "also booked"`);
  for (const id of ['a1', 'a1b']) {
    const c = await chipTitle(pg, id);
    ok(!ALSO.test(c.tt) && !c.warn && /Assembly 1 \(can be shared\)/.test(c.tt), `Assembly 1 ${id} ("Can be shared"): no double-booking warning`);
  }
  for (const id of ['a2', 'a2b']) ok(/Assembly 2 is also booked for/.test((await chipTitle(pg, id)).tt), `Assembly 2 ${id} (not shared): "also booked"`);
  await pg.screenshot({ path: out + '/shared-week.png', clip: { x: 0, y: 0, width: 1440, height: 1000 } });
  // ---- job form
  await pg.locator('.planner tbody tr[data-person="pE"] td.day-cell').nth(dayIdx).getByText('+ Add').click(); await settle(pg, 200);
  await sel(dlg(pg).getByLabel('Task / operation'), 'Quality testing'); await sel(dlg(pg).getByLabel('Pump model'), 'QPro 2000');
  await dlg(pg).getByLabel('Quantity target').fill('1');
  await dlg(pg).getByLabel('Start time').fill('09:00'); await dlg(pg).getByLabel('End time').fill('10:00');
  await sel(dlg(pg).getByLabel('Equipment / test station'), 'Quality Check'); await settle(pg, 200);
  let w = (await dlg(pg).locator('.warn-box').allTextContents()).join(' | ');
  ok(!ALSO.test(w), 'form: booking Quality Check while others use it — no "also booked" warning' + (w ? ` (${w})` : ''));
  await dlg(pg).locator('.modal-actions .btn-primary').click(); await settle(pg, 600);
  ok(!/Save anyway/.test(await pg.locator('dialog').last().textContent().catch(() => '')) && db.assignments.some((a) => a.person_id === 'pE' && a.start_time === '09:00' && a.equipment_id === E('Quality Check')), 'form: saved straight away (no "Save anyway?")');
  await closeAll(pg);
  await pg.locator('.planner tbody tr[data-person="pE"] td.day-cell').nth(dayIdx).getByText('+ Add').click(); await settle(pg, 200);
  await sel(dlg(pg).getByLabel('Task / operation'), 'Final assembly'); await sel(dlg(pg).getByLabel('Pump model'), 'QPro 2000');
  await dlg(pg).getByLabel('Start time').fill('14:15'); await dlg(pg).getByLabel('End time').fill('14:45');
  await sel(dlg(pg).getByLabel('Equipment / test station'), 'Test rig 1'); await settle(pg, 200);
  w = (await dlg(pg).locator('.warn-box').allTextContents()).join(' | ');
  ok(/Test rig 1 is also booked for/.test(w), 'form: ordinary equipment still warns ("Test rig 1 is also booked for …")');
  await sel(dlg(pg).getByLabel('Equipment / test station'), 'Medicare / Mediflex test bench'); await settle(pg, 200);
  w = (await dlg(pg).locator('.warn-box').allTextContents()).join(' | ');
  ok(/Medicare \/ Mediflex test bench is also booked for/.test(w), 'form: the one-at-a-time bench still warns');
  await pg.keyboard.press('Escape'); await settle(pg);
  // ---- day timeline tooltips
  await pg.goto(BASE + `#/planner?view=day&day=${T}`); await pg.waitForSelector('.dt-grid'); await settle(pg, 300);
  const dtTitle = async (pid, start) => pg.locator(`.dt-row[data-person="${pid}"] .dt-job`, { hasText: start }).first().getAttribute('title');
  ok(!ALSO.test(await dtTitle('pA', '09:00')) && /Test rig 1 is also booked/.test(await dtTitle('pA', '14:00')), 'Day timeline: Quality Check job no double-booking ⚠; Test rig 1 job warns');
  // ---- settings: mark Assembly 2 as shareable
  await pg.goto(BASE + '#/settings'); await pg.waitForSelector('.ref-list'); await settle(pg, 300);
  const eqCard = pg.locator('section.card', { hasText: '+ Add equipment item' });
  ok(/⇄ can be shared/.test(await eqCard.locator('li', { hasText: 'Assembly 1' }).textContent()) && !/can be shared/.test(await eqCard.locator('li', { hasText: 'Assembly 2' }).textContent()), 'Settings: "⇄ can be shared" shown on Assembly 1 only');
  await eqCard.locator('li', { hasText: 'Assembly 2' }).getByText('Edit').click(); await settle(pg, 150);
  ok(!(await dlg(pg).getByLabel(/^Can be shared/).isChecked()), 'Settings: "Can be shared" is off by default');
  await dlg(pg).getByLabel(/^Can be shared/).check(); await dlg(pg).locator('.modal-actions .btn-primary').click(); await settle(pg, 600);
  ok(db.equipment.find((e) => e.id === 'eqA2').shareable === true, 'Settings: Assembly 2 set to "Can be shared"');
  await pg.goto(BASE + '#/planner'); await pg.waitForSelector('.planner'); await settle(pg, 400);
  ok(!ALSO.test((await chipTitle(pg, 'a2')).tt), 'planner: Assembly 2 overlap no longer warns');
  // ---- today page
  await pg.goto(BASE + '#/today'); await pg.waitForSelector('.tl'); await settle(pg, 500);
  const tips = await pg.$$eval('.tl .tjob', (els) => els.map((e) => e.dataset.tip || ''));
  const qcTips = tips.filter((x) => /Quality Check \(shared/.test(x));
  const rigTips = tips.filter((x) => /Equipment: Test rig 1/.test(x));
  ok(qcTips.length >= 3 && qcTips.every((x) => !ALSO.test(x)), 'Today: Quality Check jobs show "shared — up to 7 pumps" and no double-booking ⚠');
  ok(rigTips.length === 2 && rigTips.every((x) => /⚠ Test rig 1 is also booked for/.test(x)), 'Today: Test rig 1 overlap warned (same rule as the planner)');
  await pg.screenshot({ path: out + '/shared-today.png', fullPage: false });
  ok(errs.length === 0, 'no page errors ' + errs.join(';')); await b.close(); srv.close();
  console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
})().catch((e) => { console.error(e); process.exit(1); });
