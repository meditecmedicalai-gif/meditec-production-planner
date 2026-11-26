const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const mock = require('./mockdb.cjs');
// Mixed pumps on one job (task setting "Allows mixed pumps", e.g. Repair, Rework): a quantity per pump model
// plus "Any / unknown", quantity = the sum, chip "Rework · QPro ×3, MediAir ×2, Mediflex ×1", training checked
// per model, weekly summary / demand / Excel count per model, the setting in Settings → Tasks.
// Run:  npm run test:mixed   (needs Playwright + Chromium) — in-memory mock of Supabase (mockdb.cjs).
const root = process.argv[2] || 'dist-test', out = process.argv[3] || require('os').tmpdir();
const srv = http.createServer((q, r) => { let p = path.join(root, decodeURIComponent(q.url.split('?')[0])); if (p.endsWith('/')) p += 'index.html';
  fs.readFile(p, (e, d) => { if (e) { r.writeHead(404); return r.end(); } const ext = path.extname(p); r.writeHead(200, { 'content-type': { '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2' }[ext] || 'text/html' }); r.end(d); }); }).listen(5199);
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const add = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const now = new Date(); const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
const mon = add(today, 7 - ((today.getDay() + 6) % 7));     // next week: no "today" effects
const D = (i) => iso(add(mon, i)); const WEEK = D(0);
const db = mock.seed();
const M = (n) => db.pump_models.find((m) => m.name === n).id, B = (n) => db.build_types.find((t) => t.name === n).id;
db.people.push({ id: 'pA', name: 'Amira Khan', job_title: 'Repairs', active: true });
db.person_skills.push({ person_id: 'pA', pump_model_id: M('QPro 2000') });   // trained on QPro only
const ts = new Date(Date.now() - 86400000).toISOString();
db.demand_notes.push({ id: 'nAir', pump_model_id: M('MediAir'), any_pump: false, build_type_id: B('Production'), quantity: 5, needed_by: D(4), priority: 'normal',
  comment: 'MediAir refurb', status: 'open', status_override: null, created_by: 'other', created_at: ts, updated_by: 'other', updated_at: ts });
let fails = 0; const ok = (c, msg) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + msg); };
const BASE = 'http://localhost:5199/';
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
const cellOf = (pg, id, isoS) => pg.locator(`.planner tbody tr[data-person="${id}"] td.day-cell[data-day="${isoS}"]`);
async function week(pg) { await pg.goto(BASE + `#/planner?week=${WEEK}`); await pg.waitForSelector('.planner'); await settle(pg, 300); }
async function saveAll(pg) { for (let i = 0; i < 4 && await pg.locator('dialog[open]').count(); i++) { await dlg(pg).locator('.modal-actions .btn-primary').click(); await settle(pg, 600); } }
const taskRow = (pg, name) => pg.locator('li, tr', { hasText: name }).filter({ has: pg.getByRole('button', { name: 'Edit' }) }).last();

