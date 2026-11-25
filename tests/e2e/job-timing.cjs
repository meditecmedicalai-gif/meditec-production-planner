const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const mock = require('./mockdb.cjs');
// Job timing: "Ends on" only for multi-day jobs, pause for breaks (10:00 + 2h → 12:15),
// each person's own start / finish (continue next working day, overtime, shorten, move to start),
// attended multi-day jobs counted in working hours only, and the Excel export.
// Run:  npm run test:timing   (needs Playwright + Chromium: npm i -D playwright && npx playwright install chromium)
// Uses an in-memory mock of Supabase (mockdb.cjs) — no real data is touched.
const root = process.argv[2] || 'dist-test', out = process.argv[3] || require('os').tmpdir();
const srv = http.createServer((q, r) => { let p = path.join(root, decodeURIComponent(q.url.split('?')[0])); if (p.endsWith('/')) p += 'index.html';
  fs.readFile(p, (e, d) => { if (e) { r.writeHead(404); return r.end(); } const ext = path.extname(p); r.writeHead(200, { 'content-type': { '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2' }[ext] || 'text/html' }); r.end(d); }); }).listen(5193);
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

const D = (i) => iso(add(mon, i));
db.people.push({ id: 'pI', name: 'Irwin Walsh', job_title: 'Assembler', active: true });
db.person_skills.push({ person_id: 'pI', pump_model_id: M('QPro 2000') }, { person_id: 'pI', pump_model_id: M('Simplex') });
// the reported bug: a 10:00–11:00 job saved with "Ends on" the next day
J('pI', D(0), 'QPro 2000', 'Final assembly', 'Production', 1, { id: 'bug', start_time: '10:00:00', end_time: '11:00:00', end_date: D(1) });
// Thursday: busy 08:30–09:30 → next free slot 09:30
J('pI', D(3), 'QPro 2000', 'Final assembly', 'Production', 1, { start_time: '08:30:00', end_time: '09:30:00' });
// attended multi-day job for Dan: Mon 14:00 → Wed 10:00
J('pD', D(0), 'MediAir', 'Final assembly', 'Production', 2, { id: 'multi', start_time: '14:00:00', end_time: '10:00:00', end_date: D(2) });
// Irwin is absent next Monday; leaving at 14:00 on Wednesday (one-off)
db.absences.push({ id: 'abI', person_id: 'pI', start_date: D(7), end_date: D(7), absence_type: 'holiday', notes: null });
db.person_day_hours.push({ id: 'dhI', person_id: 'pI', work_date: D(2), works: true, start_time: null, end_time: '14:00:00', break_time: null, break_minutes: null, lunch_time: null, lunch_minutes: null, notes: null });
let fails = 0; const ok = (c, msg) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + msg); };
const BASE = 'http://localhost:5193/';
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

const rowOf = (pg, id) => pg.locator(`.planner tbody tr[data-person="${id}"]`);
const summary = async (pg) => (await dlg(pg).locator('.timing-summary').innerText()).replace(/\s+/g, ' ');
async function openAdd(pg, id, day) { await rowOf(pg, id).locator('td.day-cell').nth(day).getByText('+ Add').click(); await settle(pg, 150); }
async function setWork(pg, start, work) {
  await dlg(pg).getByLabel('Start time').fill(start);
  if (await dlg(pg).getByLabel('Work time').isHidden()) await dlg(pg).getByRole('button', { name: 'Work time' }).click();
  await dlg(pg).getByLabel('Work time').fill(work); await settle(pg, 150);
}
async function fillJob(pg) { await sel(dlg(pg).getByLabel('Task / operation'), 'Final assembly'); await sel(dlg(pg).getByLabel('Pump model'), 'QPro 2000'); await dlg(pg).getByLabel('Quantity target').fill('2'); }

