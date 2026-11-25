const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const mock = require('./mockdb.cjs');
// Jobs over several days are ONE job: automatic split with "Undo · Edit", editing any part opens the
// whole job (no duplicate parts in work-time mode), moving the date / drag-and-drop / another person
// moves every part, "Adjust this part only", delete part / whole job, Copy last week, Duplicate,
// Settings → Planner ("When a job runs past finish time"), viewer can't drag.
// Run:  npm run test:parts   (needs Playwright + Chromium) — in-memory mock of Supabase (mockdb.cjs).
const root = process.argv[2] || 'dist-test', out = process.argv[3] || require('os').tmpdir();
const srv = http.createServer((q, r) => { let p = path.join(root, decodeURIComponent(q.url.split('?')[0])); if (p.endsWith('/')) p += 'index.html';
  fs.readFile(p, (e, d) => { if (e) { r.writeHead(404); return r.end(); } const ext = path.extname(p); r.writeHead(200, { 'content-type': { '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2' }[ext] || 'text/html' }); r.end(d); }); }).listen(5197);
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const add = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const now = new Date(); const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
const mon = add(today, 7 - ((today.getDay() + 6) % 7));          // next Monday: always in the future
const D = (i) => iso(add(mon, i));                                 // D(0) Mon … D(4) Fri; D(7) the Monday after
const WEEK = D(0), WEEK2 = D(7);
const day = (isoS) => { const [y, m, d] = isoS.split('-').map(Number); return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(y, m - 1, d).getDay()]; };
const db = mock.seed();
db.people.push({ id: 'pA', name: 'Amira Khan', job_title: 'Assembler', active: true }, { id: 'pB', name: 'Ben Carter', job_title: 'Assembler', active: true });
for (const p of ['pA', 'pB']) db.person_skills.push({ person_id: p, pump_model_id: db.pump_models.find((m) => m.name === 'QPro 2000').id });
db.absences.push({ id: 'abB', person_id: 'pB', start_date: D(1), end_date: D(1), absence_type: 'holiday', notes: null });   // Ben off on Tuesday
let fails = 0; const ok = (c, msg) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + msg); };
const BASE = 'http://localhost:5197/';
async function login(role, vp) {
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: vp, timezoneId: 'Europe/London' }); const pg = await ctx.newPage();
  const errs = []; pg.on('pageerror', (e) => errs.push(e.message));
  await pg.route('https://example.supabase.co/**', mock(role, db)); await mock.mockRealtime(pg);
  await pg.goto(BASE); await pg.fill('#email', 'p@x.com'); await pg.fill('#password', 'x'); await pg.click('button[type=submit]');
  await pg.waitForSelector('#main[data-loaded="1"]'); return { b, pg, errs };
}
const dlg = (pg) => pg.locator('dialog').last();
const settle = (pg, ms = 400) => pg.waitForTimeout(ms);
async function sel(loc, text) { const v = await loc.locator('option', { hasText: text }).first().getAttribute('value'); await loc.selectOption(v); }
const rowOf = (pg, id) => pg.locator(`.planner tbody tr[data-person="${id}"]`);
const cellOf = (pg, id, isoS) => rowOf(pg, id).locator(`td.day-cell[data-day="${isoS}"]`);
const chipIn = (pg, id, isoS) => cellOf(pg, id, isoS).locator('.chip').first();
const summary = async (pg) => (await dlg(pg).locator('.timing-summary').innerText()).replace(/\s+/g, ' ');
const lastToast = async (pg) => (await pg.locator('.toast').last().textContent()).replace(/\s+/g, ' ');
const toastAction = (pg, name) => pg.locator('.toast').last().getByRole('button', { name });
async function week(pg, w = WEEK) { await pg.goto(BASE + `#/planner?week=${w}`); await pg.waitForSelector('.planner'); await settle(pg, 300); }
async function save(pg) { await dlg(pg).locator('.modal-actions .btn-primary').click(); await settle(pg, 900); }
async function newJob(pg, person, isoS, start, work) {
  await cellOf(pg, person, isoS).getByText('+ Add').click(); await settle(pg, 200);
  await sel(dlg(pg).getByLabel('Task / operation'), 'Final assembly'); await sel(dlg(pg).getByLabel('Pump model'), 'QPro 2000');
  await dlg(pg).getByLabel('Quantity target').fill('4');
  await dlg(pg).getByLabel('Start time').fill(start);
  if (await dlg(pg).getByLabel('Work time').isHidden()) await dlg(pg).getByRole('button', { name: 'Work time' }).click();
  await dlg(pg).getByLabel('Work time').fill(work); await settle(pg, 700);
}
/** The job's rows in the mock database (part 1 first), as "Tue 15:00–16:30". */
const jobOf = (headId) => db.assignments.filter((a) => a.id === headId || a.part_of === headId).sort((a, b) => (a.part_of ? 1 : 0) - (b.part_of ? 1 : 0) || (a.work_date < b.work_date ? -1 : 1));
const txt = (rows) => rows.map((a) => `${day(a.work_date)} ${a.start_time.slice(0, 5)}–${a.end_time.slice(0, 5)}`).join(' · ');
const heads = (pid) => db.assignments.filter((a) => a.person_id === pid && !a.part_of);
const sameDay = (rows) => new Set(rows.map((a) => a.work_date)).size !== rows.length;

