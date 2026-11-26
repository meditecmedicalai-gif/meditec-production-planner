const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const { execSync } = require('child_process');
const { PDFDocument } = require('pdf-lib');
const mock = require('./mockdb.cjs');
// Print (one page per person): time labels of overnight, multi-day and continued background jobs
// ("13:30 → 11:00 +1", "08:00 → Thu 08:00", "cont. → 11:00") never overlap the ⏱ / 💻 icon or the task
// text — in one and two columns and at every shrink step down to 7pt — and no two words overlap in the
// generated PDF (word boxes from pdftotext -bbox, when it is installed).
// Run:  npm run test:print-times   (needs Playwright + Chromium) — in-memory mock of Supabase (mockdb.cjs).
const root = process.argv[2] || 'dist-test', out = process.argv[3] || require('os').tmpdir();
const srv = http.createServer((q, r) => { let p = path.join(root, decodeURIComponent(q.url.split('?')[0])); if (p.endsWith('/')) p += 'index.html';
  fs.readFile(p, (e, d) => { if (e) { r.writeHead(404); return r.end(); } const ext = path.extname(p); r.writeHead(200, { 'content-type': { '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2' }[ext] || 'text/html' }); r.end(d); }); }).listen(5201);
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const add = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const now = new Date(); const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
const mon = add(today, 7 - ((today.getDay() + 6) % 7));
const D = (i) => iso(add(mon, i)); const WEEK = D(0);
const db = mock.seed();
const M = (n) => db.pump_models.find((m) => m.name === n).id, K = (n) => db.tasks.find((t) => t.name === n).id, B = (n) => db.build_types.find((t) => t.name === n).id;
db.people.push({ id: 'pO', name: 'Olivia Night', job_title: 'Test technician (nights)', active: true });
let n = 0;
const J = (d, t, s, e, o = {}) => db.assignments.push({ id: 'j' + (++n), person_id: 'pO', work_date: d, task_id: K(t), pump_model_id: o.office ? null : M(o.model || 'QPro 2000'),
  any_pump: false, pump_mix: null, build_type_id: o.office ? null : B(o.type || 'Production'), qty_target: o.office ? null : o.qty ?? 3, notes: o.notes ?? null, background: o.bg ?? null,
  start_time: s, end_time: e, end_date: o.end ?? null, equipment_id: o.eq ?? null, recurring_id: null, recurring_date: null, recurring_detached: false, part_of: null, created_at: '2026-11-20T09:00:00Z' });
// the reported ones: background Quality Testing over midnight
J(D(0), 'Quality testing', '09:00:00', '10:00:00', { bg: true, end: D(1), eq: 'eqQC' });         // Mon 09:00 → Tue 10:00
J(D(1), 'Quality testing', '13:30:00', '11:00:00', { bg: true, eq: 'eqQC', notes: 'Overnight soak on the Quality Check rack' });   // Tue 13:30 → Wed 11:00
J(D(3), 'Quality testing', '16:00:00', '11:00:00', { bg: true, eq: 'eqQC' });                     // Thu 16:00 → Fri 11:00
// multi-day background: Mon 08:00 → Thu 08:00 (continued on Tue and Wed, ends Thu)
J(D(0), 'Soak / burn-in test', '08:00:00', '08:00:00', { bg: true, end: D(3), model: 'MediAir', type: 'Rental' });
// attended work and office time around them, with long task names
for (let d = 0; d < 5; d++) {
  J(D(d), 'Functional test / calibration', '08:30:00', '10:30:00', { qty: 2, model: 'Mediflex', type: 'Customer', notes: 'Calibrate against the reference pump and record the readings' });
  J(D(d), 'Documentation', '13:00:00', '14:00:00', { office: true, notes: 'Night-shift handover notes' });
  J(D(d), 'Quality testing', '14:00:00', '16:00:00', { qty: 4 });
}

let fails = 0; const ok = (c, msg) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + msg); };
const BASE = 'http://localhost:5201/';
async function login(vp) {
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: vp, timezoneId: 'Europe/London' }); const pg = await ctx.newPage();
  const errs = []; pg.on('pageerror', (e) => errs.push(e.message));
  await pg.route('https://example.supabase.co/**', mock('admin', db)); await mock.mockRealtime(pg);
  await pg.addInitScript(() => { window.print = () => {}; });
  await pg.goto(BASE); await pg.fill('#email', 'p@x.com'); await pg.fill('#password', 'x'); await pg.click('button[type=submit]');
  await pg.waitForSelector('#main[data-loaded="1"]'); return { b, pg, errs };
}
const dlg = (pg) => pg.locator('dialog').last();
const settle = (pg, ms = 400) => pg.waitForTimeout(ms);

