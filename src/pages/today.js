import {
  Chart, BarController, BarElement, DoughnutController, ArcElement, LineController, LineElement,
  PointElement, CategoryScale, LinearScale, Tooltip, Filler,
} from 'chart.js';
import { h, mount, reportError, loading, avatar, countUp, enableTips, hhmm } from '../ui.js';
import { supabase } from '../supabase.js';
import { auth } from '../auth.js';
import { toISO, fromISO, addDays, mondayOf, today, isoWeek, fmtDayLong, fmtDayShort, fmtRange } from '../dates.js';
import { loadWeek, makeCtx, ABSENCE_TYPES } from './planner.js';
import { computeSummary, loadSummaryDemand } from './summary.js';
import { coversDay, endDateOf, intervalOf, timeLabel, hm } from '../jobs.js';
import { capacityForDay, capacityAt, level } from '../capacity.js';
import { token, reducedMotion, onThemeChange } from '../theme.js';

Chart.register(BarController, BarElement, DoughnutController, ArcElement, LineController, LineElement,
  PointElement, CategoryScale, LinearScale, Tooltip, Filler);

// Pump-model chart colours (light / dark), in model sort order.
const SERIES_LIGHT = ['#7C1874', '#0F9E8F', '#E8573F', '#2563EB', '#D97706', '#0891B2', '#4D7C0F', '#64748B'];
const SERIES_DARK = ['#E08AD6', '#2DD4BF', '#FF8A73', '#60A5FA', '#FBBF24', '#22D3EE', '#A3E635', '#94A3B8'];
const isDark = () => document.documentElement.dataset.theme === 'dark';
const series = (i) => (isDark() ? SERIES_DARK : SERIES_LIGHT)[i % 8];
/** Build-type colour for the current theme (dark mode lightens the stored colour). */
const typeColour = (hex) => (isDark() ? `color-mix(in srgb, ${hex} 50%, white)` : hex);

let charts = [];
let timers = [];
let currentMain = null;
let placeNow = () => {};
window.addEventListener('resize', () => placeNow(nowMinutes()));
function cleanup() {
  charts.forEach((c) => c.destroy());
  charts = [];
  timers.forEach(clearInterval);
  timers = [];
}
window.addEventListener('hashchange', cleanup);
onThemeChange(() => { if (currentMain?.isConnected && location.hash.replace(/\?.*/, '') === '#/today') renderToday(currentMain); });

function weekFromHash() {
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  const w = q.get('week');
  return mondayOf(w && /^\d{4}-\d{2}-\d{2}$/.test(w) ? fromISO(w) : today());
}

