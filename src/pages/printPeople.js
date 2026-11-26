// Print: "Whole team (current layout)" or "One page per person" (A4: landscape for a week,
// portrait for a day). Each person's page is laid out off-screen at its exact printed size and
// shrunk step by step until it fits ONE page:
//   compact spacing → long notes cut to 2 lines (…) → smaller font, down to 7pt → two columns
//   → smaller font again. If it still doesn't fit at 7pt it continues on the next page with
//   "Continued on next page" (never cut off) — and the dialog says so before printing.
import { h, mount, openModal, field, checkbox, reportError } from '../ui.js';
import { auth } from '../auth.js';
import { toISO, fromISO, addDays, mondayOf, today, fmtDayShort, fmtDayLong, fmtDate, fmtRange, isoWeek } from '../dates.js';
import { fmtMin, fmtDur } from '../daytime.js';
import { hoursText, hoursLong, oneOffText } from '../hours.js';
import { ABSENCE_TYPES } from '../jobs.js';
import { busyFreeText } from './dayTimeline.js';

const MIN_PT = 7;
/** Fit steps, tried in order; the last one is the minimum readable size. */
export const FIT_STEPS = [
  { fs: 10 }, { fs: 10, compact: true }, { fs: 10, compact: true, clamp: true },
  ...[9.5, 9, 8.5, 8, 7.5, 7].map((fs) => ({ fs, compact: true, clamp: true })),
  ...[9, 8.5, 8, 7.5, 7].map((fs) => ({ fs, compact: true, clamp: true, cols: 2 })),
];

// ------------------------------------------------------------------ content
/** "09:00–11:00", "15:00–08:00 next day", "cont.–08:00" (a job running over midnight). */
const timeText = (pl) => `${pl.s < 0 ? 'cont.' : fmtMin(pl.s)}–${pl.e > 24 * 60 ? `${fmtMin(pl.e - 24 * 60)} next day` : fmtMin(pl.e)}`;
const PAD = (n) => String(n).padStart(2, '0');
const stamp = () => { const d = new Date(); return `${fmtDate(d)} ${PAD(d.getHours())}:${PAD(d.getMinutes())}`; };

/** "Mon–Fri 08:30–16:30 · Sat–Sun not working" from each day's hours. */
function weekHoursText(ctx, pid, days) {
  const groups = [];
  for (const iso of days) {
    const t = hoursText(ctx.hoursFor(pid, iso));
    const name = fmtDayShort(fromISO(iso)).split(' ')[0];
    const last = groups.at(-1);
    if (last && last.t === t) last.to = name; else groups.push({ t, from: name, to: name });
  }
  return groups.map((g) => `${g.from === g.to ? g.from : `${g.from}–${g.to}`} ${g.t === 'Not working' ? 'not working' : g.t}`).join(' · ');
}

