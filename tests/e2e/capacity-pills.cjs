const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const mock = require('./mockdb.cjs');
// Layout check for the Test capacity row: every pill must stay inside its own day column
// (week grid at 1280 / 1440 / 1920 px and phone, light and dark), the occupancy graph has its
// own line, and the Day timeline capacity strip / bench row stay inside.
// Run:  npm run test:layout   (needs Playwright + Chromium: npm i -D playwright && npx playwright install chromium)
// Uses an in-memory mock of Supabase (mockdb.cjs) — no real data is touched.
const root = process.argv[2] || 'dist-test', out = process.argv[3] || require('os').tmpdir();
const srv = http.createServer((q, r) => { let p = path.join(root, decodeURIComponent(q.url.split('?')[0])); if (p.endsWith('/')) p += 'index.html';
  fs.readFile(p, (e, d) => { if (e) { r.writeHead(404); return r.end(); } const ext = path.extname(p); r.writeHead(200, { 'content-type': { '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2' }[ext] || 'text/html' }); r.end(d); }); }).listen(5192);
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
const D = (i) => iso(add(mon, i));
db.person_skills.push({ person_id: 'pE', pump_model_id: M('Mediflex') }, { person_id: 'pB', pump_model_id: M('Simplex') });
// every day of the week: a long bench batch, Quality Check near/over its limit, a limit group over, an untimed test job
for (let i = 0; i < 5; i++) {
  J('pE', D(i), 'Mediflex', 'Quality testing', 'Customer', 10, { start_time: '13:30:00', end_time: '17:00:00', equipment_id: E('Medicare / Mediflex test bench') });
  J('pA', D(i), 'QPro 2000', 'Quality testing', 'Production', 6, { start_time: '08:30:00', end_time: '11:00:00', equipment_id: E('Quality Check') });
  J('pB', D(i), 'Simplex', 'Functional test / calibration', 'Production', 4, { start_time: '10:00:00', end_time: '12:00:00' });
  J('pD', D(i), 'MediAir', 'Functional test / calibration', 'Production', 3, { start_time: '10:30:00', end_time: '11:30:00' });
  J('pC', D(i), 'QPro 2000', 'Quality testing', 'Production', 2, {});
}
// two overlapping bench jobs on Wednesday → overlap warning pill
J('pD', D(2), 'Medicare', 'Soak / burn-in test', 'Customer', 3, { start_time: '15:00:00', end_time: '16:00:00', equipment_id: E('Medicare / Mediflex test bench') });
let fails = 0; const ok = (c, msg) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + msg); };
const BASE = 'http://localhost:5192/';
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

/** Every pill / graph / wrapper inside the capacity cells must stay inside its own cell; text never sits on the graph. */
async function checkContained(pg, cellSel, tag) {
  const bad = await pg.evaluate((sel) => {
    const out = [];
    for (const cell of document.querySelectorAll(sel)) {
      if (!cell.offsetParent) continue;
      const c = cell.getBoundingClientRect();
      for (const el of cell.querySelectorAll('.cap-pill, .cap-wrap, .cap-spark, .cap-pill-l, .cap-pill-t')) {
        if (!el.offsetParent && getComputedStyle(el).position !== 'fixed') continue;
        const r = el.getBoundingClientRect();
        if (!r.width) continue;
        if (r.right > c.right + 0.5 || r.left < c.left - 0.5) out.push(`${el.className} [${Math.round(r.left)}–${Math.round(r.right)}] outside cell [${Math.round(c.left)}–${Math.round(c.right)}] "${el.textContent.slice(0, 40)}"`);
      }
      for (const w of cell.querySelectorAll('.cap-wrap')) {
        const spark = w.querySelector('.cap-spark'); const pill = w.querySelector('.cap-pill');
        if (spark && pill && pill.getBoundingClientRect().bottom > spark.getBoundingClientRect().top + 0.5) out.push(`pill text overlaps the graph: "${pill.textContent}"`);
      }
      const pills = [...cell.querySelectorAll(':scope .cap-cell > .cap-pill, :scope .cap-cell > .cap-wrap')].map((e) => e.getBoundingClientRect());
      for (let i = 0; i < pills.length; i++) for (let j = i + 1; j < pills.length; j++) {
        const a = pills[i], b = pills[j];
        if (a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5) out.push('two pills overlap each other');
      }
    }
    return out;
  }, cellSel);
  ok(bad.length === 0, `${tag}: every capacity pill stays inside its column${bad.length ? ' — ' + bad.slice(0, 3).join(' | ') : ''}`);
}

