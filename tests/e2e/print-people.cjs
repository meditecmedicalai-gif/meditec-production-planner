const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const { execSync } = require('child_process');
const { PDFDocument } = require('pdf-lib');
const mock = require('./mockdb.cjs');
// Print — one page per person. Generates REAL PDFs (Chromium page.pdf with the print CSS) and checks:
//  (a) a normal week: exactly one A4 landscape page per person, nothing clipped;
//  (b) a person with 40+ jobs in a week: still one page (shrunk, two columns), nothing clipped;
//  (c) one day with 15 jobs: one A4 portrait page;
//  plus: a week that can't fit even at 7pt → the dialog warns ("needs 2 pages") and the PDF says
//  "Continued on next page"; light colours from dark mode; "Print this person" buttons; team layout.
// Run:  npm run test:print   (needs Playwright + Chromium). PDFs and PNGs (if pdftoppm is installed) go to the out dir.
const root = process.argv[2] || 'dist-test', out = process.argv[3] || require('os').tmpdir();
const srv = http.createServer((q, r) => { let p = path.join(root, decodeURIComponent(q.url.split('?')[0])); if (p.endsWith('/')) p += 'index.html';
  fs.readFile(p, (e, d) => { if (e) { r.writeHead(404); return r.end(); } const ext = path.extname(p); r.writeHead(200, { 'content-type': { '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2' }[ext] || 'text/html' }); r.end(d); }); }).listen(5200);
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const add = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const now = new Date(); const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
const mon = add(today, 7 - ((today.getDay() + 6) % 7));
const D = (i) => iso(add(mon, i)); const WEEK = D(0);
const db = mock.seed();
const M = (n) => db.pump_models.find((m) => m.name === n).id, K = (n) => db.tasks.find((t) => t.name === n).id, B = (n) => db.build_types.find((t) => t.name === n).id;
db.people.push(
  { id: 'pA', name: 'Amira Khan', job_title: 'Senior assembler', active: true },
  { id: 'pI', name: 'Irwin Walsh', job_title: 'Assembler', active: true },
  { id: 'pB', name: 'Ben Carter', job_title: 'Test technician', active: true },
  { id: 'pZ', name: 'Zoe Long', job_title: 'Rework', active: true },
  { id: 'pC', name: 'Chloe Davies', job_title: 'Apprentice', active: true });