/** Everything one person's page shows, as blocks (a day heading, a job, a note …) + totals. */
function personContent(ctx, person, days, single) {
  const blocks = [];
  const tot = { busy: 0, free: 0, office: 0, prod: 0, units: 0, jobs: 0 };
  for (const iso of days) {
    const hrs = ctx.hoursFor(person.id, iso);
    const day = ctx.dayOf(person.id, iso);
    const absence = ctx.absenceOn(person.id, iso);
    const { attended, background } = ctx.jobsOn(person.id, iso);
    const jobs = [...attended, ...background];
    const weekend = [0, 6].includes(fromISO(iso).getDay());
    if (!single && weekend && !jobs.length && !absence && !hrs.works) continue;
    const off = !hrs.works || absence;
    tot.busy += off ? 0 : day.busyMin; tot.free += off ? 0 : day.freeMin;
    const span = day.we - day.ws;
    const bar = !off && span > 0 ? h('div', { class: 'pp-bar', 'aria-hidden': 'true' },
      day.busy.map(([s, e]) => h('span', { style: `left:${((s - day.ws) / span) * 100}%;width:${((e - s) / span) * 100}%` }))) : null;
    blocks.push({ kind: 'day', iso, el: () => h('div', { class: 'pp-dayhead' },
      h('b', {}, single ? fmtDayLong(fromISO(iso)) : fmtDayShort(fromISO(iso))),
      h('span', { class: 'pp-hrs' }, absence ? (ABSENCE_TYPES[absence.absence_type] || 'Absent') : hrs.works ? hoursText(hrs) : 'Not working'),
      hrs.oneOff ? h('span', { class: 'pp-oneoff' }, `⏰ ${oneOffText(hrs.oneOff)}`) : null,
      !off ? h('span', { class: 'pp-busy' }, busyFreeText(day)) : null,
      bar) });
    if (absence) blocks.push({ kind: 'line', iso, el: () => h('div', { class: 'pp-absence' }, `${ABSENCE_TYPES[absence.absence_type] || 'Absent'}${absence.start_date !== absence.end_date ? ` (${fmtDayShort(fromISO(absence.start_date))} – ${fmtDayShort(fromISO(absence.end_date))})` : ''}`, absence.notes ? ` — ${absence.notes}` : '') });
    const placed = jobs.map((a) => ({ a, pl: a.start_time ? ctx.place(a, iso) : null }))
      .filter((x) => !x.a.start_time || x.pl)
      .sort((x, y) => (x.pl ? x.pl.s : 1e9) - (y.pl ? y.pl.s : 1e9));
    if (!placed.length && !absence) blocks.push({ kind: 'line', iso, el: () => h('div', { class: 'pp-empty' }, hrs.works ? 'Nothing planned' : 'Not a working day') });
    for (const { a, pl } of placed) {
      const task = ctx.taskById.get(a.task_id);
      const type = ctx.typeById.get(a.build_type_id);
      const equip = ctx.equipmentById.get(a.equipment_id);
      const bg = ctx.isBg(a);
      const office = task?.category === 'office';
      const part = ctx.partInfo(a);
      const continuing = iso !== a.work_date || (part && part.n > 1);
      const first = !continuing;
      if (pl && !bg) {
        const work = ctx.workMinutes ? ctx.workMinutes(a, iso) ?? (pl.e - pl.s) : pl.e - pl.s;
        if (office) tot.office += work; else tot.prod += work;
      }
      if (first && !office) tot.units += a.qty_target || 0;
      tot.jobs += 1;
      const pump = office ? null : ctx.pump(a);
      blocks.push({ kind: 'job', iso, el: () => h('div', { class: `pp-job${bg ? ' pp-bg' : ''}${office ? ' pp-office' : ''}`, style: type ? `--type-color:${type.color}` : false },
        h('span', { class: 'pp-time' }, pl ? timeText(pl) : 'No time'),
        h('span', { class: 'pp-what' },
          bg ? h('span', { class: 'pp-mark', title: 'Background' }, '⏱ ') : null,
          office ? h('span', { class: 'pp-mark', title: 'Office' }, '💻 ') : null,
          h('b', {}, task?.name || '?'),
          pump ? ` · ${pump}` : '',
          !office && a.qty_target != null && first && !a.any_pump ? ` ×${a.qty_target}` : '',
          type ? h('span', { class: 'pp-type' }, type.name) : null,
          equip ? h('span', { class: 'pp-station' }, equip.name) : null,
          part ? h('span', { class: 'pp-part' }, `part ${part.n}/${part.total}`) : null,
          a.qty_done != null && first ? h('span', { class: 'pp-done' }, `${a.qty_done} done`) : null,
          a.notes && first ? h('span', { class: 'pp-note' }, a.notes) : null)) });
    }
  }
  return { blocks, tot };
}