(async () => {
  let { b, pg, errs } = await login('admin', { width: 1440, height: 1000 });

  // ---- Settings → Tasks: "Allows mixed pumps" on for Repair and Rework only
  await pg.goto(BASE + '#/settings'); await pg.waitForSelector('button[title^="Production stages"]'); await settle(pg, 300);
  ok(/mixed pumps/.test(await taskRow(pg, 'Rework').textContent()) && /mixed pumps/.test(await taskRow(pg, 'Repair').textContent())
    && !/mixed pumps/.test(await taskRow(pg, 'Final assembly').textContent()), 'tasks list: "mixed pumps" on Repair and Rework only');
  await taskRow(pg, 'Final assembly').getByRole('button', { name: 'Edit' }).click(); await dlg(pg).waitFor();
  const flag = dlg(pg).getByLabel(/Allows mixed pumps/);
  ok(!(await flag.isChecked()), 'Final assembly: "Allows mixed pumps" off');
  await flag.check(); await dlg(pg).locator('.modal-actions .btn-primary').click(); await settle(pg, 600);
  ok(db.tasks.find((t) => t.name === 'Final assembly').allows_any_pump === true, 'the setting is saved (turned on for Final assembly)');

  // ---- job form: several pumps, a quantity each + Any / unknown; quantity = the sum
  await week(pg);
  await cellOf(pg, 'pA', D(1)).getByText('+ Add').click(); await settle(pg, 200);
  await sel(dlg(pg).getByLabel('Task / operation'), 'Quality testing'); await settle(pg, 150);
  ok(await dlg(pg).getByLabel('Pump model').locator('option', { hasText: 'Several pumps' }).count() === 0, 'not offered on a task without the setting (Quality testing)');
  await sel(dlg(pg).getByLabel('Task / operation'), 'Rework'); await settle(pg, 150);
  await sel(dlg(pg).getByLabel('Pump model'), 'Several pumps (mixed)'); await settle(pg, 200);
  ok(await dlg(pg).locator('.mix-box').isVisible() && await dlg(pg).getByLabel('Any / unknown quantity').isVisible(), 'a quantity per pump model, plus "Any / unknown"');
  await dlg(pg).getByLabel('QPro quantity').fill('3'); await dlg(pg).getByLabel('MediAir quantity').fill('2');
  await dlg(pg).getByLabel('Mediflex quantity').fill('1'); await dlg(pg).getByLabel('Any / unknown quantity').fill('1'); await settle(pg, 300);
  const qty = dlg(pg).getByLabel('Quantity target');
  ok(await qty.inputValue() === '7' && await qty.evaluate((e) => e.readOnly) && /Total 7 pumps/.test(await dlg(pg).locator('.mix-total').textContent()), 'quantity = the sum (7), read-only while the list is used');
  const warn = (await dlg(pg).locator('.warn-box').allTextContents()).join(' | ');
  ok(/not trained on MediAir, Mediflex\./.test(warn) && !/QPro/.test(warn), 'training checked for each model listed (MediAir, Mediflex; not "Any / unknown"): ' + warn);
  await dlg(pg).getByLabel('Start time').fill('09:00'); await dlg(pg).getByLabel('End time').fill('11:00'); await settle(pg, 200);
  await pg.screenshot({ path: out + '/mixed-form.png' });
  await saveAll(pg);
  const rw = db.assignments.find((a) => a.person_id === 'pA' && a.any_pump && a.work_date === D(1));
  ok(rw && rw.qty_target === 7 && rw.pump_mix.length === 4 && rw.pump_mix.some((x) => x.pump_model_id === null && x.qty === 1), 'saved: 4 entries incl. Any / unknown, quantity 7');
  const chip = (await cellOf(pg, 'pA', D(1)).locator('.chip').first().textContent()).replace(/\s+/g, ' ');
  ok(/Rework · QPro ×3, MediAir ×2, Mediflex ×1, Any \/ unknown ×1/.test(chip), 'chip: "Rework · QPro ×3, MediAir ×2, Mediflex ×1, Any / unknown ×1" — ' + chip);
  ok(/⚠|!/.test(chip) || await cellOf(pg, 'pA', D(1)).locator('.chip-warn').count() === 1, 'chip flags the training warning');

  // ---- weekly summary: each model its own row (all pump tasks); Any / unknown its own row
  await pg.check('text=Count all pump tasks'); await settle(pg, 300);
  const rows = await pg.$$eval('table.summary tbody tr', (trs) => trs.map((t) => [...t.children].map((c) => c.textContent.trim()).join(' | ')));
  const planned = (name) => (rows.find((r) => r.startsWith(name)) || '').split(' | ')[2];
  ok(planned('QPro 2000') === '3' && planned('MediAir') === '2' && planned('Mediflex') === '1' && planned('Any / unknown') === '1', 'summary per model: QPro 3, MediAir 2, Mediflex 1, Any / unknown 1 — ' + rows.join(' ‖ '));
  await pg.uncheck('text=Count all pump tasks'); await settle(pg, 200);

  // ---- demand: a mixed Final assembly job covering the MediAir note counts only its MediAir pumps
  await cellOf(pg, 'pA', D(2)).getByText('+ Add').click(); await settle(pg, 200);
  await sel(dlg(pg).getByLabel('Task / operation'), 'Final assembly'); await settle(pg, 150);
  await sel(dlg(pg).getByLabel('Pump model'), 'Several pumps (mixed)'); await settle(pg, 200);
  await dlg(pg).getByLabel('QPro quantity').fill('3'); await dlg(pg).getByLabel('MediAir quantity').fill('2'); await settle(pg, 300);
  const cover = await dlg(pg).getByLabel('Covers demand').locator('option').allTextContents();
  ok(cover.some((o) => /MediAir/.test(o)), '"Covers demand" lists notes for the models listed: ' + cover.join(' | '));
  await dlg(pg).getByLabel('Covers demand').selectOption('nAir');
  await dlg(pg).getByLabel('Start time').fill('09:00'); await dlg(pg).getByLabel('End time').fill('10:00');
  await saveAll(pg);
  await pg.goto(BASE + '#/demand'); await pg.waitForSelector('.dcard[data-note="nAir"]', { state: 'attached' }); await settle(pg, 300);
  ok(/5 needed · 2 planned/.test((await pg.locator('.dcard[data-note="nAir"]').textContent()).replace(/\s+/g, ' ')), 'MediAir note: "5 needed · 2 planned" (only the job’s 2 MediAir, not all 5)');

  // ---- Excel: Summary by pump per model; Any / unknown its own row
  await week(pg);
  await pg.getByRole('button', { name: 'Export to Excel' }).click(); await dlg(pg).getByLabel('Dates').waitFor();
  const [dl] = await Promise.all([pg.waitForEvent('download', { timeout: 60000 }), dlg(pg).getByText('Download .xlsx').click()]);
  const f = out + '/mixed-export.xlsx'; await dl.saveAs(f);
  const ExcelJS = require('exceljs'); const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(f);
  const pu = wb.getWorksheet('Summary by pump'); const head = pu.getRow(1).values.slice(1); const prow = []; pu.eachRow((r, i) => { if (i > 1) prow.push(r.values.slice(1)); });
  const col = (r, h) => r[head.indexOf(h)];
  const other = (m) => prow.filter((r) => r[0] === m).reduce((t, r) => t + (col(r, 'Other units (repair, rework…)') || 0), 0);
  const built = (m) => prow.filter((r) => r[0] === m).reduce((t, r) => t + (col(r, 'Units built (output tasks)') || 0), 0);
  ok(other('QPro 2000') === 3 && other('MediAir') === 2 && other('Mediflex') === 1 && other('Any / unknown pump') === 1, 'export: rework per model (QPro 3, MediAir 2, Mediflex 1, Any / unknown 1)');
  ok(built('QPro 2000') === 3 && built('MediAir') === 2, 'export: the mixed Final assembly job counts per model too');
  const tsRows = []; wb.getWorksheet('Timesheet').eachRow((r, i) => { if (i > 1) tsRows.push(r.values.slice(1).join(' | ')); });
  ok(tsRows.some((r) => /QPro ×3, MediAir ×2, Mediflex ×1, Any \/ unknown ×1/.test(r)), 'export Timesheet: pumps listed per model');
  ok(errs.length === 0, 'no page errors ' + errs.join(';')); await b.close();

  // ---- phone: the per-model list fits
  ({ b, pg, errs } = await login('admin', { width: 390, height: 844 }));
  await pg.goto(BASE + `#/planner?week=${WEEK}`); await pg.waitForSelector('.planner-phone'); await settle(pg, 300);
  await pg.locator('.day-tab').nth(1).click(); await settle(pg, 200);
  await pg.locator('.phone-person', { hasText: 'Amira' }).locator('.chip').first().click(); await settle(pg, 500);
  ok(await dlg(pg).locator('.mix-box').isVisible() && await pg.evaluate(() => { const d = document.querySelector('dialog'); return d.scrollWidth <= d.clientWidth + 1; }), 'phone: the per-model list fits the form');
  await dlg(pg).locator('.mix-box').scrollIntoViewIfNeeded(); await pg.screenshot({ path: out + '/mixed-phone.png' });
  ok(errs.length === 0, 'no page errors ' + errs.join(';')); await b.close(); srv.close();
  console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
})().catch((e) => { console.error(e); process.exit(1); });