(async () => {
  const b = await chromium.launch();
  for (const scheme of ['light', 'dark']) {
    for (const width of [1280, 1440, 1920]) {
      const ctx = await b.newContext({ viewport: { width, height: 1000 }, timezoneId: 'Europe/London', colorScheme: scheme });
      const pg = await ctx.newPage(); const errs = []; pg.on('pageerror', (e) => errs.push(e.message));
      await pg.route('https://example.supabase.co/**', mock('admin', db)); await mock.mockRealtime(pg);
      await pg.goto(BASE); await pg.fill('#email', 'p@x.com'); await pg.fill('#password', 'x'); await pg.click('button[type=submit]');
      await pg.waitForSelector('#main[data-loaded="1"]');
      await pg.goto(BASE + `#/planner?week=${D(0)}`); await pg.waitForSelector('.cap-row'); await settle(pg, 600);
      ok(await pg.evaluate(() => document.documentElement.dataset.theme) === scheme, `${scheme} ${width}px: theme applied`);
      await checkContained(pg, '.cap-row td.day-cell', `week ${scheme} ${width}px`);
      const mon0 = pg.locator('.cap-row td.day-cell').nth(0);
      const pillText = (await mon0.locator('.cap-seq').innerText()).replace(/\s+/g, ' ');
      ok(/^Bench busy 13:30–17:00$/.test(pillText), `${scheme} ${width}px: short bench label "${pillText}" (detail moved to the popover)`);
      ok(!/pumps|min each/.test(pillText), `${scheme} ${width}px: no pump count / minutes in the pill itself`);
      if (width === 1280) {
        await mon0.locator('.cap-seq').hover(); await settle(pg, 150);
        const pop = mon0.locator('.cap-wrap', { has: pg.locator('.cap-seq') }).locator('.cap-pop');
        ok(await pop.isVisible() && /10 pumps · ~21 min each/.test(await pop.innerText()), `${scheme}: popover has "10 pumps · ~21 min each"`);
        const vw = await pg.evaluate(() => document.documentElement.clientWidth);
        await pg.locator('.cap-row td.day-cell').nth(4).locator('.cap-wrap').first().hover(); await settle(pg, 150);
        const pr = await pg.locator('.cap-row td.day-cell').nth(4).locator('.cap-pop').first().boundingBox();
        ok(pr && pr.x + pr.width <= vw + 1, `${scheme}: Friday’s popover opens leftwards and stays on screen`);
        ok(/overlap/.test(await pg.locator('.cap-row td.day-cell').nth(2).locator('.cap-seq').innerText()), `${scheme}: Wednesday bench overlap shown in the pill (wrapped)`);
        await pg.mouse.move(5, 5);
        await pg.evaluate(() => { const g = document.querySelector('.planner-grid'); if (g) g.scrollLeft = 0; }); await settle(pg, 150);
        await pg.locator('.cap-row').screenshot({ path: out + `/fix-caprow-${scheme}-${width}.png` });
      } else {
        await pg.locator('.cap-row').screenshot({ path: out + `/fix-caprow-${scheme}-${width}.png` });
      }
      // Day timeline: top capacity strip + bench row
      await pg.goto(BASE + `#/planner?view=day&day=${D(0)}`); await pg.waitForSelector('.dt-grid'); await settle(pg, 500);
      const dtBad = await pg.evaluate(() => {
        const out = [];
        const box = document.querySelector('.dt-cap').getBoundingClientRect();
        for (const el of document.querySelectorAll('.dt-cap .cap-pill')) { const r = el.getBoundingClientRect(); if (r.right > box.right + 0.5) out.push('strip pill past the edge: ' + el.textContent); }
        for (const el of document.querySelectorAll('.dt-bench')) {
          const t = el.closest('.dt-track').getBoundingClientRect(); const r = el.getBoundingClientRect();
          if (r.right > t.right + 0.5) out.push('bench block past the track');
          if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflow !== 'hidden') out.push('bench text spills');
        }
        return out;
      });
      ok(dtBad.length === 0, `day timeline ${scheme} ${width}px: capacity strip and bench row stay inside${dtBad.length ? ' — ' + dtBad.join(' | ') : ''}`);
      if (width === 1440) await pg.locator('.day-timeline').screenshot({ path: out + `/fix-day-${scheme}.png` });
      ok(errs.length === 0, `${scheme} ${width}px: no page errors ${errs.join(';')}`);
      await ctx.close();
    }
    // phone
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Europe/London', colorScheme: scheme, deviceScaleFactor: 2 });
    const pg = await ctx.newPage();
    await pg.route('https://example.supabase.co/**', mock('admin', db)); await mock.mockRealtime(pg);
    await pg.goto(BASE); await pg.fill('#email', 'p@x.com'); await pg.fill('#password', 'x'); await pg.click('button[type=submit]');
    await pg.waitForSelector('#main[data-loaded="1"]');
    await pg.goto(BASE + `#/planner?week=${D(0)}`); await pg.waitForSelector('.phone-cap'); await settle(pg, 500);
    const phoneBad = await pg.evaluate(() => {
      const box = document.querySelector('.phone-cap').getBoundingClientRect(); const out = [];
      for (const el of document.querySelectorAll('.phone-cap .cap-pill, .phone-cap .cap-wrap, .phone-cap .cap-spark')) { const r = el.getBoundingClientRect(); if (r.width && r.right > box.right + 0.5) out.push(el.className + ' ' + el.textContent.slice(0, 30)); }
      return out;
    });
    ok(phoneBad.length === 0 && await pg.evaluate(() => document.documentElement.scrollWidth) <= 390, `phone ${scheme}: capacity pills stay on screen${phoneBad.length ? ' — ' + phoneBad.join(' | ') : ''}`);
    await pg.locator('.phone-cap').screenshot({ path: out + `/fix-phone-${scheme}.png` });
    await pg.goto(BASE + `#/planner?view=day&day=${D(0)}`); await pg.waitForSelector('.dt-grid'); await settle(pg, 400);
    ok(await pg.evaluate(() => document.documentElement.scrollWidth) <= 390, `phone ${scheme}: Day timeline page doesn’t scroll sideways`);
    await ctx.close();
  }
  await b.close(); srv.close();
  console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
})().catch((e) => { console.error(e); process.exit(1); });