// ------------------------------------------------------------------ layout
function header(person, info, cont) {
  return h('header', { class: 'pp-head' },
    h('div', {},
      h('div', { class: 'pp-name' }, person.name, cont ? h('span', { class: 'pp-cont' }, ` — continued (page ${cont})`) : null),
      person.job_title ? h('div', { class: 'pp-role' }, person.job_title) : null),
    h('div', { class: 'pp-meta' },
      h('div', { class: 'pp-period' }, info.period),
      h('div', {}, `Hours: ${info.hours}`),
      h('div', { class: 'pp-printed' }, `Printed by ${info.by} · ${info.when}`)));
}
function totalsEl(tot) {
  return h('div', { class: 'pp-totals' },
    h('span', {}, h('b', {}, fmtDur(tot.busy) || '0m'), ' busy'),
    h('span', {}, h('b', {}, fmtDur(tot.free) || '0m'), ' free'),
    h('span', {}, h('b', {}, fmtDur(tot.prod) || '0m'), ' production'),
    h('span', {}, h('b', {}, fmtDur(tot.office) || '0m'), ' office'),
    h('span', {}, h('b', {}, String(tot.units)), ` unit${tot.units === 1 ? '' : 's'}`),
    h('span', { class: 'pp-muted' }, `${tot.jobs} job${tot.jobs === 1 ? '' : 's'}`));
}
const pageEl = (orient, step) => h('section', {
  class: `pp-page pp-${orient}${step.compact ? ' pp-compact' : ''}${step.clamp ? ' pp-clamp' : ''}${step.cols === 2 ? ' pp-cols2' : ''}`,
  style: `--pp-fs:${step.fs}pt`,
});
const overflows = (page) => page.scrollHeight > page.clientHeight + 1 || page.scrollWidth > page.clientWidth + 1;

/** Group blocks into day sections (a heading and its lines). */
function sections(blocks, { contHead } = {}) {
  const out = []; let cur = null;
  for (const b of blocks) {
    if (b.kind === 'day') { cur = h('div', { class: 'pp-day' }, b.el()); out.push(cur); continue; }
    if (!cur) { cur = h('div', { class: 'pp-day' }, contHead ? contHead() : null); out.push(cur); }
    cur.append(b.el());
  }
  return out;
}

/** One person's page(s), measured inside `host`. → { pages: [el], step } */
function layoutPerson(host, person, content, info, orient) {
  // 1. one page: try each fit step
  for (const step of FIT_STEPS) {
    const page = pageEl(orient, step);
    mount(page, header(person, info), h('div', { class: 'pp-days' }, sections(content.blocks)), totalsEl(content.tot));
    host.append(page);
    if (!overflows(page)) return { pages: [page], step };
    page.remove();
  }
  // 2. still too much at the minimum size: continue on the next page(s) — never cut off
  const step = { fs: MIN_PT, compact: true, clamp: true, cols: 2 };
  const pages = [];
  let page; let days; let dayEl;
  const newPage = () => {
    page = pageEl(orient, step);
    page.classList.add('pp-multi');
    days = h('div', { class: 'pp-days' });
    mount(page, header(person, info, pages.length ? pages.length + 1 : 0), days, h('div', { class: 'pp-footer' }));
    host.append(page); pages.push(page); dayEl = null;
  };
  newPage();
  let lastDay = null;
  for (const b of content.blocks) {
    const place = () => {
      if (b.kind === 'day') { dayEl = h('div', { class: 'pp-day' }, b.el()); days.append(dayEl); lastDay = b; return dayEl; }
      if (!dayEl) {   // first block on a new page: repeat the day heading
        dayEl = h('div', { class: 'pp-day' }, lastDay ? h('div', { class: 'pp-dayhead pp-dayhead-cont' }, h('b', {}, `${fmtDayShort(fromISO(lastDay.iso))} (continued)`)) : null);
        days.append(dayEl);
      }
      const el = b.el(); dayEl.append(el); return el;
    };
    const el = place();
    if (overflows(page)) {
      el.remove();
      if (dayEl && !dayEl.querySelector('.pp-job, .pp-absence, .pp-empty') && b.kind !== 'day') dayEl.remove();
      if (b.kind === 'day' && dayEl) dayEl.remove();
      page.querySelector('.pp-footer').textContent = 'Continued on next page →';
      newPage();
      place();
    }
  }
  const t = totalsEl(content.tot);
  page.insertBefore(t, page.querySelector('.pp-footer'));
  if (overflows(page)) { t.remove(); page.querySelector('.pp-footer').textContent = 'Continued on next page →'; newPage(); page.insertBefore(t, page.querySelector('.pp-footer')); }
  return { pages, step };
}

