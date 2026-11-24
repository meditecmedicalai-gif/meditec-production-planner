import { h, mount, toast, reportError, openModal, confirmDialog, field, loading, hhmm } from '../ui.js';
import { supabase } from '../supabase.js';
import { auth } from '../auth.js';
import { demandPanel } from './demand.js';
import { loadSummaryDemand, summaryCard } from './summary.js';
import { isBackground, coversDay, endDateOf, timeLabel, clashes, hm, pumpLabel, ABSENCE_TYPES } from '../jobs.js';
import { capacityConfig, capacityForDay, level } from '../capacity.js';
import { describe as describeRepeat, matches as repeatMatches } from '../recurring.js';
import { editAssignment, editTemplate, deleteTemplate } from './jobEditor.js';
import {
  toISO, fromISO, addDays, mondayOf, today, isoWeek,
  fmtDayShort, fmtDayLong, fmtWeekday, fmtRange, fmtDate,
} from '../dates.js';

export { ABSENCE_TYPES };

let mobileDay = null;       // selected day index on narrow screens
let extendedOn = null;      // date recurring jobs were last extended (admins, once a day)
let recurringOpen = null;   // recurring panel open/closed (null = automatic)

// ------------------------------------------------------------------ routing
function weekFromHash() {
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  const w = q.get('week');
  const d = w && /^\d{4}-\d{2}-\d{2}$/.test(w) ? fromISO(w) : today();
  return mondayOf(d);
}
const goToWeek = (monday) => { location.hash = `#/planner?week=${toISO(monday)}`; };

// ------------------------------------------------------------------ data
export const JOB_COLUMNS = 'id, person_id, work_date, pump_model_id, any_pump, pump_mix, task_id, build_type_id, qty_target, notes, '
  + 'background, start_time, end_time, end_date, equipment_id, recurring_id, recurring_date, recurring_detached, created_at, updated_at';

export async function loadWeek(monday) {
  const from = toISO(monday);
  const to = toISO(addDays(monday, 4));
  const dayBefore = toISO(addDays(monday, -1));
  const q = {
    people: supabase.from('people').select('id, name, job_title, active').order('name'),
    models: supabase.from('pump_models').select('id, name, short_code, active, sort_order, test_area_id').order('sort_order').order('name'),
    tasks: supabase.from('tasks').select('id, name, requires_pump, counts_as_output, is_background, is_testing, allows_any_pump, active, sort_order').order('sort_order').order('name'),
    types: supabase.from('build_types').select('id, name, color, is_default, active, sort_order').order('sort_order').order('name'),
    skills: supabase.from('person_skills').select('person_id, pump_model_id'),
    // Jobs starting this week, plus ones that started earlier and run into it
    // (overnight from the day before, or with an end date in this week or later).
    assignments: supabase.from('assignments').select(JOB_COLUMNS)
      .lte('work_date', to).or(`work_date.gte.${dayBefore},end_date.gte.${from}`)
      .order('start_time', { nullsFirst: true }).order('created_at'),
    absences: supabase.from('absences').select('id, person_id, start_date, end_date, absence_type, notes').lte('start_date', to).gte('end_date', from),
    equipment: supabase.from('equipment').select('id, name, notes, active, sort_order').order('sort_order').order('name'),
    areas: supabase.from('test_areas').select('id, name, max_pumps, active, sort_order').order('sort_order').order('name'),
    limits: supabase.from('test_limits').select('id, test_area_id, name, max_pumps, active, sort_order').order('sort_order').order('name'),
    limitModels: supabase.from('test_limit_models').select('test_limit_id, pump_model_id'),
    shared: supabase.from('test_area_shared_tasks').select('test_area_id, task_id'),
    settings: supabase.from('app_settings').select('max_pumps_on_test').eq('id', 1).maybeSingle(),
    recurring: supabase.from('recurring_jobs').select('*').eq('active', true).order('created_at'),
  };
  const keys = Object.keys(q);
  const res = await Promise.all(Object.values(q));
  const err = res.find((r) => r.error)?.error;
  if (err) return { error: err };
  const r = Object.fromEntries(keys.map((k, i) => [k, res[i].data]));

  const byId = (rows) => new Map(rows.map((x) => [x.id, x]));
  return {
    people: r.people,
    models: r.models, modelById: byId(r.models),
    tasks: r.tasks, taskById: byId(r.tasks),
    types: r.types, typeById: byId(r.types),
    defaultType: r.types.find((t) => t.is_default) || null,
    skills: new Set(r.skills.map((s) => `${s.person_id}|${s.pump_model_id}`)),
    // drop overnight jobs from Sunday that don't actually reach Monday
    assignments: r.assignments.filter((a) => endDateOf(a) >= from),
    absences: r.absences,
    equipment: r.equipment, equipmentById: byId(r.equipment),
    recurring: r.recurring, recurringById: byId(r.recurring),
    areas: r.areas,
    capacity: capacityConfig({
      areas: r.areas, limits: r.limits, limitModels: r.limitModels, sharedTasks: r.shared,
      models: r.models, tasks: r.tasks, siteMax: r.settings?.max_pumps_on_test ?? 7,
    }),
  };
}