/** In the page: every job row, at every shrink step (one / two columns, 10pt → 7pt): time, icon and task boxes apart. */
function overlapsAtAllSteps() {
  const steps = [];
  for (const cols of [1, 2]) for (const fs of [10, 9, 8, 7.5, 7]) steps.push({ cols, fs });
  const problems = [];
  const sep = (a, b) => a.right <= b.left + 0.5 || b.right <= a.left + 0.5 || a.bottom <= b.top + 0.5 || b.bottom <= a.top + 0.5;
  for (const page of document.querySelectorAll('.pp-root .pp-page')) {
    const keep = { cls: page.className, style: page.getAttribute('style') };
    for (const st of steps) {
      page.classList.add('pp-compact', 'pp-clamp'); page.classList.toggle('pp-cols2', st.cols === 2);
      page.style.setProperty('--pp-fs', `${st.fs}pt`);
      page.style.height = 'auto';   // measuring every row, even ones a smaller step would not need
      for (const row of page.querySelectorAll('.pp-job')) {
        // the rendered TEXT (a range includes text that spills out of its box), line by line
        const lines = (el) => { if (!el) return []; const r = document.createRange(); r.selectNodeContents(el); return [...r.getClientRects()].filter((x) => x.width > 0.5 && x.height > 0.5); };
        const time = row.querySelector('.pp-time');
        const icon = row.querySelector('.pp-icon') || row.querySelector('.pp-mark');
        const what = row.querySelector('.pp-what b') || row.querySelector('.pp-what');
        const T = lines(time); const I = icon && !row.querySelector('.pp-icon') ? [] : lines(icon); const W = [...lines(what), ...(row.querySelector('.pp-mark') ? lines(row.querySelector('.pp-mark')) : [])];
        const hit = (A, Bs) => A.some((a) => Bs.some((b) => !sep(a, b)));
        if (!T.length || !W.length) { problems.push(`${st.cols} col ${st.fs}pt: row not laid out ("${time.textContent}")`); continue; }
        const cell = time.getBoundingClientRect();
        const spills = T.some((x) => x.right > cell.right + 0.5 || x.left < cell.left - 0.5);
        if (hit(T, W) || hit(T, I) || hit(I, W) || spills) {
          problems.push(`${st.cols} col ${st.fs}pt: "${time.textContent}" / "${what.textContent}"`);
        }
      }
    }
    page.className = keep.cls; if (keep.style == null) page.removeAttribute('style'); else page.setAttribute('style', keep.style);
  }
  return { problems: [...new Set(problems)], rows: document.querySelectorAll('.pp-root .pp-job').length, steps: steps.length };
}
/** Word boxes per page from pdftotext -bbox; → pairs of words that overlap (or null if pdftotext is missing). */
function pdfWordOverlaps(file) {
  let xml;
  try { xml = execSync(`pdftotext -bbox "${file}" -`, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); } catch { return null; }
  const bad = [];
  for (const page of xml.split('<page ').slice(1)) {
    const words = [...page.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g)]
      .map((m) => ({ x0: +m[1], y0: +m[2], x1: +m[3], y1: +m[4], t: m[5] }));
    for (let a = 0; a < words.length; a++) {
      for (let b = a + 1; b < words.length; b++) {
        const p = words[a]; const q = words[b];
        const ix = Math.min(p.x1, q.x1) - Math.max(p.x0, q.x0); const iy = Math.min(p.y1, q.y1) - Math.max(p.y0, q.y0);
        // same line (overlapping by at least half their height) AND overlapping sideways = text on top of text.
        // (Lines stacked above each other only touch: font boxes are taller than the line height.)
        if (ix <= 0.5 || iy < 0.5 * Math.min(p.y1 - p.y0, q.y1 - q.y0)) continue;
        bad.push(`"${p.t}" × "${q.t}"`);
      }
    }
  }
  return bad;
}
async function printPdf(pg, name, choose) {
  await pg.goto(BASE + `#/planner?week=${WEEK}`); await pg.waitForSelector('.planner'); await settle(pg, 300);
  await pg.getByRole('button', { name: 'Print', exact: true }).click(); await dlg(pg).waitFor();
  await dlg(pg).getByLabel('One page per person').check();
  await choose(pg);
  await dlg(pg).getByLabel(/^Everyone/).uncheck();
  for (const b of await dlg(pg).locator('.pp-people label').all()) { const inp = b.locator('input'); if (/Olivia/.test(await b.textContent())) await inp.check(); else await inp.uncheck(); }
  await settle(pg, 900);
  await dlg(pg).locator('.modal-actions .btn-primary').click(); await settle(pg, 900);
  await pg.waitForFunction(() => document.querySelector('.pp-root .pp-page'));
  const text = (await pg.locator('.pp-root').textContent()).replace(/\s+/g, ' ');
  // measured as printed: the pages are only shown in print
  await pg.emulateMedia({ media: 'print' });
  const steps = await pg.evaluate(overlapsAtAllSteps);
  const file = path.join(out, `${name}.pdf`);
  const buf = await pg.pdf({ path: file, preferCSSPageSize: true, printBackground: true });
  await pg.emulateMedia({ media: 'screen' });
  try { execSync(`pdftoppm -r 110 -png "${file}" "${path.join(out, name)}"`); } catch { /* no PNG without pdftoppm */ }
  await pg.evaluate(() => { document.documentElement.classList.remove('pp-printing'); document.querySelectorAll('.pp-root').forEach((x) => x.remove()); });
  return { text, steps, pages: (await PDFDocument.load(buf)).getPageCount(), words: pdfWordOverlaps(file) };
}