/**
 * Build every page off-screen (in `host`, which must be in the document) and report.
 * → { results: [{ person, pages: n, step }] }
 */
export function buildPersonPages(host, ctx, { people, period, iso }) {
  const monday = mondayOf(fromISO(iso));
  const days = period === 'day' ? [iso] : [...Array(7)].map((_, i) => toISO(addDays(monday, i)));
  const orient = period === 'day' ? 'portrait' : 'landscape';
  const by = auth.profile?.full_name || auth.profile?.email || auth.session?.user?.email || '—';
  const when = stamp();
  mount(host);
  const results = [];
  for (const person of people) {
    const info = {
      period: period === 'day' ? fmtDayLong(fromISO(iso)) : `Week ${isoWeek(monday)} · ${fmtRange(monday, addDays(monday, 4))}`,
      hours: period === 'day' ? hoursLong(ctx.hoursFor(person.id, iso)) : weekHoursText(ctx, person.id, days),
      by, when,
    };
    const content = personContent(ctx, person, days, period === 'day');
    const r = layoutPerson(host, person, content, info, orient);
    results.push({ person, pages: r.pages.length, step: r.step, jobs: content.tot.jobs });
  }
  return { results };
}

// ------------------------------------------------------------------ printing
/** Print the pages in `host` (moves it into place, prints, puts the app back). */
function printHost(host) {
  host.classList.remove('pp-measure');
  host.classList.add('pp-root');
  document.documentElement.classList.add('pp-printing');
  const done = () => { document.documentElement.classList.remove('pp-printing'); host.remove(); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  window.print();
}

/**
 * The print dialog. layout: 'team' | 'person'; period: 'week' | 'day'; iso: a day of the week shown;
 * personIds: preselected people (null = everyone). onTeam(period, iso): prints the planner as it is.
 */
export async function openPrintDialog({ ctxFor, people, iso, period = 'week', layout = 'team', personIds = null, onTeam }) {
  const monday = mondayOf(fromISO(iso || toISO(today())));
  const weekDays = [...Array(7)].map((_, i) => toISO(addDays(monday, i)));
  const radio = (name, value, label, checked) => { const input = h('input', { type: 'radio', name, value, checked }); return { input, el: h('label', { class: 'check' }, input, h('span', {}, label)) }; };
  const lTeam = radio('pp-layout', 'team', 'Whole team (current layout)', layout === 'team');
  const lPerson = radio('pp-layout', 'person', 'One page per person', layout === 'person');
  const pWeek = radio('pp-period', 'week', `This week (${fmtRange(monday, addDays(monday, 4))}) — A4 landscape`, period === 'week');
  const pDay = radio('pp-period', 'day', 'One day — A4 portrait', period === 'day');
  const daySel = h('select', { 'aria-label': 'Day' }, weekDays.map((d) => h('option', { value: d, selected: d === (iso || weekDays[0]) }, fmtDayLong(fromISO(d)))));
  if (period === 'week' && weekDays.includes(toISO(today()))) daySel.value = toISO(today());
  const active = people.filter((p) => p.active || personIds?.includes(p.id));
  const everyone = checkbox(`Everyone (${active.length})`, !personIds);
  const boxes = active.map((p) => ({ id: p.id, ...checkbox(p.name, personIds ? personIds.includes(p.id) : true) }));
  const peopleBox = h('div', { class: 'check-grid pp-people' }, boxes.map((b) => b.el));
  const fitBox = h('div', { class: 'pp-fit', 'aria-live': 'polite' });
  const error = h('p', { class: 'form-error', role: 'alert' });
  const host = h('div', { class: 'pp-measure', 'aria-hidden': 'true' });
  document.body.append(host);
  let ctx = null;
  let timer = null;

  const chosen = () => (everyone.input.checked ? active : active.filter((p) => boxes.find((b) => b.id === p.id)?.input.checked));
  const state = () => ({ layout: lPerson.input.checked ? 'person' : 'team', period: pDay.input.checked ? 'day' : 'week', iso: pDay.input.checked ? daySel.value : weekDays[0] });
  const sync = () => {
    const s = state();
    daySel.disabled = s.period !== 'day';
    peopleField.hidden = s.layout !== 'person';
    boxes.forEach((b) => { b.input.disabled = everyone.input.checked; if (everyone.input.checked) b.input.checked = true; });
    clearTimeout(timer);
    timer = setTimeout(check, 50);
  };
  /** Lay the pages out now and say which won't fit on one page. */
  async function check() {
    const s = state();
    if (s.layout !== 'person') { mount(fitBox, h('p', { class: 'muted small' }, s.period === 'day' ? 'Prints the Day timeline for that day (A4 landscape).' : 'Prints the week planner as on screen (A4 landscape).')); return null; }
    const list = chosen();
    if (!list.length) { mount(fitBox); return null; }
    ctx = ctx || await ctxFor(weekDays[0]);
    if (!ctx) return null;
    const { results } = buildPersonPages(host, ctx, { people: list, period: s.period, iso: s.iso });
    const over = results.filter((r) => r.pages > 1);
    const small = results.filter((r) => r.pages === 1 && r.step.fs < 9);
    mount(fitBox,
      over.length
        ? over.map((r) => h('p', { class: 'warn-box' }, `⚠ ${r.person.name.split(' ')[0]}’s ${s.period === 'day' ? 'day' : 'week'} needs ${r.pages} pages (${r.jobs} jobs) — it continues on the next page, marked “Continued on next page”.`))
        : h('p', { class: 'ts-line ts-ok' }, `✓ ${results.length} page${results.length === 1 ? '' : 's'} — one per person, everything fits.`),
      small.length ? h('p', { class: 'muted small' }, `Made smaller to fit: ${small.map((r) => `${r.person.name.split(' ')[0]} (${r.step.fs}pt${r.step.cols === 2 ? ', 2 columns' : ''})`).join(', ')}.`) : null);
    return results;
  }
  for (const el of [lTeam.input, lPerson.input, pWeek.input, pDay.input, daySel, everyone.input, ...boxes.map((b) => b.input)]) el.addEventListener('change', sync);
  const peopleField = h('fieldset', { class: 'skills-fieldset' }, h('legend', {}, 'People'), everyone.el, peopleBox);

  const { dialog } = openModal({
    title: 'Print',
    body: h('div', { class: 'stack pp-dialog' },
      h('fieldset', { class: 'skills-fieldset' }, h('legend', {}, 'Layout'), lTeam.el, lPerson.el),
      h('fieldset', { class: 'skills-fieldset' }, h('legend', {}, 'Period'), pWeek.el, h('div', { class: 'inline-row' }, pDay.el, daySel)),
      peopleField, fitBox, error),
    actions: [{ label: 'Cancel' }, {
      label: 'Print', variant: 'primary',
      onClick: async () => {
        const s = state();
        if (s.layout === 'team') { host.remove(); setTimeout(() => onTeam(s.period, s.iso), 50); return true; }
        if (!chosen().length) { error.textContent = 'Tick at least one person.'; return false; }
        const results = await check();
        if (!results) return false;
        setTimeout(() => printHost(host), 50);
        return true;
      },
    }],
  });
  dialog.addEventListener('close', () => { if (!document.documentElement.classList.contains('pp-printing')) setTimeout(() => { if (!document.documentElement.classList.contains('pp-printing')) host.remove(); }, 100); });
  sync();
}

export { reportError };