function ago(ts) {
  const d = new Date(ts);
  const mins = (Date.now() - d.getTime()) / 60000;
  if (mins < 1) return 'just now';
  if (mins < 60) return `${Math.round(mins)} min ago`;
  if (mins < 60 * 24 && d.getDate() === new Date().getDate()) return `${Math.round(mins / 60)} h ago`;
  if (mins < 60 * 48) return 'yesterday';
  if (mins < 60 * 24 * 6) return d.toLocaleDateString('en-GB', { weekday: 'long' });
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

const nowMinutes = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
const toMin = (t) => { const [a, b] = String(t).split(':').map(Number); return a * 60 + b; };
const fmtMin = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(Math.round(m % 60)).padStart(2, '0')}`;
const dur = (m) => { m = Math.max(0, Math.round(m)); const hh = Math.floor(m / 60); return hh ? `${hh} h ${m % 60} min` : `${m} min`; };

// ------------------------------------------------------------------ chart defaults
function baseOptions(extra = {}) {
  const grid = token('--line');
  const ticks = token('--muted-c') || token('--muted');
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: reducedMotion() ? false : { duration: 650, easing: 'easeOutCubic' },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: token('--ink'), titleColor: token('--paper'), bodyColor: token('--paper'),
        padding: 10, cornerRadius: 10, titleFont: { family: 'Inter Variable', weight: '600' }, bodyFont: { family: 'Inter Variable' },
        boxPadding: 4,
      },
    },
    scales: {
      x: { grid: { display: false }, border: { color: grid }, ticks: { color: ticks, font: { family: 'Inter Variable', size: 12 } } },
      y: { beginAtZero: true, grid: { color: grid }, border: { display: false }, ticks: { color: ticks, precision: 0, font: { family: 'Inter Variable', size: 12 } } },
    },
    onHover: (e, els) => { e.native.target.style.cursor = els.length ? 'pointer' : 'default'; },
    ...extra,
  };
}

function stripes(colour) {
  const c = document.createElement('canvas');
  c.width = 8; c.height = 8;
  const g = c.getContext('2d');
  g.fillStyle = token('--card'); g.fillRect(0, 0, 8, 8);
  g.strokeStyle = colour; g.lineWidth = 2.2;
  g.beginPath(); g.moveTo(-2, 10); g.lineTo(10, -2); g.moveTo(6, 10); g.lineTo(10, 6); g.moveTo(-2, 2); g.lineTo(2, -2); g.stroke();
  return g.createPattern(c, 'repeat');
}

function addChart(canvas, config) {
  const c = new Chart(canvas, config);
  charts.push(c);
  return c;
}

// ------------------------------------------------------------------ page
export async function renderToday(main) {
  cleanup();
  currentMain = main;
  loading(main);

  const monday = weekFromHash();
  const friday = addDays(monday, 4);
  const todayD = today();
  const todayISO = toISO(todayD);
  const thisMonday = mondayOf(todayD);
  const sameWeek = toISO(thisMonday) === toISO(monday);
  const trendFrom = toISO(addDays(monday, -49));

  const [week, current, demand, feed, profiles, settings, trendRows] = await Promise.all([
    loadWeek(monday),
    sameWeek ? null : loadWeek(thisMonday),
    loadSummaryDemand(),
    supabase.from('demand_notes')
      .select('id, pump_model_id, any_pump, build_type_id, quantity, needed_by, comment, status, created_by, created_at')
      .in('status', ['open', 'planned']).order('created_at', { ascending: false }).limit(6),
    supabase.from('profiles').select('id, full_name, email'),
    supabase.from('app_settings').select('work_start, work_end, break_time, break_minutes, lunch_time, lunch_minutes').eq('id', 1).maybeSingle(),
    supabase.from('assignments').select('work_date, task_id, qty_target').gte('work_date', trendFrom).lte('work_date', toISO(friday)),
  ]);
  const err = week.error || current?.error || demand.error || feed.error || profiles.error || settings.error || trendRows.error;
  if (reportError(err, 'Loading Today')) return;

  const ctx = makeCtx(week);
  const now = makeCtx(current || week); // the current week, for "today"
  const nameOf = new Map(profiles.data.map((p) => [p.id, p.full_name || p.email]));
  const hours = settings.data || { work_start: '08:30', work_end: '16:30', break_time: '10:30', break_minutes: 15, lunch_time: '12:30', lunch_minutes: 30 };
  const summary = computeSummary({
    monday, assignments: week.assignments, notes: demand.notes, tasks: week.tasks, models: week.models, types: week.types,
    allTasks: false, typeFilter: '',
  });
  const planWeek = `#/planner?week=${toISO(monday)}`;

  // ---------------------------------------------------------------- numbers
  const openDemand = demand.notes.filter((n) => n.pump_model_id || n.any_pump).reduce((t, n) => t + (n.quantity || 0), 0);
  const overdue = demand.notes.filter((n) => n.needed_by && n.needed_by < todayISO);
  const absentToday = now.absences.filter((a) => a.start_date <= todayISO && a.end_date >= todayISO);
  const absentPeople = [...new Map(absentToday.map((a) => [a.person_id, a])).values()];
  const personById = new Map(now.people.map((p) => [p.id, p]));
  const bgRunning = now.assignments.filter((a) => now.isBg(a) && coversDay(a, todayISO));

  const firstName = (auth.profile?.full_name || auth.profile?.email || '').split(/[\s@]/)[0];
  const n = nowMinutes();
  const greet = n < 720 ? 'Good morning' : n < 1050 ? 'Good afternoon' : 'Good evening';
  const clock2 = h('b', {}, fmtMin(n));

  const weekPill = h('div', { class: 'week-pill' },
    h('button', { 'aria-label': 'Previous week', onclick: () => { location.hash = `#/today?week=${toISO(addDays(monday, -7))}`; } }, '‹'),
    h('div', { class: 'lbl' }, sameWeek ? 'This week' : `Week ${isoWeek(monday)}`, h('span', {}, `Week ${isoWeek(monday)} · ${fmtRange(monday, friday)}`)),
    h('button', { 'aria-label': 'Next week', onclick: () => { location.hash = `#/today?week=${toISO(addDays(monday, 7))}`; } }, '›'),
  );

  const head = h('div', { class: 'page-head' },
    h('div', {},
      h('img', { class: 'phone-logo', src: 'brand/logo.png', alt: 'Meditec', onerror: (e) => e.target.remove() }),
      h('h1', { class: 'hello' }, `${greet}, `, h('em', {}, firstName || 'there')),
      h('div', { class: 'hello-sub' }, `${fmtDayLong(todayD)} · `, clock2),
    ),
    h('div', { class: 'page-head-actions' },
      weekPill,
      auth.isAdmin ? h('a', { class: 'btn btn-primary', href: planWeek }, '+ Plan work') : null,
    ),
  );

  // ---------------------------------------------------------------- shift strip
  const ws = toMin(hours.work_start); const we = toMin(hours.work_end);
  const brk = [toMin(hours.break_time), toMin(hours.break_time) + (hours.break_minutes || 0)];
  const lunch = [toMin(hours.lunch_time), toMin(hours.lunch_time) + (hours.lunch_minutes || 0)];
  const pct = (m) => Math.min(100, Math.max(0, ((m - ws) / (we - ws)) * 100));
  const clock = h('div', { class: 'clock' }, fmtMin(n));
  const shiftText = h('div', { class: 'what' });
  const fill = h('div', { class: 'fill' });
  const blip = h('div', { class: 'blip' });
  const shift = h('section', { class: 'card shift', 'aria-label': 'Shift progress' },
    h('div', { class: 'now' }, clock, shiftText),
    h('div', { class: 'track' },
      h('span', { class: 'ends' }, `${hhmm(hours.work_start)} start`), h('span', { class: 'ends r' }, `${hhmm(hours.work_end)} finish`),
      h('div', { class: 'bar' }, fill),
      h('div', { class: 'mark', style: `left:${pct(brk[0])}%` }, h('span', {}, `Break ${hhmm(hours.break_time)}`)),
      h('div', { class: 'mark', style: `left:${pct(lunch[0])}%` }, h('span', {}, `Lunch ${hhmm(hours.lunch_time)}`)),
      blip,
    ),
  );
  const weekend = todayD.getDay() === 0 || todayD.getDay() === 6;

  // ---------------------------------------------------------------- stats
  const stat = (num, label, href, cls = '') => {
    const nEl = h('div', { class: 'n' }, '0');
    countUp(nEl, num);
    return h('a', { class: `stat ${cls}`, href }, nEl, h('div', { class: 'l' }, label));
  };
  const stats = h('section', { class: 'card stats', 'aria-label': 'Key numbers' },
    stat(summary.grand.planned, `units planned ${sameWeek ? 'this week' : `in week ${isoWeek(monday)}`}`, planWeek),
    stat(openDemand, 'units of open demand', '#/demand'),
    stat(overdue.length, overdue.length === 1 ? 'demand note overdue' : 'demand notes overdue', '#/demand', overdue.length ? 'alert' : 'good'),
    stat(absentPeople.length, absentPeople.length === 1 ? 'person off today' : 'people off today', `#/planner?week=${toISO(thisMonday)}`),
  );

  // ---------------------------------------------------------------- glance (sentence + grouped bar)
  const planned = summary.grand.planned;
  const needed = summary.grand.demand;
  const gap = planned - needed;
  const worst = summary.groups.slice().sort((a, b) => (a.total.planned - a.total.demand) - (b.total.planned - b.total.demand))[0];
  const num = (v, cls = '') => { const e = h('span', { class: `num ${cls}` }, '0'); countUp(e, v); return e; };
  const sentence = h('p', { class: 'big' },
    num(planned), ` pump${planned === 1 ? '' : 's'} planned against `, num(needed), ' needed by Friday. ',
    !needed && !planned ? 'Nothing planned or due yet.'
      : gap < 0 ? ['We’re ', num(-gap, 'short'), ' short', worst && worst.total.planned - worst.total.demand < 0 ? [' — mostly ', h('b', {}, worst.model.name)] : '', '.']
        : gap > 0 ? ['Covered, with ', num(gap, 'ok'), ' to spare.'] : 'Exactly covered.');
  const facts = h('div', { class: 'facts' },
    overdue.length ? h('span', {}, h('b', { class: 'late' }, String(overdue.length)), ` demand note${overdue.length === 1 ? '' : 's'} overdue`) : null,
    absentPeople.slice(0, 2).map((a) => h('span', {}, h('b', {}, (personById.get(a.person_id)?.name || 'Someone').split(' ')[0]),
      ` ${(ABSENCE_TYPES[a.absence_type] || 'absent').toLowerCase() === 'holiday' ? 'is on holiday' : `is ${ABSENCE_TYPES[a.absence_type]?.toLowerCase() || 'away'}`}`,
      a.end_date > todayISO ? ` until ${fmtDayShort(fromISO(a.end_date))}` : ' today')),
    bgRunning.length ? h('span', {}, h('b', {}, String(bgRunning.length)), ` background job${bgRunning.length === 1 ? '' : 's'} running today`) : null,
  );
  const barCanvas = h('canvas', { 'aria-label': 'Planned versus needed units per pump model', role: 'img' });
  const glance = h('section', { class: 'card glance' },
    h('h2', {}, sameWeek ? 'This week at a glance' : `Week ${isoWeek(monday)} at a glance`),
    sentence,
    summary.groups.length ? h('div', { class: 'chart-box chart-mid' }, barCanvas) : h('p', { class: 'muted' }, 'No pump work or demand for this week yet.'),
    facts.childElementCount ? facts : null,
  );

  // ---------------------------------------------------------------- feed
  const feedList = h('div', { class: 'feed' },
    feed.data.length
      ? feed.data.map((note) => {
          const model = week.modelById.get(note.pump_model_id);
          const type = week.typeById.get(note.build_type_id);
          const who = nameOf.get(note.created_by) || 'Someone';
          const late = note.needed_by && note.needed_by < todayISO;
          const soon = note.needed_by && !late && note.needed_by <= toISO(addDays(todayD, 7));
          return h('a', { class: 'note', href: '#/demand' },
            avatar(who, note.created_by),
            h('div', {},
              h('div', { class: 'meta' }, h('b', {}, who), ` · ${ago(note.created_at)}`),
              h('div', { class: 'txt' }, note.comment || `${note.any_pump ? 'Any / mixed pump' : model?.name || 'General'}${note.quantity != null ? ` × ${note.quantity}` : ''}`),
              h('span', { class: `due ${late ? 'due-overdue' : soon ? 'due-soon' : ''}` },
                note.needed_by ? (late ? 'Overdue' : `By ${fmtDayShort(fromISO(note.needed_by))}`) : 'No date'),
              model ? h('span', { class: 'muted small' }, ` ${model.name}${note.quantity != null ? ` × ${note.quantity}` : ''} `) : null,
              type ? h('span', { class: 'dot-label small', style: `--c:${typeColour(type.color)}` }, type.name) : null,
            ));
        })
      : h('p', { class: 'muted' }, 'No open demand notes.'),
  );
  const feedCard = h('section', { class: 'card' },
    h('h2', {}, 'From the floor'), h('p', { class: 'sub' }, 'Open demand notes, newest first'), feedList);

  // ---------------------------------------------------------------- donut, trend, workload, equipment
  const mix = new Map();
  for (const g of summary.groups) for (const l of g.lines) mix.set(l.typeId, (mix.get(l.typeId) || 0) + l.planned);
  const mixRows = [...mix.entries()].filter(([, v]) => v > 0).map(([id, v]) => {
    const t = week.typeById.get(id);
    return { id, name: t?.name || 'Not specified', colour: t ? typeColour(t.color) : token('--muted-c'), v };
  });
  const mixTotal = mixRows.reduce((t, r) => t + r.v, 0);
  const donutCanvas = h('canvas', { 'aria-label': 'Build type mix', role: 'img' });
  const donutTotal = h('b', {}, '0'); countUp(donutTotal, mixTotal);
  const mixCard = h('section', { class: 'card clickable', onclick: (e) => { if (!e.target.closest('canvas')) location.hash = planWeek; } },
    h('h2', {}, 'What we’re building'), h('p', { class: 'sub' }, 'Planned units by build type'),
    mixTotal
      ? h('div', { class: 'donut-wrap' },
          h('div', { class: 'chart-box', style: 'height:150px' }, donutCanvas, h('div', { class: 'donut-mid' }, h('div', {}, donutTotal, h('span', {}, 'units')))),
          h('div', { class: 'legend-list' }, mixRows.map((r) => h('div', {}, h('span', { class: 'dot-label', style: `--c:${r.colour}` }, r.name), h('b', {}, String(r.v))))))
      : h('p', { class: 'muted' }, 'No units planned yet.'),
  );

  const trendWeeks = [...Array(8)].map((_, i) => addDays(monday, -7 * (7 - i)));
  const outputTask = new Set(week.tasks.filter((t) => t.counts_as_output).map((t) => t.id));
  const trendVals = trendWeeks.map((m) => {
    const a = toISO(m); const b = toISO(addDays(m, 4));
    return trendRows.data.filter((r) => r.work_date >= a && r.work_date <= b && outputTask.has(r.task_id)).reduce((t, r) => t + (r.qty_target || 0), 0);
  });
  const trendCanvas = h('canvas', { 'aria-label': 'Planned units over the last eight weeks', role: 'img' });
  const trendCard = h('section', { class: 'card' },
    h('h2', {}, 'Eight-week trend'), h('p', { class: 'sub' }, 'Planned units per week (final assembly)'),
    h('div', { class: 'chart-box chart-short' }, trendCanvas));

  const weekDays = [0, 1, 2, 3, 4].map((i) => toISO(addDays(monday, i)));
  const workRows = week.people.filter((p) => p.active).map((p) => {
    let att = 0; let bg = 0;
    for (const d of weekDays) { const j = ctx.jobsOn(p.id, d); att += j.attended.length; bg += j.background.length; }
    return { p, att, bg };
  });
  const workCanvas = h('canvas', { 'aria-label': 'Jobs per person this week', role: 'img' });
  const workCard = h('section', { class: 'card' },
    h('h2', {}, 'Who’s carrying what'), h('p', { class: 'sub' }, 'Jobs per day this week · striped = background'),
    workRows.length ? h('div', { class: 'chart-box', style: `height:${Math.max(120, workRows.length * 34 + 30)}px` }, workCanvas) : h('p', { class: 'muted' }, 'No team members yet.'));

  const [weekStart] = intervalOf({ work_date: toISO(monday) });
  const [weekEnd] = intervalOf({ work_date: toISO(addDays(monday, 5)) });
  const equipRows = week.equipment.map((e) => {
    let mins = 0;
    for (const a of week.assignments.filter((x) => x.equipment_id === e.id)) {
      const [s, t] = intervalOf(a);
      mins += Math.max(0, Math.min(t, weekEnd) - Math.max(s, weekStart));
    }
    return { e, hours: Math.round(mins / 6) / 10 };
  }).filter((r) => r.e.active || r.hours);
  const equipCanvas = h('canvas', { 'aria-label': 'Equipment hours booked this week', role: 'img' });
  const equipCard = h('section', { class: 'card' },
    h('h2', {}, 'Equipment this week'), h('p', { class: 'sub' }, 'Hours booked, Monday to Friday (incl. overnight)'),
    equipRows.length ? h('div', { class: 'chart-box', style: `height:${Math.max(110, equipRows.length * 34 + 30)}px` }, equipCanvas) : h('p', { class: 'muted' }, 'No equipment set up.'));

  // ---------------------------------------------------------------- test areas (today)
  const capToday = capacityForDay(now.assignments, now.capacity, todayISO);
  const areaRows = new Map();
  const testCard = h('section', { class: 'card test-card' },
    h('h2', {}, 'Test areas'),
    h('p', { class: 'sub' }, 'Pumps on test right now · today’s peak'),
    capToday.areas.length
      ? h('div', { class: 'test-areas' }, capToday.areas.map((a) => {
          const fillEl = h('span', { class: 'ta-fill' });
          const nowEl = h('b', {}, '0');
          areaRows.set(a.area.id, { fillEl, nowEl, max: a.max });
          return h('a', { class: 'ta-row', href: `#/planner?week=${toISO(thisMonday)}` },
            h('div', { class: 'ta-head' }, h('span', {}, a.area.name), h('span', {}, nowEl, ` / ${a.max} now`)),
            h('div', { class: 'ta-bar' }, fillEl),
            h('div', { class: `ta-peak cap-${level(a.peak, a.max)}` }, a.peak ? `Peak today ${a.peak}/${a.max} at ${a.at}` : 'Nothing on test today'));
        }),
        capToday.limits.filter((l) => l.peak > l.max).map((l) => h('p', { class: 'warn-box' }, `⚠ ${l.limit.name}: ${l.peak}/${l.max} at ${l.at}`)),
        capToday.site.peak > capToday.site.max ? h('p', { class: 'warn-box' }, `⚠ All areas together: ${capToday.site.peak}/${capToday.site.max} at ${capToday.site.at}`) : null)
      : h('p', { class: 'muted' }, auth.isAdmin ? 'Set up test areas in Settings.' : 'No test areas set up.'),
  );
  const updateTestNow = (m) => {
    const [dayStart] = intervalOf({ work_date: todayISO });
    const c = capacityAt(now.assignments, now.capacity, dayStart + m);
    for (const a of c.areas) {
      const r = areaRows.get(a.area.id);
      if (!r) continue;
      r.nowEl.textContent = String(a.peak);
      r.fillEl.style.width = `${Math.min(100, (a.peak / a.max) * 100)}%`;
      r.fillEl.className = `ta-fill cap-${level(a.peak, a.max)}`;
    }
  };

  // ---------------------------------------------------------------- today timeline
  const timeline = todayTimeline({ now, todayISO, hours, weekend });

  mount(main,
    head,
    h('div', { class: 'dash' },
      shift,
      stats,
      h('div', { class: 'dash-row r-2' }, glance, feedCard),
      h('div', { class: 'dash-row r-3' }, mixCard, trendCard, workCard),
      h('div', { class: 'dash-row r-2b' }, timeline.card, h('div', { class: 'dash' }, testCard, equipCard)),
    ),
  );
  enableTips(main);

  // ---------------------------------------------------------------- charts (after mount so they can size)
  const brand = token('--brand');
  const coral = token('--coral-fill');
  if (summary.groups.length) {
    addChart(barCanvas, {
      type: 'bar',
      data: {
        labels: summary.groups.map((g) => g.model.short_code || g.model.name),
        datasets: [
          { label: 'Planned', data: summary.groups.map((g) => g.total.planned), backgroundColor: brand, borderRadius: 6, maxBarThickness: 26 },
          { label: 'Needed by Friday', data: summary.groups.map((g) => g.total.demand), backgroundColor: coral, borderRadius: 6, maxBarThickness: 26 },
        ],
      },
      options: baseOptions({
        plugins: { ...baseOptions().plugins, legend: { display: true, position: 'bottom', labels: { color: token('--muted-c'), usePointStyle: true, pointStyle: 'rectRounded', font: { family: 'Inter Variable' } } } },
        onClick: () => { location.hash = planWeek; },
      }),
    });
  }
  if (mixTotal) {
    addChart(donutCanvas, {
      type: 'doughnut',
      data: { labels: mixRows.map((r) => r.name), datasets: [{ data: mixRows.map((r) => r.v), backgroundColor: mixRows.map((r) => resolveColour(r.colour)), borderColor: token('--card'), borderWidth: 3, hoverOffset: 4 }] },
      options: { ...baseOptions({ cutout: '68%', onClick: () => { location.hash = planWeek; } }), scales: {} },
    });
  }
  addChart(trendCanvas, {
    type: 'line',
    data: {
      labels: trendWeeks.map((m) => `Wk ${isoWeek(m)}`),
      datasets: [{
        data: trendVals, borderColor: brand, borderWidth: 2.5, tension: .35, fill: true,
        backgroundColor: (c) => {
          const { ctx: g, chartArea } = c.chart;
          if (!chartArea) return 'transparent';
          const grad = g.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
          grad.addColorStop(0, hexA(brand, .28)); grad.addColorStop(1, hexA(brand, 0));
          return grad;
        },
        pointBackgroundColor: token('--card'), pointBorderColor: brand, pointBorderWidth: 2, pointRadius: trendVals.map((_, i) => (i === 7 ? 5 : 3)), pointHoverRadius: 6,
      }],
    },
    options: baseOptions({
      onClick: (e, els) => { if (els[0]) location.hash = `#/planner?week=${toISO(trendWeeks[els[0].index])}`; },
      scales: { x: { ...baseOptions().scales.x, ticks: { ...baseOptions().scales.x.ticks, maxRotation: 0, autoSkip: true, autoSkipPadding: 8 } }, y: baseOptions().scales.y },
    }),
  });
  if (workRows.length) {
    addChart(workCanvas, {
      type: 'bar',
      data: {
        labels: workRows.map((r) => r.p.name.split(' ')[0]),
        datasets: [
          { label: 'Attended', data: workRows.map((r) => r.att), backgroundColor: brand, borderRadius: 5, stack: 's', maxBarThickness: 18 },
          { label: 'Background', data: workRows.map((r) => r.bg), backgroundColor: stripes(brand), borderColor: brand, borderWidth: 1, borderRadius: 5, stack: 's', maxBarThickness: 18 },
        ],
      },
      options: baseOptions({
        indexAxis: 'y',
        scales: {
          x: { ...baseOptions().scales.y, stacked: true, grid: { color: token('--line') } },
          y: { ...baseOptions().scales.x, stacked: true },
        },
        onClick: () => { location.hash = planWeek; },
      }),
    });
  }
  if (equipRows.length) {
    addChart(equipCanvas, {
      type: 'bar',
      data: { labels: equipRows.map((r) => r.e.name), datasets: [{ label: 'Hours booked', data: equipRows.map((r) => r.hours), backgroundColor: equipRows.map((_, i) => series(i + 1)), borderRadius: 5, maxBarThickness: 18 }] },
      options: baseOptions({
        indexAxis: 'y',
        scales: { x: { ...baseOptions().scales.y }, y: { ...baseOptions().scales.x } },
        onClick: () => { location.hash = planWeek; },
      }),
    });
  }

  // ---------------------------------------------------------------- live clock (every 20 s)
  const tick = () => {
    const m = nowMinutes();
    clock.textContent = fmtMin(m); clock2.textContent = fmtMin(m);
    fill.style.width = `${pct(m)}%`; blip.style.left = `${pct(m)}%`;
    let t;
    if (weekend) t = 'No shift today — enjoy the weekend';
    else if (m < ws) t = `Shift starts in ${dur(ws - m)}`;
    else if (m >= we) t = 'Shift finished';
    else if (m < brk[0]) t = `Break in ${dur(brk[0] - m)}`;
    else if (m < brk[1]) t = 'Break time';
    else if (m < lunch[0]) t = `Lunch in ${dur(lunch[0] - m)}`;
    else if (m < lunch[1]) t = 'Lunch time';
    else t = `${dur(we - m)} to go`;
    shiftText.textContent = t;
    timeline.placeNow(m);
    updateTestNow(m);
  };
  placeNow = timeline.placeNow;
  requestAnimationFrame(() => requestAnimationFrame(tick));
  timers.push(setInterval(tick, 20000));
}