/** Helpers bound to a loaded week. */
export function makeCtx(data) {
  const capCache = new Map();
  return {
    ...data,
    absenceOn(personId, iso) {
      return data.absences.find((a) => a.person_id === personId && a.start_date <= iso && a.end_date >= iso) || null;
    },
    trained(personId, modelId) {
      return data.skills.has(`${personId}|${modelId}`);
    },
    isBg(a) {
      return isBackground(a, data.taskById.get(a.task_id));
    },
    pump(a, opts) {
      return pumpLabel(a, data.modelById, opts);
    },
    /** Jobs covering a day for a person: attended first, then background. */
    jobsOn(personId, iso) {
      const jobs = data.assignments.filter((a) => a.person_id === personId && coversDay(a, iso));
      return { attended: jobs.filter((a) => !this.isBg(a)), background: jobs.filter((a) => this.isBg(a)) };
    },
    /** Test capacity for a day (cached). */
    capDay(iso) {
      if (!capCache.has(iso)) capCache.set(iso, capacityForDay(data.assignments, data.capacity, iso));
      return capCache.get(iso);
    },
    /** Equipment / person time clashes against the loaded week, as messages. */
    clashWarnings(a, personById) {
      const c = clashes(a, data.assignments, data.taskById);
      const out = [];
      for (const o of c.equipment) {
        out.push(`${data.equipmentById.get(a.equipment_id)?.name || 'Equipment'} is also booked for ${personById.get(o.person_id)?.name || 'someone'} (${fmtDayShort(fromISO(o.work_date))}${o.start_time ? ' ' + hm(o.start_time) : ''}).`);
      }
      for (const o of c.person) {
        out.push(`Overlaps another job at ${hm(o.start_time)} (${data.taskById.get(o.task_id)?.name || 'job'}).`);
      }
      return out;
    },
    /** Untrained (skill warnings skip "Any / mixed pump"). */
    warningsFor(a, personName) {
      const out = [];
      const task = data.taskById.get(a.task_id);
      const model = data.modelById.get(a.pump_model_id);
      if (task?.requires_pump && !a.any_pump && model && !data.skills.has(`${a.person_id}|${a.pump_model_id}`)) {
        out.push(`${personName} is not trained on ${model.name}.`);
      }
      return out;
    },
  };
}

const areaShort = (name) => name.replace(/\s*test area$/i, '');