let n = 0;
const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00`;
const J = (p, d, t, s, e, o = {}) => db.assignments.push({ id: 'j' + (++n), person_id: p, work_date: d, task_id: K(t), pump_model_id: o.office ? null : M(o.model || 'QPro 2000'),
  any_pump: false, pump_mix: null, build_type_id: o.office ? null : B(o.type || 'Production'), qty_target: o.office ? null : o.qty ?? 2, notes: o.notes ?? null, background: o.bg ?? null,
  start_time: s == null ? null : hm(s), end_time: e == null ? null : hm(e), end_date: null, equipment_id: o.eq ?? null, recurring_id: null, recurring_date: null, recurring_detached: false,
  part_of: null, created_at: '2026-11-20T09:00:00Z' });
const LONG = 'Check the valve seat torque against the new spec sheet, photograph the label, and log the serial numbers in Odoo before moving the pump to Quality Check — ask Ben if the fixture is missing.';
// (a) Amira: a normal week — attended, background ⏱, office 💻, notes, absence Thu, one-off hours Tue
J('pA', D(0), 'Sub-assembly', 510, 630, { qty: 5, notes: 'Batch 14' }); J('pA', D(0), 'Final assembly', 645, 750, { qty: 3 }); J('pA', D(0), 'Meetings', 780, 840, { office: true, notes: 'Weekly production meeting' });
J('pA', D(0), 'Soak / burn-in test', 900, 480, { qty: 4, bg: true, eq: 'eqQC' });   // overnight 15:00 → 08:00
J('pA', D(1), 'Final assembly', 510, 720, { qty: 6, model: 'MediAir', type: 'Rental', notes: LONG }); J('pA', D(1), 'Documentation', 780, 900, { office: true });
J('pA', D(2), 'Rework', 510, 630, { qty: 2, model: 'Simplex', type: 'Customer' }); J('pA', D(2), 'Functional test / calibration', 660, 780, { qty: 2, model: 'Simplex', eq: 'eqQC' });
J('pA', D(4), 'Final assembly', 510, 960, { qty: 8, type: 'Trial' }); J('pA', D(4), 'Admin / Email', null, null, { office: true });
db.absences.push({ id: 'abA', person_id: 'pA', start_date: D(3), end_date: D(3), absence_type: 'holiday', notes: 'Booked in October' });
db.person_day_hours.push({ id: 'dhA', person_id: 'pA', work_date: D(1), works: true, start_time: null, end_time: '14:00:00', lunch_time: null, break_time: null, lunch_minutes: null, break_minutes: null, notes: 'Dentist' });
// (b) Irwin: 45 jobs in the week (9 a day), some with long notes
for (let d = 0; d < 5; d++) for (let k = 0; k < 9; k++) J('pI', D(d), ['Sub-assembly', 'Final assembly', 'Rework'][k % 3], 510 + k * 50, 550 + k * 50, { qty: 1 + (k % 3), model: ['QPro 2000', 'MediAir', 'Simplex'][k % 3], notes: k % 4 === 0 ? LONG : k % 4 === 1 ? 'Short note' : null });
// (c) Ben: one day (Wed) with 15 jobs
for (let k = 0; k < 15; k++) J('pB', D(2), k % 2 ? 'Quality testing' : 'Functional test / calibration', 510 + k * 30, 535 + k * 30, { qty: 1, model: ['QPro 2000', 'Medicare', 'Mediflex'][k % 3], notes: k % 5 === 0 ? LONG : null, eq: k % 2 ? 'eqQC' : null });
// too much for one page even at 7pt: Zoe has 30 jobs a day with long notes (150 in the week)
for (let d = 0; d < 5; d++) for (let k = 0; k < 30; k++) J('pZ', D(d), 'Rework', 510 + k * 15, 523 + k * 15, { qty: 1, notes: `${k}: ${LONG}` });

let fails = 0; const ok = (c, msg) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + msg); };
const BASE = 'http://localhost:5200/';
async function login(role, vp, scheme = 'light') {
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: vp, timezoneId: 'Europe/London', colorScheme: scheme }); const pg = await ctx.newPage();
  const errs = []; pg.on('pageerror', (e) => errs.push(e.message));
  await pg.route('https://example.supabase.co/**', mock(role, db)); await mock.mockRealtime(pg);
  // window.print opens the browser's dialog: count calls instead; the pages stay in place for page.pdf()
  await pg.addInitScript(() => { window.__prints = 0; window.print = () => { window.__prints++; }; });
  await pg.goto(BASE); await pg.fill('#email', 'p@x.com'); await pg.fill('#password', 'x'); await pg.click('button[type=submit]');
  await pg.waitForSelector('#main[data-loaded="1"]'); return { b, pg, errs };
}
const dlg = (pg) => pg.locator('dialog').last();
const settle = (pg, ms = 400) => pg.waitForTimeout(ms);
async function week(pg) { await pg.goto(BASE + `#/planner?week=${WEEK}`); await pg.waitForSelector('.planner'); await settle(pg, 300); }
async function choosePeople(pg, ids) {
  await dlg(pg).getByLabel(/^Everyone/).uncheck();
  for (const p of db.people.filter((x) => x.active)) {
    const box = dlg(pg).locator('.pp-people label', { hasText: p.name }).locator('input');
    if (ids.includes(p.id)) await box.check(); else await box.uncheck();
  }
  await settle(pg, 900);
}
/** Click Print in the dialog, check the laid-out pages (`inspect`), then write the PDF. → { file, pages: [{ w, h }], text, seen } */
async function printToPdf(pg, name, inspect = async () => null) {
  await dlg(pg).locator('.modal-actions .btn-primary').click(); await settle(pg, 900);
  await pg.waitForFunction(() => document.documentElement.classList.contains('pp-printing') && document.querySelector('.pp-root'));
  const seen = await inspect();   // (page.pdf fires "afterprint", which puts the app back)
  const file = path.join(out, `${name}.pdf`);
  await pg.emulateMedia({ media: 'print' });
  const buf = await pg.pdf({ path: file, preferCSSPageSize: true, printBackground: true });
  await pg.emulateMedia({ media: 'screen' });
  const doc = await PDFDocument.load(buf);
  const pages = doc.getPages().map((p) => { const { width, height } = p.getSize(); return { w: width, h: height }; });
  let text = '';
  try { text = execSync(`pdftotext -layout "${file}" -`, { encoding: 'utf8' }); } catch { /* pdftotext not installed: page checks only */ }
  try { execSync(`pdftoppm -r 60 -png "${file}" "${path.join(out, name)}"`); } catch { /* no PNGs without pdftoppm */ }
  return { file, pages, text, seen };
}
/** Every page: nothing outside its box (no clipped text). */
const unclipped = (pg) => pg.$$eval('.pp-root .pp-page', (ps) => ps.length > 0 && ps.every((p) => p.scrollHeight <= p.clientHeight + 1 && p.scrollWidth <= p.clientWidth + 1));
const cleanup = (pg) => pg.evaluate(() => { document.documentElement.classList.remove('pp-printing'); document.querySelectorAll('.pp-root').forEach((x) => x.remove()); });
const isLandscapeA4 = (p) => Math.abs(p.w - 841.9) < 3 && Math.abs(p.h - 595.3) < 3;
const isPortraitA4 = (p) => Math.abs(p.w - 595.3) < 3 && Math.abs(p.h - 841.9) < 3;