/** Chart.js can't use color-mix(); resolve any CSS colour to rgb via the browser. */
function resolveColour(c) {
  const el = document.createElement('span');
  el.style.color = c; document.body.append(el);
  const out = getComputedStyle(el).color; el.remove();
  return out;
}
function hexA(colour, a) {
  const c = resolveColour(colour);
  const m = c.match(/[\d.]+/g) || [0, 0, 0];
  return `rgba(${m[0]}, ${m[1]}, ${m[2]}, ${a})`;
}

// ------------------------------------------------------------------ "today on the floor"
function todayTimeline({ now, todayISO, hours, weekend }) {
  const ws = toMin(hours.work_start); const we = toMin(hours.work_end);
  const T0 = Math.floor((ws - 30) / 60) * 60; const T1 = Math.ceil((we + 60) / 60) * 60;
  const pos = (m) => ((Math.min(T1, Math.max(T0, m)) - T0) / (T1 - T0)) * 100;
  const hoursAxis = []; for (let m = T0; m <= T1; m += 60) hoursAxis.push(m);
  const lunch = [toMin(hours.lunch_time), toMin(hours.lunch_time) + (hours.lunch_minutes || 0)];
  const planHref = `#/planner?week=${toISO(mondayOf(fromISO(todayISO)))}`;
  const card = h('section', { class: 'card' }, h('h2', {}, 'Today on the floor'));
  const placeNowFns = [];

  const people = now.people.filter((p) => p.active);
  if (weekend || !people.length) {
    card.append(h('p', { class: 'tl-empty' }, weekend ? 'It’s the weekend — the timeline shows working days.' : 'No team members yet.'));
    return { card, placeNow: () => {} };
  }
  card.append(h('p', { class: 'sub' }, 'Hover a job for details · the red line is now'));

  const jobBlock = (a, start, end, extraCls, label) => {
    const model = now.modelById.get(a.pump_model_id);
    const task = now.taskById.get(a.task_id);
    const type = now.typeById.get(a.build_type_id);
    const tc = type ? typeColour(type.color) : 'var(--muted-c)';
    const warn = now.warningsFor(a, '').length > 0;
    const tl = timeLabel(a, todayISO);
    const tip = [
      [now.pump(a), type?.name, task?.name].filter(Boolean).join(' · '),
      a.qty_target != null ? `Quantity: ${a.qty_target}` : null,
      tl || (extraCls.includes('untimed') ? 'No set time' : null),
      extraCls.includes('bgjob') ? '⏱ Runs in the background' : null,
      a.equipment_id ? `Equipment: ${now.equipmentById.get(a.equipment_id)?.name}` : null,
      warn ? '⚠ Not trained on this pump model' : null,
      a.notes,
    ].filter(Boolean).join('\n');
    return h('a', {
      class: `tjob ${extraCls} ${warn ? 'warn' : ''}`, href: planHref, 'data-tip': tip,
      style: `--tc:${tc};left:${pos(start)}%;width:${Math.max(pos(end) - pos(start) - 0.4, 2.5)}%`,
    },
      label && pos(end) - pos(start) > 24 ? h('span', { class: 'tail' }, label) : null,
      warn ? h('span', { class: 'w' }, '⚠ ') : null,
      extraCls.includes('bgjob') ? '⏱ ' : null,
      a.recurring_id ? '🔁 ' : null,
      h('b', {}, now.pump(a, { short: true }) || task?.name || 'Job'), ' ', now.pump(a) ? h('span', {}, task?.name || '') : null,
    );
  };

  const rows = people.map((p) => {
    const lane = h('div', { class: 'lane' },
      hoursAxis.map((m) => h('span', { class: 'hr', style: `left:${pos(m)}%` })),
      h('span', { class: 'lunch', style: `left:${pos(lunch[0])}%;width:${pos(lunch[1]) - pos(lunch[0])}%` }));
    const absence = now.absenceOn(p.id, todayISO);
    if (absence) {
      const label = ABSENCE_TYPES[absence.absence_type] || 'Away';
      lane.append(h('div', { class: 'tl-off' }, absence.end_date > todayISO ? `${label} until ${fmtDayShort(fromISO(absence.end_date))}` : `${label} today`));
    } else {
      const { attended, background } = now.jobsOn(p.id, todayISO);
      const timed = []; const untimed = [];
      for (const a of attended) {
        const startsToday = a.work_date === todayISO;
        const endsToday = endDateOf(a) === todayISO;
        if ((startsToday && a.start_time) || (!startsToday && endsToday && a.end_time)) {
          const s = startsToday && a.start_time ? toMin(hm(a.start_time)) : T0;
          const e = endsToday && a.end_time ? toMin(hm(a.end_time)) : T1;
          timed.push([a, s, Math.max(e, s + 15)]);
        } else untimed.push(a);
      }
      // jobs without times share the shift evenly, in order
      const slot = untimed.length ? (we - ws) / untimed.length : 0;
      untimed.forEach((a, i) => lane.append(jobBlock(a, ws + i * slot, ws + (i + 1) * slot, 'untimed')));
      timed.forEach(([a, s, e]) => lane.append(jobBlock(a, s, e, '')));
      for (const a of background) {
        const startsToday = a.work_date === todayISO;
        const endsToday = endDateOf(a) === todayISO;
        const s = startsToday && a.start_time ? toMin(hm(a.start_time)) : T0;
        const e = endsToday && a.end_time ? toMin(hm(a.end_time)) : T1;
        const tail = endsToday ? null : `→ ${hm(a.end_time) || ''} ${fmtDayShort(fromISO(endDateOf(a)))}`.replace(/\s+/g, ' ');
        lane.append(jobBlock(a, s, Math.max(e, s + 30), 'bgjob', tail));
      }
    }
    return h('div', { class: 'tl-row' },
      h('div', { class: 'who' }, avatar(p.name, p.id, 'av-sm'), h('div', {}, p.name.split(' ')[0], p.job_title ? h('small', {}, p.job_title) : null)),
      lane);
  });

  const nowline = h('div', { class: 'nowline' });
  const tl = h('div', { class: 'tl' },
    h('div', { class: 'tl-axis' }, h('div'), h('div', { class: 'scale' }, hoursAxis.map((m) => h('span', { style: `left:${pos(m)}%` }, fmtMin(m))))),
    rows, nowline);
  card.append(tl);

  placeNowFns.push((m) => {
    const lane = tl.querySelector('.lane');
    if (!lane) return;
    const r = lane.getBoundingClientRect(); const t = tl.getBoundingClientRect();
    const inside = m >= T0 && m <= T1;
    nowline.style.display = inside ? '' : 'none';
    nowline.style.left = `${r.left - t.left + tl.scrollLeft + ((m - T0) / (T1 - T0)) * r.width}px`;
    nowline.dataset.t = fmtMin(m);
  });
  return { card, placeNow: (m) => placeNowFns.forEach((f) => f(m)) };
}