// ------------------------------------------------------------------ page
export async function renderPlanner(main) {
  const monday = weekFromHash();
  const days = [0, 1, 2, 3, 4].map((i) => addDays(monday, i));
  const isoDays = days.map(toISO);
  const todayISO = toISO(today());
  if (mobileDay == null || mobileDay > 4) {
    const i = isoDays.indexOf(todayISO);
    mobileDay = i >= 0 ? i : 0;
  }
  const admin = auth.isAdmin;

  loading(main);
  // Recurring jobs: admins keep them generated 12 weeks ahead (once a day).
  if (admin && extendedOn !== todayISO) {
    const { error } = await supabase.rpc('extend_recurring_jobs');
    if (!error) extendedOn = todayISO;
  }
  const [data, panel, summaryDemand, hoursRes] = await Promise.all([
    loadWeek(monday),
    demandPanel(monday, () => renderPlanner(main)),
    loadSummaryDemand(),
    supabase.from('app_settings').select('work_start, work_end, break_time, lunch_time').eq('id', 1).maybeSingle(),
  ]);
  if (reportError(data.error || summaryDemand.error, 'Loading the planner')) return;
  const hours = hoursRes.data;
  const ctx = makeCtx(data);
  const reload = () => renderPlanner(main);

  // Rows: active people, plus inactive people who still have work/absence this week.
  const busy = new Set([...data.assignments.map((a) => a.person_id), ...data.absences.map((a) => a.person_id)]);
  const rows = data.people.filter((p) => p.active || busy.has(p.id));
  const personById = new Map(data.people.map((p) => [p.id, p]));
  const edit = (opts) => editAssignment({ ctx, isoDays, personById, onSaved: reload, ...opts });

  // ---- recurring occurrences skipped because the person is absent
  const skippedOn = (person, iso) => data.recurring
    .filter((r) => r.person_id === person.id && repeatMatches(r, iso))
    .filter((r) => !data.assignments.some((a) => a.recurring_id === r.id && a.recurring_date === iso));

  // ---- one cell (person × day) — used by both the grid and the phone view
  const cell = (person, iso) => {
    const absence = ctx.absenceOn(person.id, iso);
    const { attended, background } = ctx.jobsOn(person.id, iso);
    const skipped = absence ? skippedOn(person, iso) : [];
    return h('div', { class: 'cell-inner' },
      absence ? absenceBanner(absence, person) : null,
      skipped.map((r) => h('div', { class: 'skipped', title: 'This recurring job was not added because the person is absent' },
        '🔁 ', h('s', {}, r.title || data.taskById.get(r.task_id)?.name || 'Recurring job'), ' — skipped (absent)')),
      attended.map((a) => chip(a, person, absence, iso)),
      background.length ? h('div', { class: 'bg-group' },
        h('span', { class: 'bg-group-label' }, h('span', { 'aria-hidden': 'true' }, '⏱'), ' Running in the background'),
        background.map((a) => chip(a, person, absence, iso)),
      ) : null,
      !admin && !absence && !attended.length && !background.length ? h('span', { class: 'muted small cell-empty' }, 'Nothing planned') : null,
      admin ? h('div', { class: 'cell-actions' },
        h('button', {
          class: 'btn btn-xs btn-ghost',
          title: `Add work for ${person.name}`,
          'aria-label': `Add work for ${person.name} on ${fmtDayLong(fromISO(iso))}`,
          onclick: () => edit({ person, iso }),
        }, '+ Add'),
        absence ? null : h('button', { class: 'btn btn-xs btn-ghost', title: `Mark ${person.name} absent`, onclick: () => editAbsence({ ctx, person, iso, onSaved: reload }) }, 'Absent'),
      ) : null,
    );
  };

  const absenceBanner = (absence, person) => {
    const label = ABSENCE_TYPES[absence.absence_type] || absence.absence_type;
    const range = absence.start_date === absence.end_date
      ? fmtDate(fromISO(absence.start_date))
      : `${fmtDate(fromISO(absence.start_date))} – ${fmtDate(fromISO(absence.end_date))}`;
    return h(admin ? 'button' : 'div', {
      class: `absence absence-${absence.absence_type}`,
      title: `${person.name}: ${label} (${range})${absence.notes ? ` — ${absence.notes}` : ''}`,
      type: admin ? 'button' : false,
      onclick: admin ? () => editAbsence({ ctx, person, absence, onSaved: reload }) : false,
    }, label, absence.notes ? h('span', { class: 'absence-note' }, absence.notes) : null);
  };

  const chip = (a, person, absence, iso) => {
    const pump = ctx.pump(a);
    const task = data.taskById.get(a.task_id);
    const type = data.typeById.get(a.build_type_id);
    const equip = data.equipmentById.get(a.equipment_id);
    const bg = ctx.isBg(a);
    const time = timeLabel(a, iso);
    const continuing = iso !== a.work_date;
    const warnings = ctx.warningsFor(a, person.name);
    // Absence: attended work is flagged on every absent day; a background job
    // only on the day it starts (someone has to set it up).
    if (absence && (!bg || !continuing)) warnings.push(`${person.name} is marked ${ABSENCE_TYPES[absence.absence_type] || 'absent'} this day.`);
    warnings.push(...ctx.clashWarnings(a, personById));
    warnings.push(...(ctx.capDay(iso).jobMsgs.get(a.id) || []).map((m) => `Test capacity — ${m}`));
    const label = [pump, type?.name, task?.name, a.qty_target != null ? a.qty_target : null].filter((x) => x != null).join(' · ');
    return h('button', {
      type: 'button',
      class: `chip ${bg ? 'chip-bg' : 'chip-att'} ${continuing ? 'chip-cont' : ''} ${warnings.length ? 'chip-warn' : ''} ${a.any_pump ? 'chip-any' : ''}`,
      style: type ? `--type-color:${type.color}` : false,
      title: [label, bg ? 'Runs in the background (unattended)' : 'Attended — the person works on this', time,
        equip ? `Equipment: ${equip.name}` : null, a.recurring_id ? 'Recurring job' : null, a.notes,
        ...warnings.map((w) => `⚠ ${w}`)].filter(Boolean).join('\n'),
      onclick: () => (admin ? edit({ person, iso: a.work_date, assignment: a }) : showAssignment(ctx, a, person, warnings)),
    },
      bg ? h('span', { class: 'bg-badge' }, h('span', { 'aria-hidden': 'true' }, '⏱'), ' Background') : null,
      h('span', { class: 'chip-line' },
        warnings.length ? h('span', { class: 'chip-warn-icon', 'aria-label': 'Warning' }, '!') : null,
        a.recurring_id ? h('span', { class: 'chip-repeat', 'aria-label': 'Recurring job', title: 'Recurring job' }, '🔁') : null,
        pump ? h('span', { class: 'chip-model' }, pump) : null,
        type ? typeTag(type) : null,
        h('span', { class: 'chip-task' }, task?.name ?? '?'),
        a.qty_target != null && !continuing ? h('span', { class: 'chip-qty' }, `× ${a.qty_target}`) : null,
      ),
      time || equip ? h('span', { class: 'chip-meta' },
        time ? h('span', { class: 'chip-time' }, time) : null,
        equip ? h('span', { class: 'equip-tag' }, equip.name) : null,
      ) : null,
      a.notes && !continuing ? h('span', { class: 'chip-notes' }, a.notes) : null,
    );
  };

  // ---- test capacity per day
  const capPills = (iso) => {
    const c = ctx.capDay(iso);
    const pills = c.areas.map((a) => {
      const lv = level(a.peak, a.max);
      return h('span', {
        class: `cap-pill cap-${lv}`,
        title: `${a.area.name}: peak ${a.peak} of ${a.max}${a.at && a.peak ? ` at ${a.at}` : ''}`,
      }, `${areaShort(a.area.name)} ${a.peak}/${a.max}`, a.peak ? h('small', {}, ` ${a.at}`) : null);
    });
    for (const l of c.limits.filter((x) => x.peak > x.max)) {
      pills.push(h('span', { class: 'cap-pill cap-over', title: `${l.limit.name}: ${l.peak} of ${l.max} at ${l.at}` }, `${l.limit.name} ${l.peak}/${l.max}`, h('small', {}, ` ${l.at}`)));
    }
    if (c.site.peak > c.site.max) pills.push(h('span', { class: 'cap-pill cap-over', title: `All areas together: ${c.site.peak} of ${c.site.max} at ${c.site.at}` }, `Site ${c.site.peak}/${c.site.max}`, h('small', {}, ` ${c.site.at}`)));
    const detail = [...c.limits.map((l) => `${l.limit.name}: peak ${l.peak}/${l.max}${l.peak ? ` at ${l.at}` : ''}`),
      `All areas: peak ${c.site.peak}/${c.site.max}`, ...[...c.models.values()].map((m) => `${m.name}: ${m.peak} at ${m.at}`)].join('\n');
    return h('div', { class: 'cap-cell', title: detail }, pills.length ? pills : h('span', { class: 'muted small' }, '—'));
  };
  const hasAreas = data.capacity.areas.length > 0;

  // ---- toolbar
  const weekLabel = `Week ${isoWeek(monday)} · ${fmtRange(days[0], days[4])}`;
  const isThisWeek = toISO(mondayOf(today())) === toISO(monday);
  const toolbar = h('div', { class: 'planner-toolbar' },
    h('div', { class: 'week-nav' },
      h('button', { class: 'btn btn-sm', 'aria-label': 'Previous week', onclick: () => goToWeek(addDays(monday, -7)) }, '‹ Prev'),
      h('button', { class: 'btn btn-sm', disabled: isThisWeek, onclick: () => goToWeek(mondayOf(today())) }, 'This week'),
      h('button', { class: 'btn btn-sm', 'aria-label': 'Next week', onclick: () => goToWeek(addDays(monday, 7)) }, 'Next ›'),
      h('h2', { class: 'week-label' }, weekLabel),
    ),
    h('div', { class: 'planner-actions' },
      h('button', { class: 'btn btn-sm', onclick: () => document.getElementById('weekly-summary')?.scrollIntoView({ behavior: 'smooth' }) }, 'Summary ↓'),
      h('button', { class: 'btn btn-sm', title: 'Print this week on A4 landscape', onclick: () => window.print() }, 'Print'),
      admin ? h('button', { class: 'btn btn-sm', onclick: () => copyLastWeek({ ctx, monday, rows, onDone: reload }) }, 'Copy last week') : null,
    ),
  );

  const printHeader = h('div', { class: 'print-only print-header' },
    h('div', {},
      h('div', { class: 'print-title' }, `Pump Room Plan — ${weekLabel}`),
      hours ? h('div', { class: 'print-sub' },
        `Hours ${hhmm(hours.work_start)}–${hhmm(hours.work_end)} · Break ${hhmm(hours.break_time)} · Lunch ${hhmm(hours.lunch_time)}`) : null,
    ),
    h('div', { class: 'print-sub print-right' }, 'Meditec Medical Ltd', h('br'),
      `Printed ${fmtDate(new Date())} by ${auth.profile?.full_name || auth.profile?.email || ''}`),
  );

  const legend = h('div', { class: 'legend' },
    h('span', { class: 'muted small' }, 'Build types:'),
    data.types.filter((t) => t.active).map(typeTag),
    h('span', { class: 'legend-sep', 'aria-hidden': 'true' }),
    h('span', { class: 'legend-att' }, 'Attended job'),
    h('span', { class: 'legend-bg' }, h('span', { 'aria-hidden': 'true' }, '⏱'), ' Background · unattended'),
    h('span', { class: 'legend-sep', 'aria-hidden': 'true' }),
    h('span', { class: 'muted small' }, h('b', { class: 'chip-warn-icon' }, '!'), ' warning · 🔁 recurring'),
  );

  // ---- desktop grid
  const grid = rows.length
    ? h('div', { class: 'table-scroll planner-grid' },
        h('table', { class: 'planner' },
          h('thead', {}, h('tr', {},
            h('th', { class: 'sticky-col', scope: 'col' }, 'Person'),
            days.map((d, i) => h('th', { scope: 'col', class: isoDays[i] === todayISO ? 'is-today' : '' }, fmtDayShort(d))),
          )),
          h('tbody', {},
            hasAreas ? h('tr', { class: 'cap-row' },
              h('th', { class: 'sticky-col', scope: 'row' }, 'Test capacity', h('div', { class: 'muted small' }, 'peak pumps on test')),
              isoDays.map((iso) => h('td', { class: `day-cell ${iso === todayISO ? 'is-today' : ''}` }, capPills(iso)))) : null,
            rows.map((p) => h('tr', { class: p.active ? '' : 'inactive' },
              h('th', { class: 'sticky-col person-cell', scope: 'row' },
                h('div', { class: 'person-name' }, p.name, p.active ? null : h('span', { class: 'tag tag-muted' }, 'inactive')),
                p.job_title ? h('div', { class: 'muted small' }, p.job_title) : null,
              ),
              isoDays.map((iso) => h('td', { class: `day-cell ${iso === todayISO ? 'is-today' : ''}` }, cell(p, iso))),
            ))),
        ))
    : h('div', { class: 'empty' }, admin ? 'Add team members on the People page to start planning.' : 'No team members yet.');

  // ---- phone view: one day at a time
  const dayTabs = h('div', { class: 'day-tabs', role: 'tablist' }, days.map((d, i) =>
    h('button', {
      role: 'tab', 'aria-selected': String(i === mobileDay),
      class: `day-tab ${i === mobileDay ? 'active' : ''} ${isoDays[i] === todayISO ? 'is-today' : ''}`,
      onclick: () => { mobileDay = i; reload(); },
    }, h('span', {}, fmtWeekday(d)), h('span', { class: 'day-num' }, d.getDate())),
  ));
  const phone = h('div', { class: 'planner-phone' },
    dayTabs,
    h('h3', { class: 'phone-day-title' }, fmtDayLong(days[mobileDay])),
    hasAreas ? h('div', { class: 'phone-cap' }, h('span', { class: 'muted small' }, 'Test capacity: '), capPills(isoDays[mobileDay])) : null,
    rows.length
      ? rows.map((p) => h('div', { class: 'phone-person card' },
          h('div', { class: 'person-name' }, p.name, p.job_title ? h('span', { class: 'muted small' }, ` · ${p.job_title}`) : null),
          cell(p, isoDays[mobileDay]),
        ))
      : h('div', { class: 'empty' }, 'No team members yet.'),
  );

  mount(main,
    printHeader,
    h('div', { class: 'page-head no-print' }, h('h1', { class: 'page-title' }, 'Week planner')),
    toolbar,
    panel,
    recurringPanel(ctx, personById, reload),
    legend,
    h('section', { class: 'card card-flush planner-desktop' }, grid),
    phone,
    summaryCard({ monday, data: ctx, notes: summaryDemand.notes, weekLabel }),
  );
}