(async () => {
  const { b, pg, errs } = await login({ width: 1440, height: 1000 });
  // ---- the week (landscape)
  let r = await printPdf(pg, 'print-times-week', async () => {});
  ok(r.pages === 1, `week: one page (${r.pages})`);
  ok(/09:00 → 10:00 \+1/.test(r.text) && /13:30 → 11:00 \+1/.test(r.text) && /16:00 → 11:00 \+1/.test(r.text), 'short labels: "09:00 → 10:00 +1", "13:30 → 11:00 +1", "16:00 → 11:00 +1"');
  ok(/08:00 → Thu 08:00/.test(r.text) && /cont\. → Thu 08:00/.test(r.text) && /cont\. → 08:00/.test(r.text) && /cont\. → 10:00/.test(r.text) && /cont\. → 11:00/.test(r.text),
    'multi-day / continued: "08:00 → Thu 08:00", "cont. → Thu 08:00", "cont. → 08:00", "cont. → 11:00"');
  ok(!/next day/.test(r.text), 'no long "next day" text any more');
  ok(r.steps.problems.length === 0, `week: time / icon / task never overlap — ${r.steps.rows} rows × ${r.steps.steps} steps (1 and 2 columns, 10pt → 7pt)${r.steps.problems.length ? ': ' + r.steps.problems.slice(0, 4).join(' | ') : ''}`);
  if (r.words) ok(r.words.length === 0, `week PDF: no two words overlap${r.words.length ? ': ' + r.words.slice(0, 5).join(', ') : ''}`);
  else console.log('SKIP PDF word boxes (pdftotext not installed)');
  // ---- one day (portrait): Tuesday — continued + overnight starting
  r = await printPdf(pg, 'print-times-day', async (p) => { await dlg(p).getByLabel(/One day/).check(); await dlg(p).getByLabel('Day', { exact: true }).selectOption(D(1)); });
  ok(r.pages === 1 && /cont\. → 10:00/.test(r.text) && /13:30 → 11:00 \+1/.test(r.text) && /cont\. → Thu 08:00/.test(r.text), 'day: "cont. → 10:00", "13:30 → 11:00 +1", "cont. → Thu 08:00"');
  ok(r.steps.problems.length === 0, `day: no overlap at any step (${r.steps.rows} rows)${r.steps.problems.length ? ': ' + r.steps.problems.slice(0, 4).join(' | ') : ''}`);
  if (r.words) ok(r.words.length === 0, `day PDF: no two words overlap${r.words.length ? ': ' + r.words.slice(0, 5).join(', ') : ''}`);
  ok(errs.length === 0, 'no page errors ' + errs.join(';')); await b.close(); srv.close();
  console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
})().catch((e) => { console.error(e); process.exit(1); });