(async () => {
  let { b, pg, errs } = await login('admin', { width: 1440, height: 1000 }, 'dark');
  await week(pg);

  // ---- dialog
  await pg.getByRole('button', { name: 'Print', exact: true }).click(); await dlg(pg).waitFor();
  ok(await dlg(pg).getByLabel('Whole team (current layout)').isChecked() && await dlg(pg).getByLabel('One page per person').count() === 1
    && await dlg(pg).getByLabel(/This week/).count() === 1 && await dlg(pg).getByLabel(/One day/).count() === 1, 'print dialog: layout (team / per person) and period (this week / one day)');
  await dlg(pg).getByLabel('One page per person').check(); await settle(pg, 300);
  ok(await dlg(pg).locator('.pp-people').isVisible(), 'per person: choose everyone or specific people');

  // ---- (a) normal week: Amira, Chloe (empty week)
  await choosePeople(pg, ['pA', 'pC']);
  ok(/✓ 2 pages — one per person, everything fits/.test(await dlg(pg).locator('.pp-fit').textContent()), 'dialog: "✓ 2 pages — one per person, everything fits"');
  let r = await printToPdf(pg, 'print-a-week', async () => {
    const amira = pg.locator('.pp-root .pp-page').first();
    const at = (await amira.textContent()).replace(/\s+/g, ' ');
    await pg.emulateMedia({ media: 'print', colorScheme: 'dark' });
    const colours = await amira.evaluate((e) => [getComputedStyle(e).backgroundColor, getComputedStyle(e).color]);
    const typeColours = await amira.locator('.pp-job').evaluateAll((js) => new Set(js.map((j) => getComputedStyle(j).borderLeftColor)).size);
    await pg.emulateMedia({ media: 'screen' });
    return { at, jobs: await amira.locator('.pp-job').count(), bars: await amira.locator('.pp-bar').count(), unclipped: await unclipped(pg), colours, typeColours };
  });
  const a = r.seen;
  ok(await pg.evaluate(() => window.__prints) === 1, 'Print opens the browser print (window.print)');
  ok(r.pages.length === 2 && r.pages.every(isLandscapeA4), `(a) normal week: exactly one A4 landscape page per person (${r.pages.length} pages)`);
  ok(a.unclipped, '(a) nothing clipped on any page');
  ok(/Amira Khan/.test(a.at) && /Senior assembler/.test(a.at) && /Hours: Mon 08:30–16:30 · Tue 08:30–14:00 · Wed–Fri 08:30–16:30/.test(a.at) && /Printed by Prince/.test(a.at) && /Week \d+/.test(a.at),
    '(a) header: name, role, hours, week, printed by + when');
  ok(a.jobs === 11, `(a) all 10 jobs, the overnight soak on both days (${a.jobs} lines)`);
  ok(/15:00–08:00 next day/.test(a.at) && /cont\.–08:00/.test(a.at), '(a) overnight job: "15:00–08:00 next day", then "cont.–08:00"');
  ok(/Sub-assembly · QPro 2000 ×5/.test(a.at) && /Production/.test(a.at) && /Quality Check/.test(a.at) && /⏱/.test(a.at) && /💻/.test(a.at) && /Weekly production meeting/.test(a.at), '(a) task, pump + quantity, build type, station, ⏱ background, 💻 office, notes');
  ok(/08:30–10:30.*10:45–12:30.*13:00–14:00/.test(a.at), '(a) jobs in time order with start–end');
  ok(/Holiday/.test(a.at) && /Booked in October/.test(a.at) && /⏰ Leaving 14:00/.test(a.at), '(a) absence and one-off hours change');
  ok(/busy/.test(a.at) && a.bars >= 3, '(a) a daily busy / free line');
  ok(/busy.*free.*production.*office.*units/.test(a.at.slice(a.at.lastIndexOf(' busy') - 12)), '(a) totals: busy, free, production, office, units');
  if (r.text) ok(/Amira Khan/.test(r.text) && /Chloe Davies/.test(r.text) && /Weekly production meeting/.test(r.text), '(a) PDF text: both people and their jobs');
  ok(a.colours[0] === 'rgb(255, 255, 255)' && a.colours[1] === 'rgb(17, 17, 17)', '(a) light colours in print, even from dark mode: ' + a.colours.join(' / '));
  ok(a.typeColours >= 3, `(a) build types still told apart by colour (${a.typeColours} edge colours)`);
  await cleanup(pg);

  // ---- (b) 40+ jobs in a week: still one page
  await week(pg);
  await pg.locator('.planner tbody tr[data-person="pI"] .pp-btn').click(); await dlg(pg).waitFor(); await settle(pg, 1200);
  ok(await dlg(pg).getByLabel('One page per person').isChecked() && await dlg(pg).locator('.pp-people label', { hasText: 'Irwin Walsh' }).locator('input').isChecked()
    && !(await dlg(pg).locator('.pp-people label', { hasText: 'Amira Khan' }).locator('input').isChecked()), '"Print this person" on the planner row: per person, Irwin only');
  ok(/everything fits/.test(await dlg(pg).locator('.pp-fit').textContent()) && /Made smaller to fit: Irwin/.test(await dlg(pg).locator('.pp-fit').textContent()), 'dialog: Irwin made smaller to fit — ' + (await dlg(pg).locator('.pp-fit').textContent()).replace(/\s+/g, ' '));
  r = await printToPdf(pg, 'print-b-45-jobs', async () => {
    const irwin = pg.locator('.pp-root .pp-page').first();
    return { jobs: await irwin.locator('.pp-job').count(), unclipped: await unclipped(pg), fs: await irwin.evaluate((e) => parseFloat(getComputedStyle(e).fontSize) * 0.75),
      clamp: await irwin.evaluate((e) => e.classList.contains('pp-clamp')), lc: await irwin.locator('.pp-note').first().evaluate((e) => getComputedStyle(e).webkitLineClamp),
      cols: await irwin.evaluate((e) => e.classList.contains('pp-cols2')) };
  });
  ok(r.pages.length === 1 && isLandscapeA4(r.pages[0]), `(b) 45 jobs: exactly one page (${r.pages.length})`);
  ok(r.seen.jobs === 45 && r.seen.unclipped, `(b) all 45 jobs on it, nothing clipped (${r.seen.jobs})`);
  ok(r.seen.fs >= 6.9, `(b) text not below the minimum readable size (${r.seen.fs.toFixed(1)}pt${r.seen.cols ? ', two columns' : ''})`);
  ok(r.seen.clamp && r.seen.lc === '2', '(b) long notes cut to 2 lines (…) in print');
  await cleanup(pg);
  await pg.locator('.planner tbody tr[data-person="pI"] .chip', { hasText: 'Check the valve seat' }).first().waitFor();
  ok(/log the serial numbers in Odoo before moving the pump/.test(await pg.locator('.planner tbody tr[data-person="pI"] .chip-notes').first().textContent()), '(b) full note text stays on screen');

  // ---- (c) one day with 15 jobs: one A4 portrait page (from the Day timeline's "Print this person")
  await pg.goto(BASE + `#/planner?view=day&day=${D(2)}`); await pg.waitForSelector('.dt-row'); await settle(pg, 300);
  await pg.locator('.dt-row[data-person="pB"] .pp-btn').click(); await dlg(pg).waitFor(); await settle(pg, 1000);
  ok(await dlg(pg).getByLabel(/One day/).isChecked() && await dlg(pg).getByLabel('Day', { exact: true }).inputValue() === D(2), '"Print this person" on the Day timeline: that day, that person');
  r = await printToPdf(pg, 'print-c-day-15-jobs', async () => ({ jobs: await pg.locator('.pp-root .pp-page .pp-job').count(), unclipped: await unclipped(pg) }));
  ok(r.pages.length === 1 && isPortraitA4(r.pages[0]), `(c) one day, 15 jobs: exactly one A4 portrait page (${r.pages.length})`);
  ok(r.seen.jobs === 15 && r.seen.unclipped, `(c) all 15 jobs, nothing clipped (${r.seen.jobs})`);
  await cleanup(pg);

  // ---- too much even at 7pt: the dialog warns; the PDF continues with "Continued on next page"
  await week(pg);
  await pg.getByRole('button', { name: 'Print', exact: true }).click(); await dlg(pg).waitFor();
  await dlg(pg).getByLabel('One page per person').check(); await choosePeople(pg, ['pA', 'pZ']); await settle(pg, 800);
  const warn = (await dlg(pg).locator('.pp-fit').textContent()).replace(/\s+/g, ' ');
  const zPages = Number((warn.match(/Zoe’s week needs (\d+) pages/) || [])[1]);
  ok(zPages >= 2, 'dialog warns before printing: ' + warn);
  await dlg(pg).screenshot({ path: path.join(out, 'print-dialog.png') });
  r = await printToPdf(pg, 'print-overflow', async () => ({ jobs: await pg.locator('.pp-root .pp-page .pp-job').count(), unclipped: await unclipped(pg),
    cont: await pg.locator('.pp-root .pp-footer', { hasText: 'Continued on next page' }).count() }));
  ok(r.pages.length === 1 + zPages, `PDF: Amira 1 page + Zoe ${zPages} pages (${r.pages.length})`);
  ok(r.seen.jobs === 11 + 150 && r.seen.unclipped, `nothing lost or clipped: all 160 jobs are on the pages (${r.seen.jobs} lines)`);
  ok(r.seen.cont === zPages - 1, '"Continued on next page" at the bottom of each page that continues');
  if (r.text) ok(/Continued on next page/.test(r.text) && /Zoe Long — continued \(page 2\)/.test(r.text), 'PDF text: "Continued on next page" and "Zoe Long — continued (page 2)"');
  await cleanup(pg);

  // ---- whole team (current layout) still prints the planner
  await week(pg);
  const before = await pg.evaluate(() => window.__prints);
  await pg.getByRole('button', { name: 'Print', exact: true }).click(); await dlg(pg).waitFor();
  await dlg(pg).getByLabel(/One day/).check(); await dlg(pg).getByLabel('Day', { exact: true }).selectOption(D(1));
  await dlg(pg).locator('.modal-actions .btn-primary').click(); await pg.waitForSelector('.dt-row'); await settle(pg, 900);
  ok((await pg.evaluate(() => location.hash)).includes(`view=day&day=${D(1)}`) && await pg.evaluate(() => window.__prints) === before + 1, 'whole team, one day: opens that Day timeline and prints it');

  // ---- People page: "Print this person"
  await pg.goto(BASE + '#/people'); await pg.waitForSelector('.person-cell'); await settle(pg, 300);
  await pg.locator('tr', { hasText: 'Ben Carter' }).locator('.pp-btn').click(); await dlg(pg).waitFor(); await settle(pg, 800);
  ok(await dlg(pg).getByLabel('One page per person').isChecked() && await dlg(pg).locator('.pp-people label', { hasText: 'Ben Carter' }).locator('input').isChecked(), 'People page: "Print this person"');
  ok(errs.length === 0, 'no page errors ' + errs.join(';')); await b.close(); srv.close();
  console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
})().catch((e) => { console.error(e); process.exit(1); });