export function typeTag(type) {
  return h('span', { class: 'type-tag', style: `--type-color:${type.color}` }, type.name);
}

// ------------------------------------------------------------------ recurring panel
function recurringPanel(ctx, personById, reload) {
  const list = ctx.recurring;
  if (!list.length && !auth.isAdmin) return null;
  const unassigned = list.filter((r) => !r.person_id);
  const open = recurringOpen ?? unassigned.length > 0;
  const body = h('div', { class: 'panel-body', hidden: !open },
    list.length
      ? h('ul', { class: 'demand-rows recurring-rows' }, list.map((r) => {
          const task = ctx.taskById.get(r.task_id);
          const person = personById.get(r.person_id);
          const type = ctx.typeById.get(r.build_type_id);
          return h('li', {}, h('div', { class: 'recurring-row' },
            h('div', { class: 'demand-row-main' },
              h('span', { 'aria-hidden': 'true' }, '🔁'),
              h('b', {}, r.title || task?.name || 'Recurring job'),
              h('span', {}, ctx.pump(r) || ''),
              type ? typeTag(type) : null,
              h('span', { class: 'muted small' }, `${describeRepeat(r)}${r.start_time ? ` · ${hm(r.start_time)}–${hm(r.end_time) || '…'}` : ''}`),
            ),
            h('div', { class: 'demand-badges' },
              person ? h('span', { class: 'status status-planned' }, person.name) : h('span', { class: 'status status-unassigned' }, 'Not assigned yet'),
              auth.isAdmin ? h('button', { class: `btn btn-sm ${person ? '' : 'btn-primary'}`, onclick: () => editTemplate({ ctx, template: r, personById, onSaved: reload }) }, person ? 'Edit' : 'Assign…') : null,
              auth.isAdmin ? h('button', { class: 'btn btn-sm btn-ghost', onclick: () => deleteTemplate({ template: r, onDone: reload }) }, 'Stop') : null,
            )));
        }))
      : h('p', { class: 'muted small panel-empty' }, 'No recurring jobs yet. Use "Repeat" when adding work.'),
    auth.isAdmin ? h('div', { class: 'panel-foot' },
      h('button', { class: 'btn btn-sm', onclick: () => editTemplate({ ctx, template: null, personById, onSaved: reload }) }, '+ New recurring job'),
      h('span', { class: 'muted small' }, 'Jobs are created up to 12 weeks ahead and kept topped up automatically.'),
    ) : null,
  );
  const toggle = h('button', {
    class: 'panel-toggle', 'aria-expanded': String(open),
    onclick: () => { recurringOpen = body.hidden; body.hidden = !body.hidden; toggle.setAttribute('aria-expanded', String(!body.hidden)); },
  },
    h('span', { class: 'panel-caret', 'aria-hidden': 'true' }, '▸'),
    h('span', { class: 'panel-title' }, `🔁 Recurring jobs (${list.length})`),
    unassigned.length ? h('span', { class: 'due due-soon' }, `${unassigned.length} waiting for a person`) : null,
  );
  return h('section', { class: 'card demand-panel recurring-panel no-print' }, toggle, body);
}