(async () => {
  let { b, pg, errs } = await login('admin', { width: 1440, height: 1000 });
  await week(pg);

  // ---- A. automatic split, notice with Undo · Edit
  await newJob(pg, 'pA', D(1), '15:00', '3h');
  ok(/continues over 2 working days/.test(await summary(pg)), 'form shows the automatic split before saving');
  await save(pg);
  ok(/Split into 2 parts: Tue 15:00–16:30 → Wed 08:30–10:00/.test(await lastToast(pg)), 'notice: "Split into 2 parts: Tue 15:00–16:30 → Wed 08:30–10:00" — ' + await lastToast(pg));
  let h = heads('pA')[0];
  ok(h && txt(jobOf(h.id)) === 'Tue 15:00–16:30 · Wed 08:30–10:00' && h.work_minutes === 180 && jobOf(h.id)[1].part_of === h.id, 'saved as one job: 2 parts, total 3h on part 1');
  await toastAction(pg, 'Undo').click(); await settle(pg, 900);
  ok(db.assignments.filter((a) => a.person_id === 'pA').length === 0, 'Undo after the auto-split removes both parts');
  await week(pg);
  await newJob(pg, 'pA', D(1), '15:00', '3h'); await save(pg);
  await toastAction(pg, 'Edit').click(); await settle(pg, 800);
  ok(/over 2 days/.test(await dlg(pg).locator('h2').textContent()), '"Edit" on the notice opens the whole job');
  await dlg(pg).getByRole('button', { name: 'Cancel' }).click(); await settle(pg, 300);
  h = heads('pA')[0]; const ids = jobOf(h.id).map((a) => a.id);

  // ---- B/C. open part 2 → the whole job; saving never adds a part (work-time mode bug)
  await week(pg);
  await chipIn(pg, 'pA', D(2)).click(); await settle(pg, 800);
  const d0 = dlg(pg);
  ok(/Edit job · over 2 days/.test(await d0.locator('h2').textContent()), 'opening part 2 opens the whole job');
  const plist = (await d0.locator('.parts-box').innerText()).replace(/\s+/g, ' ');
  ok(/total work time 3h/.test(plist) && /Part 1 · Tue \d+ \w+ 15:00–16:30/.test(plist) && /Part 2 · Wed \d+ \w+ 08:30–10:00/.test(plist) && /\(opened\)/.test(plist), 'form lists all parts and the total: ' + plist);
  await d0.locator('.parts-box').scrollIntoViewIfNeeded(); await pg.evaluate(() => document.querySelector('.toast-host')?.replaceChildren()); await pg.screenshot({ path: out + '/parts-form.png' });
  ok(await d0.getByLabel('Starts on').inputValue() === D(1) && await d0.getByLabel('Start time').inputValue() === '15:00' && await d0.getByLabel('Work time').inputValue() === '3h', 'form shows the job’s start (part 1) and the TOTAL work time');
  await save(pg);
  let rows = jobOf(h.id);
  ok(rows.length === 2 && rows.map((a) => a.id).join() === ids.join() && txt(rows) === 'Tue 15:00–16:30 · Wed 08:30–10:00', 'saving from part 2 keeps exactly 2 parts (same rows): ' + txt(rows));
  await chipIn(pg, 'pA', D(2)).click(); await settle(pg, 800);
  await dlg(pg).getByLabel('Work time').fill('4h'); await settle(pg, 400); await save(pg);
  rows = jobOf(h.id);
  ok(rows.length === 2 && rows.map((a) => a.id).join() === ids.join() && txt(rows) === 'Tue 15:00–16:30 · Wed 08:30–11:15' && rows[0].work_minutes === 240, 'total 3h → 4h from part 2: re-flows from the first start, still 2 parts: ' + txt(rows));
  ok(!sameDay(db.assignments.filter((a) => a.person_id === 'pA')), 'never two parts on one day');

  // ---- D. change the job's date (part 1 → Thu): every part moves
  await chipIn(pg, 'pA', D(1)).click(); await settle(pg, 800);
  await dlg(pg).getByLabel('Starts on').fill(D(3)); await dlg(pg).getByLabel('Starts on').dispatchEvent('change'); await settle(pg, 400); await save(pg);
  rows = jobOf(h.id);
  ok(txt(rows) === 'Thu 15:00–16:30 · Fri 08:30–11:15' && rows.map((a) => a.id).join() === ids.join(), 'moving part 1 to Thu moves part 2 too (Thu + Fri): ' + txt(rows));
  ok(db.assignments.filter((a) => a.person_id === 'pA' && a.work_date < D(3)).length === 0, 'no part left behind on the old days');

  // drag part 2 (Fri) to Wed: the whole job shifts two days earlier; Undo puts it back
  await chipIn(pg, 'pA', D(4)).dragTo(cellOf(pg, 'pA', D(2))); await settle(pg, 1200);
  rows = jobOf(h.id);
  ok(txt(rows) === 'Tue 15:00–16:30 · Wed 08:30–11:15', 'drag part 2 to Wed → whole job moves (Tue + Wed): ' + txt(rows));
  ok(/Moved — Split into 2 parts: Tue 15:00–16:30 → Wed 08:30–11:15/.test(await lastToast(pg)), 'notice after the drag: ' + await lastToast(pg));
  await toastAction(pg, 'Undo').click(); await settle(pg, 1000);
  ok(txt(jobOf(h.id)) === 'Thu 15:00–16:30 · Fri 08:30–11:15', 'Undo after the drag puts both parts back');
  await week(pg);
  // drag part 1 to Ben on Monday: Ben is off on Tuesday → part 2 goes to Wednesday
  await chipIn(pg, 'pA', D(3)).dragTo(cellOf(pg, 'pB', D(0))); await settle(pg, 1200);
  rows = jobOf(h.id);
  ok(rows.every((a) => a.person_id === 'pB') && txt(rows) === 'Mon 15:00–16:30 · Wed 08:30–11:15', 'drag to another person: every part moves to Ben, re-flowed around his day off: ' + txt(rows));
  await week(pg);

  // ---- notes / task apply to all parts
  await chipIn(pg, 'pB', D(2)).click(); await settle(pg, 800);
  await dlg(pg).getByLabel('Notes').fill('Valve batch'); await save(pg);
  ok(jobOf(h.id).every((a) => a.notes === 'Valve batch'), 'notes changed on part 2 apply to every part');

  // ---- Adjust this part only (re-flow), then shorten the total
  await chipIn(pg, 'pB', D(2)).click(); await settle(pg, 800);
  await dlg(pg).locator('.parts-list li').nth(1).getByRole('button', { name: 'Adjust this part only' }).click(); await settle(pg, 300);
  await dlg(pg).getByLabel('End').fill('09:30');
  await dlg(pg).locator('.modal-actions .btn-primary').click(); await settle(pg, 1000);
  await pg.keyboard.press('Escape'); await settle(pg, 300);
  rows = jobOf(h.id);
  ok(txt(rows) === 'Mon 15:00–16:30 · Wed 08:30–09:30 · Thu 08:30–10:00' && rows[1].part_locked === true, 'adjust part 2 to 08:30–09:30: the rest re-flows to Thursday to keep 4h; part 2 locked: ' + txt(rows));
  await week(pg);
  await chipIn(pg, 'pB', D(3)).click(); await settle(pg, 800);
  ok(/🔒/.test(await dlg(pg).locator('.parts-box').innerText()), 'the adjusted part shows 🔒 (set by hand)');
  await dlg(pg).getByLabel('Work time').fill('2h 30m'); await settle(pg, 400); await save(pg);
  rows = jobOf(h.id);
  ok(txt(rows) === 'Mon 15:00–16:30 · Wed 08:30–09:30', 'shorter total: the locked part stays, the part no longer needed is removed: ' + txt(rows));

  // ---- delete: this part only (Undo), then the whole job
  await week(pg);
  await chipIn(pg, 'pB', D(2)).click(); await settle(pg, 800);
  await dlg(pg).getByRole('button', { name: 'Delete' }).click(); await settle(pg, 300);
  ok(/part 2 of 2/.test(await dlg(pg).textContent()), 'delete asks "This part only / Whole job"');
  await dlg(pg).getByRole('button', { name: 'This part only' }).click(); await settle(pg, 1000);
  rows = jobOf(h.id);
  ok(rows.length === 1 && txt(rows) === 'Mon 15:00–16:30', 'this part only: part 1 stays');
  await toastAction(pg, 'Undo').click(); await settle(pg, 1000);
  ok(jobOf(h.id).length === 2, 'Undo brings the part back');
  await week(pg);
  await chipIn(pg, 'pB', D(0)).click(); await settle(pg, 800);
  await dlg(pg).getByRole('button', { name: 'Delete' }).click(); await settle(pg, 300);
  await dlg(pg).getByRole('button', { name: 'Whole job' }).click(); await settle(pg, 1000);
  ok(db.assignments.filter((a) => a.person_id === 'pB').length === 0, 'whole job: every part deleted');

  // ---- Copy last week: one job over two days is copied as one job, re-flowed
  await week(pg);
  await newJob(pg, 'pA', D(1), '15:00', '3h'); await save(pg);
  await week(pg, WEEK2);
  await pg.getByRole('button', { name: 'Copy last week' }).click(); await settle(pg, 300);
  ok(/run over several days: each is copied as one job/.test(await dlg(pg).textContent()), 'Copy last week explains whole jobs');
  await dlg(pg).locator('.modal-actions .btn-primary').click(); await settle(pg, 1200);
  const copied = heads('pA').filter((a) => a.work_date >= WEEK2);
  ok(copied.length === 1 && txt(jobOf(copied[0].id)) === 'Tue 15:00–16:30 · Wed 08:30–10:00' && copied[0].work_minutes === 180, 'copied as ONE job with 2 parts next week (no loose part 2): ' + (copied[0] && txt(jobOf(copied[0].id))));
  ok(db.assignments.filter((a) => a.person_id === 'pA' && a.work_date >= WEEK2).length === 2, 'exactly 2 rows next week');

  // ---- Duplicate keeps the total work time
  await week(pg, WEEK2);
  await chipIn(pg, 'pA', iso(add(mon, 8))).click(); await settle(pg, 800);
  await dlg(pg).getByRole('button', { name: 'Duplicate…' }).click(); await settle(pg, 500);
  ok(await dlg(pg).getByLabel('Work time').inputValue() === '3h', 'Duplicate starts with the job’s total work time (3h)');
  await dlg(pg).getByRole('checkbox', { name: /^Thu \d/ }).check(); await settle(pg, 500);
  await save(pg);
  const dup = heads('pA').find((a) => a.work_date === iso(add(mon, 10)));
  ok(dup && txt(jobOf(dup.id)) === 'Thu 15:00–16:30 · Fri 08:30–10:00', 'duplicate on Thu re-flows to Thu + Fri');

  // ---- Settings → Planner: "Allow overtime" keeps a job on one day
  await pg.goto(BASE + '#/settings'); await pg.waitForSelector('#settings-planner select'); await settle(pg, 300);
  await pg.locator('#settings-planner select').selectOption('overtime'); await settle(pg, 500);
  ok(db.app_settings[0].overflow_mode === 'overtime', 'Settings → Planner: "When a job runs past finish time" saved');
  await pg.locator('#settings-planner').screenshot({ path: out + '/parts-settings.png' });
  await week(pg);
  await newJob(pg, 'pB', D(3), '15:00', '3h');
  ok(/overtime/.test(await summary(pg)), '"Allow overtime": the form shows overtime, no split');
  await save(pg);
  const ot = heads('pB').find((a) => a.work_date === D(3));
  ok(ot && jobOf(ot.id).length === 1 && ot.end_time.startsWith('18:00'), 'saved on one day, 15:00–18:00');
  db.app_settings[0].overflow_mode = 'continue';
  await pg.evaluate(() => document.querySelector('.toast-host')?.replaceChildren()); await pg.screenshot({ path: out + '/parts-week.png' });
  ok(errs.length === 0, 'no page errors ' + errs.join(';')); await b.close();

  // ---- viewer: can open the job, can't drag
  ({ b, pg, errs } = await login('viewer', { width: 1440, height: 900 }));
  await week(pg, WEEK2);
  ok(await pg.locator('.chip[draggable="true"]').count() === 0, 'viewer: job chips can’t be dragged');
  ok(errs.length === 0, 'no page errors ' + errs.join(';')); await b.close(); srv.close();
  console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
})().catch((e) => { console.error(e); process.exit(1); });