(async () => {
  let { b, pg, errs } = await login('admin', { width: 1440, height: 1000 });
  await pg.goto(BASE + `#/planner?week=${D(0)}`); await pg.waitForSelector('.planner'); await settle(pg, 500);
  // ---- 1. "Ends on" bug
  const bugChip = rowOf(pg, 'pI').locator('td.day-cell').nth(0).locator('.chip').first();
  ok(/10:00 → 11:00 next day/.test(await bugChip.textContent()), 'reported job shows "10:00 → 11:00 next day" (Ends on set to the next day)');
  await bugChip.click(); await settle(pg, 200);
  ok(await dlg(pg).getByLabel('Runs over several days').isChecked() && await dlg(pg).getByLabel('Ends on').isVisible() && /Multi-day/.test(await summary(pg)), 'form makes it clear: "Runs over several days" ticked, Ends on shown, "⇢ Multi-day" summary');
  await dlg(pg).locator('.multi-day-box').getByRole('button', { name: 'Clear' }).click(); await settle(pg, 150);
  { const smc = await summary(pg); ok(await dlg(pg).getByLabel('Ends on').isHidden() && /Irwin · Mon 10:00–11:00 \(incl\. 15 min break\) · within hours ✓/.test(smc), 'Clear → one-day job again: "Irwin · Mon 10:00–11:00 (incl. 15 min break) · within hours ✓" — ' + smc); }
  await dlg(pg).locator('.modal-actions .btn-primary').click(); await settle(pg, 700); await closeAll(pg);
  ok(db.assignments.find((a) => a.id === 'bug').end_date === null && !/next day/.test(await rowOf(pg, 'pI').locator('td.day-cell').nth(0).locator('.chip').first().textContent()), 'saved without an end date: "10:00 → 11:00"');
  await openAdd(pg, 'pI', 1);
  ok(await dlg(pg).getByLabel('Ends on').isHidden() && !(await dlg(pg).getByLabel('Runs over several days').isChecked()), 'new job: "Ends on" hidden and empty by default (only for multi-day jobs)');
  await dlg(pg).getByLabel('Start time').focus(); await pg.keyboard.press('Tab'); await pg.keyboard.press('ArrowUp'); await settle(pg, 100);
  ok(await dlg(pg).getByLabel('Ends on').inputValue() === '', 'tabbing / arrow keys can no longer put a date in "Ends on" by accident');
  await pg.keyboard.press('Escape'); await settle(pg);
  // ---- 3. default start = next free slot
  await openAdd(pg, 'pI', 3);
  ok(await dlg(pg).getByLabel('Start time').inputValue() === '09:30', 'default start = Irwin’s next free slot on Thursday (09:30, after his 08:30–09:30 job)');
  // ---- 2. pause for breaks: 10:00 + 2h → 12:15
  await fillJob(pg); await setWork(pg, '10:00', '2h');
  let sm = await summary(pg);
  ok(/Irwin · Thu 10:00–12:15 \(incl\. 15 min break\) · within hours ✓/.test(sm) && /Ends 12:15 \(incl\. 15 min break\)/.test(sm), 'Irwin 10:00 + 2h work → "Ends 12:15 (incl. 15 min break)" · within hours ✓');
  ok(await dlg(pg).locator('.note-box').count() === 0, 'no "Runs across break" note any more');
  await dlg(pg).locator('fieldset', { hasText: 'Timing' }).screenshot({ path: out + '/t13-form.png' });
  ok(await dlg(pg).locator('.mini-this').count() === 1, 'mini timeline shows the job');
  await dlg(pg).getByText('Pause for breaks').click(); await settle(pg, 150);
  ok(/Thu 10:00–12:00 · within hours/.test(await summary(pg)), 'untick "Pause for breaks" → 2h ends 12:00');
  await dlg(pg).getByText('Pause for breaks').click(); await settle(pg, 150);
  await dlg(pg).locator('.modal-actions .btn-primary').click(); await settle(pg, 700); await closeAll(pg);
  const j215 = db.assignments.find((a) => a.person_id === 'pI' && a.work_date === D(3) && a.start_time === '10:00');
  ok(j215 && j215.end_time === '12:15' && j215.pause_for_breaks !== false, 'saved 10:00–12:15, pausing for breaks');
  // timeline: break shown inside the job block
  await pg.goto(BASE + `#/planner?view=day&day=${D(3)}`); await pg.waitForSelector('.dt-grid'); await settle(pg, 400);
  const blk = pg.locator('.dt-row[data-person="pI"] .dt-job', { hasText: '10:00' });
  ok(await blk.locator('.dt-job-brk').count() === 1 && /incl\. 15 min break/.test(await blk.textContent()), 'Day timeline: the break shows inside the job block ("10:00–12:15 (incl. 15 min break)")');
  ok(/3h busy/.test(await pg.locator('.dt-row[data-person="pI"] .dt-name').textContent()), 'busy/free uses the adjusted times (1h + 2h work = 3h busy; the break is not busy)');
  await pg.goto(BASE + `#/planner?week=${D(0)}`); await pg.waitForSelector('.planner'); await settle(pg, 300);
  // background: no pause
  await openAdd(pg, 'pI', 3);
  await sel(dlg(pg).getByLabel('Task / operation'), 'Soak / burn-in test'); await sel(dlg(pg).getByLabel('Pump model'), 'QPro 2000'); await settle(pg, 150);
  await dlg(pg).getByLabel('Start time').fill('16:00'); await dlg(pg).getByLabel('End time').fill('08:00'); await settle(pg, 150);
  ok(await dlg(pg).getByText('Pause for breaks').isHidden() && /runs through breaks/.test(await summary(pg)), 'background job: no "Pause for breaks"; runs through breaks');
  await pg.keyboard.press('Escape'); await settle(pg);
  // ---- 3. past the finish: continues on the next working day AUTOMATICALLY (Fri → weekend → Mon absent → Tue), no prompt
  await openAdd(pg, 'pI', 4); await fillJob(pg); await setWork(pg, '15:30', '2h'); await settle(pg, 600);
  sm = await summary(pg);
  const nextTue = fmtShort(D(8));
  ok(/runs past finish — continues over 2 working days ✓/.test(sm) && /15:30–16:30/.test(sm) && new RegExp(`${nextTue} 08:30–09:30`).test(sm), `auto split shown in the form: Fri 15:30–16:30, then ${nextTue} 08:30–09:30 (weekend and Monday’s holiday skipped): ${sm}`);
  ok(await dlg(pg).getByRole('button', { name: 'Continue next working day' }).count() === 0 && await dlg(pg).getByRole('button', { name: 'Keep on one day (overtime)' }).isVisible(), 'no prompt — only "Keep on one day (overtime)" to opt out');
  await dlg(pg).locator('.modal-actions .btn-primary').click(); await settle(pg, 900);
  ok(await pg.locator('dialog[open]').count() === 0, 'saved straight away (no "Save anyway?")');
  const note = await pg.locator('.toast').last().textContent();
  ok(new RegExp(`Split into 2 parts: Fri 15:30–16:30 → Tue 08:30–09:30`).test(note) && /Undo/.test(note) && /Edit/.test(note), 'notice: "Split into 2 parts: Fri 15:30–16:30 → Tue 08:30–09:30. Undo · Edit" — ' + note);
  await closeAll(pg);
  const p1 = db.assignments.find((a) => a.person_id === 'pI' && a.work_date === D(4) && a.start_time === '15:30');
  const part2 = db.assignments.find((a) => a.part_of === p1?.id);
  ok(p1 && p1.end_time === "16:30" && p1.work_minutes === 120 && part2 && part2.work_date === D(8) && part2.start_time === "08:30" && part2.end_time === "09:30", 'saved as two parts; part 2 points at part 1; total work time (2h) on part 1');
  ok(/part 1 of 2/.test(await rowOf(pg, 'pI').locator('td.day-cell').nth(4).textContent()), 'chip shows "↪ part 1 of 2"');
  // Settings → Planner: "Ask me" brings back the choices
  db.app_settings[0].overflow_mode = 'ask';
  await pg.reload(); await pg.waitForSelector('.planner'); await settle(pg, 300);
  await openAdd(pg, 'pI', 1); await fillJob(pg); await setWork(pg, '15:30', '2h');
  sm = await summary(pg);
  ok(/runs 1h past Irwin’s finish \(16:30\)/.test(sm), '"Ask me": live check "runs 1h past Irwin’s finish (16:30)"');
  ok(await dlg(pg).getByRole('button', { name: 'Continue next working day' }).isVisible() && await dlg(pg).getByRole('button', { name: 'Keep as is (overtime)' }).isVisible() && await dlg(pg).getByRole('button', { name: 'Shorten to end of day' }).isVisible(), '"Ask me" offers: continue next working day / keep as is (overtime) / shorten to end of day');
  // overtime
  await dlg(pg).getByRole('button', { name: 'Keep as is (overtime)' }).click(); await settle(pg, 150);
  ok(/overtime 1h \(agreed\)/.test(await summary(pg)), 'keep as is: "overtime 1h (agreed)"');
  await dlg(pg).locator('.modal-actions .btn-primary').click(); await settle(pg, 700);
  ok(!/Save anyway/.test(await pg.locator('dialog').last().textContent().catch(() => '')) && db.assignments.some((a) => a.person_id === 'pI' && a.work_date === D(1) && a.end_time === '17:30'), 'overtime saved 15:30–17:30 without a second "Save anyway?"');
  await closeAll(pg);
  // shorten
  await openAdd(pg, 'pI', 1); await fillJob(pg); await setWork(pg, '15:00', '3h');
  await dlg(pg).getByRole('button', { name: 'Shorten to end of day' }).click(); await settle(pg, 150);
  ok(await dlg(pg).getByLabel('End time').inputValue() === '16:30' && /15:00–16:30 · within hours ✓/.test(await summary(pg)), 'shorten to end of day → 15:00–16:30');
  // starts too early
  await dlg(pg).getByLabel('Start time').fill('07:30'); await dlg(pg).getByLabel('End time').fill('09:00'); await settle(pg, 150);
  ok(/Starts before Irwin’s start \(08:30\)/.test(await summary(pg)), 'live check: starts before his start');
  await dlg(pg).getByRole('button', { name: 'Move to 08:30' }).click(); await settle(pg, 150);
  ok(await dlg(pg).getByLabel('Start time').inputValue() === '08:30' && await dlg(pg).getByLabel('End time').inputValue() === '10:00', 'move to 08:30 keeps the length (08:30–10:00)');
  await pg.keyboard.press('Escape'); await settle(pg);
  // one-off: leaving 14:00 on Wednesday
  await openAdd(pg, 'pI', 2); await fillJob(pg); await setWork(pg, '13:00', '2h');
  ok(/past Irwin’s finish \(14:00\)/.test(await summary(pg)), 'uses the one-off change for the day (leaving 14:00)');
  await pg.keyboard.press('Escape'); await settle(pg);
  // ---- attended multi-day job: working hours only
  await pg.goto(BASE + `#/planner?view=day&day=${D(1)}`); await pg.waitForSelector('.dt-grid'); await settle(pg, 300);
  ok(/08:30–16:30/.test(await pg.locator('.dt-row[data-person="pD"] .dt-job').first().textContent()) && /Fully booked/.test(await pg.locator('.dt-row[data-person="pD"] .dt-name').textContent()), 'attended multi-day job: Tuesday counts 08:30–16:30 only (not overnight)');
  const capTue = await pg.evaluate(() => document.querySelector('.dt-cap')?.textContent || '');
  ok(true, 'capacity strip: ' + capTue.replace(/\s+/g, ' ').slice(0, 80));
  await pg.screenshot({ path: out + '/t13-day.png', fullPage: true });
  // export: work time and the break as its own row
  await pg.goto(BASE + `#/planner?week=${D(0)}`); await pg.waitForSelector('.planner');
  await pg.getByRole('button', { name: 'Export to Excel' }).click(); await dlg(pg).getByLabel('Dates').waitFor();
  const [dl] = await Promise.all([pg.waitForEvent('download', { timeout: 60000 }), dlg(pg).getByText('Download .xlsx').click()]);
  const f = out + '/t13.xlsx'; await dl.saveAs(f);
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(f);
  const rows = []; wb.getWorksheet('Timesheet').eachRow((r, i) => { if (i > 1 && r.getCell(1).value instanceof Date) rows.push(r.values); });
  const tm = (v) => (v instanceof Date ? Math.round((v.getTime() - Date.UTC(1899, 11, 30)) / 60000) : v);
  const job = rows.find((v) => v[2] === 'Irwin Walsh' && v[1].toISOString().slice(0, 10) === D(3) && tm(v[3]) === 600);
  ok(job && tm(job[4]) === 735 && job[5] === 2 && /incl\. 15 min break/.test(job[15]), 'export: 10:00–12:15, 2.00 hours of work, "incl. 15 min break"');
  const dan = rows.filter((v) => v[2] === 'Dan Hughes' && v[7] === 'Final assembly' && v[8] === 'MediAir');
  ok(dan.length === 3 && tm(dan[1][3]) === 510 && tm(dan[1][4]) === 990, 'export: multi-day attended job split by day, working hours only (Tue 08:30–16:30)');
  await pg.screenshot({ path: out + '/t13-week.png', clip: { x: 0, y: 0, width: 1440, height: 1000 } });
  ok(errs.length === 0, 'no page errors ' + errs.join(';')); await b.close();
  // phone: the form fits
  const b2 = await chromium.launch(); const c2 = await b2.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Europe/London', deviceScaleFactor: 2 }); const p2 = await c2.newPage();
  await p2.route('https://example.supabase.co/**', mock('admin', db)); await mock.mockRealtime(p2);
  await p2.goto(BASE); await p2.fill('#email', 'p@x.com'); await p2.fill('#password', 'x'); await p2.click('button[type=submit]');
  await p2.waitForSelector('#main[data-loaded="1"]'); await p2.goto(BASE + `#/planner?week=${D(0)}`); await p2.waitForSelector('.planner-phone'); await p2.waitForTimeout(400);
  await p2.locator('.day-tab').nth(4).click(); await p2.waitForTimeout(300);
  await p2.locator('.phone-person', { hasText: 'Irwin' }).getByText('+ Add').click(); await p2.waitForTimeout(200);
  await sel(dlg(p2).getByLabel('Task / operation'), 'Final assembly'); await sel(dlg(p2).getByLabel('Pump model'), 'QPro 2000');
  await setWork(p2, '15:30', '2h');
  ok(await dlg(p2).getByRole('button', { name: 'Continue next working day' }).isVisible() && await p2.evaluate(() => { const d = document.querySelector('dialog'); return d.scrollWidth <= d.clientWidth + 1; }), 'phone: timing summary and choices fit the form');
  await dlg(p2).locator('.timing-summary').scrollIntoViewIfNeeded(); await p2.screenshot({ path: out + '/t13-phone.png' });
  await b2.close(); srv.close();
  console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
})().catch((e) => { console.error(e); process.exit(1); });
function fmtShort(isoS) { const [y, m, d] = isoS.split('-').map(Number); const dt = new Date(y, m - 1, d); return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dt.getDay()]} ${d} ${dt.toLocaleDateString('en-GB', { month: 'short' })}`; }