// ------------------------------------------------------------------ view (viewer)
function showAssignment(ctx, a, person, warnings) {
  const task = ctx.taskById.get(a.task_id);
  const type = ctx.typeById.get(a.build_type_id);
  const r = a.recurring_id ? ctx.recurringById.get(a.recurring_id) : null;
  openModal({
    title: `${person.name} · ${fmtDayLong(fromISO(a.work_date))}`,
    body: h('div', { class: 'stack' },
      h('dl', { class: 'details' },
        h('dt', {}, 'Task'), h('dd', {}, task?.name ?? '—'),
        h('dt', {}, 'Pump'), h('dd', {}, ctx.pump(a) ?? '—'),
        h('dt', {}, 'Build type'), h('dd', {}, type ? typeTag(type) : '—'),
        h('dt', {}, 'Quantity'), h('dd', {}, a.qty_target ?? '—'),
        h('dt', {}, 'Time'), h('dd', {}, timeLabel(a, a.work_date) || 'All day'),
        h('dt', {}, 'Runs'), h('dd', {}, ctx.isBg(a) ? '⏱ In the background (unattended)' : 'Attended'),
        h('dt', {}, 'Equipment'), h('dd', {}, ctx.equipmentById.get(a.equipment_id)?.name ?? '—'),
        a.recurring_id ? [h('dt', {}, 'Repeats'), h('dd', {}, `🔁 ${r ? describeRepeat(r) : 'Recurring job'}`)] : null,
        h('dt', {}, 'Notes'), h('dd', { class: 'pre' }, a.notes || '—'),
      ),
      warnings.map((w) => h('p', { class: 'warn-box' }, `⚠ ${w}`)),
    ),
    actions: [{ label: 'Close' }],
  });
}

// ------------------------------------------------------------------ absences
function editAbsence({ person, iso, absence, onSaved }) {
  const typeSel = h('select', {}, Object.entries(ABSENCE_TYPES).map(([k, v]) => {
    const o = h('option', { value: k }, v);
    if (k === (absence?.absence_type ?? 'holiday')) o.selected = true;
    return o;
  }));
  const start = h('input', { type: 'date', value: absence?.start_date ?? iso, required: true });
  const end = h('input', { type: 'date', value: absence?.end_date ?? iso, required: true });
  start.addEventListener('change', () => { if (end.value < start.value) end.value = start.value; });
  const notes = h('input', { type: 'text', maxlength: 200, value: absence?.notes ?? '', placeholder: 'e.g. booked holiday, first-aid course' });
  const error = h('p', { class: 'form-error', role: 'alert' });

  const actions = [];
  if (absence) {
    actions.push({
      label: 'Delete',
      variant: 'danger',
      onClick: async () => {
        if (!(await confirmDialog('Remove absence?', `Remove this absence for ${person.name}?`, 'Remove'))) return false;
        const { error: err } = await supabase.from('absences').delete().eq('id', absence.id);
        if (reportError(err, 'Removing')) return false;
        // Recurring jobs skipped for this absence come back on the next refresh.
        extendedOn = null;
        toast('Absence removed.', 'success');
        onSaved();
        return true;
      },
    });
  }
  actions.push({ label: 'Cancel' }, {
    label: 'Save',
    variant: 'primary',
    onClick: async () => {
      if (!start.value || !end.value) { error.textContent = 'Please choose the dates.'; return false; }
      if (end.value < start.value) { error.textContent = 'The end date is before the start date.'; return false; }
      const values = { person_id: person.id, absence_type: typeSel.value, start_date: start.value, end_date: end.value, notes: notes.value.trim() || null };
      const { count } = await supabase.from('assignments').select('id', { count: 'exact', head: true })
        .eq('person_id', person.id).gte('work_date', start.value).lte('work_date', end.value);
      if (count) {
        const ok = await confirmDialog('Work already planned',
          `${person.name} has ${count} job${count === 1 ? '' : 's'} planned in this period. They will be flagged with ⚠ so you can move them. Save the absence?`,
          'Save absence', 'primary');
        if (!ok) return false;
      }
      const { error: err } = absence
        ? await supabase.from('absences').update(values).eq('id', absence.id)
        : await supabase.from('absences').insert(values);
      if (reportError(err, 'Saving absence')) return false;
      toast('Absence saved.', 'success');
      onSaved();
      return true;
    },
  });

  openModal({
    title: `${absence ? 'Edit' : 'Mark'} absence · ${person.name}`,
    body: h('div', { class: 'stack' },
      field('Type', typeSel),
      h('div', { class: 'form-grid form-grid-2' }, field('From', start), field('To (inclusive)', end)),
      field('Notes', notes),
      error,
    ),
    actions,
  });
}

// ------------------------------------------------------------------ copy last week
async function copyLastWeek({ ctx, monday, rows, onDone }) {
  const prevFrom = toISO(addDays(monday, -7));
  const prevTo = toISO(addDays(monday, -3));
  const { data: prev, error } = await supabase.from('assignments')
    .select('person_id, work_date, pump_model_id, any_pump, pump_mix, task_id, build_type_id, qty_target, notes, background, start_time, end_time, end_date, equipment_id, recurring_id')
    .gte('work_date', prevFrom).lte('work_date', prevTo).order('created_at');
  if (reportError(error, 'Loading last week')) return;
  if (!prev.length) { toast('Last week has nothing planned to copy.'); return; }

  const activePerson = new Set(rows.filter((p) => p.active).map((p) => p.id));
  const isActive = (map, id) => !id || map.get(id)?.active;
  const copies = [];
  let skippedAbsent = 0;
  let skippedInactive = 0;
  let skippedRecurring = 0;
  for (const a of prev) {
    if (a.recurring_id) { skippedRecurring++; continue; } // recurring jobs repeat by themselves
    const date = toISO(addDays(fromISO(a.work_date), 7));
    if (!activePerson.has(a.person_id) || !isActive(ctx.modelById, a.pump_model_id)
        || !isActive(ctx.taskById, a.task_id) || !isActive(ctx.typeById, a.build_type_id)
        || !isActive(ctx.equipmentById, a.equipment_id)) { skippedInactive++; continue; }
    if (ctx.absenceOn(a.person_id, date)) { skippedAbsent++; continue; }
    const { recurring_id: _r, ...rest } = a;
    copies.push({ ...rest, work_date: date, end_date: a.end_date ? toISO(addDays(fromISO(a.end_date), 7)) : null });
  }

  const existing = ctx.assignments.filter((a) => a.work_date >= toISO(monday) && !a.recurring_id).length;
  const parts = [`Copy ${copies.length} job${copies.length === 1 ? '' : 's'} from last week into this week (same people, days and quantities).`];
  if (existing) parts.push(`This week already has ${existing} job${existing === 1 ? '' : 's'}; the copies are added alongside them.`);
  if (skippedRecurring) parts.push(`${skippedRecurring} recurring job${skippedRecurring === 1 ? ' is' : 's are'} not copied — they repeat by themselves.`);
  if (skippedAbsent) parts.push(`${skippedAbsent} skipped because the person is absent.`);
  if (skippedInactive) parts.push(`${skippedInactive} skipped because a person, pump model, task, build type or equipment is inactive.`);
  if (!copies.length) { toast(parts.slice(1).join(' ') || 'Nothing to copy.'); return; }

  if (!(await confirmDialog('Copy last week?', parts.join(' '), 'Copy', 'primary'))) return;
  const { error: err } = await supabase.from('assignments').insert(copies);
  if (reportError(err, 'Copying')) return;
  toast(`Copied ${copies.length} job${copies.length === 1 ? '' : 's'}.`, 'success');
  onDone();
}
