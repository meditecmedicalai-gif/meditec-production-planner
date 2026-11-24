import { h, mount, toast, reportError, openModal, confirmDialog, field, checkbox, loading } from '../ui.js';
import { supabase } from '../supabase.js';
import { auth } from '../auth.js';
import { demandPanel } from './demand.js';
import { loadSummaryDemand, summaryCard } from './summary.js';
import { hhmm } from '../ui.js';
import { isBackground, coversDay, endDateOf, timeLabel, clashes, overlaps, hm } from '../jobs.js';
import {
  toISO, fromISO, addDays, mondayOf, today, isoWeek,
  fmtDayShort, fmtDayLong, fmtWeekday, fmtRange, fmtDate,
} from '../dates.js';

export const ABSENCE_TYPES = {
  holiday: 'Holiday',
  sick: 'Sick',
  training: 'Training',
  off_site: 'Off-site',
};

let mobileDay = null; // selected day index on narrow screens

// ------------------------------------------------------------------ routing
function weekFromHash() {
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  const w = q.get('week');
  const d = w && /^\d{4}-\d{2}-\d{2}$/.test(w) ? fromISO(w) : today();
  return mondayOf(d);
}
const goToWeek = (monday) => { location.hash = `#/planner?week=${toISO(monday)}`; };

// ------------------------------------------------------------------ data
export async function loadWeek(monday) {
  const from = toISO(monday);
  const to = toISO(addDays(monday, 4));
  const dayBefore = toISO(addDays(monday, -1));
  const [people, models, tasks, types, skills, assignments, absences, equipment] = await Promise.all([
    supabase.from('people').select('id, name, job_title, active').order('name'),
    supabase.from('pump_models').select('id, name, short_code, active, sort_order').order('sort_order').order('name'),
    supabase.from('tasks').select('id, name, requires_pump, counts_as_output, is_background, active, sort_order').order('sort_order').order('name'),
    supabase.from('build_types').select('id, name, color, is_default, active, sort_order').order('sort_order').order('name'),
    supabase.from('person_skills').select('person_id, pump_model_id'),
    supabase.from('assignments')
      .select(JOB_COLUMNS)
      // Jobs starting this week, plus ones that started earlier and run into it
      // (overnight from the day before, or with an end date in this week or later).
      .lte('work_date', to).or(`work_date.gte.${dayBefore},end_date.gte.${from}`)
      .order('start_time', { nullsFirst: true }).order('created_at'),
    supabase.from('absences')
      .select('id, person_id, start_date, end_date, absence_type, notes')
      .lte('start_date', to).gte('end_date', from),
    supabase.from('equipment').select('id, name, notes, active, sort_order').order('sort_order').order('name'),
  ]);
  const err = [people, models, tasks, types, skills, assignments, absences, equipment].find((r) => r.error)?.error;
  if (err) return { error: err };

  const byId = (rows) => new Map(rows.map((r) => [r.id, r]));
  return {
    people: people.data,
    models: models.data, modelById: byId(models.data),
    tasks: tasks.data, taskById: byId(tasks.data),
    types: types.data, typeById: byId(types.data),
    defaultType: types.data.find((t) => t.is_default) || null,
    skills: new Set(skills.data.map((s) => `${s.person_id}|${s.pump_model_id}`)),
    // drop overnight jobs from Sunday that don't actually reach Monday
    assignments: assignments.data.filter((a) => endDateOf(a) >= from),
    absences: absences.data,
    equipment: equipment.data, equipmentById: byId(equipment.data),
  };
}

const JOB_COLUMNS = 'id, person_id, work_date, pump_model_id, task_id, build_type_id, qty_target, notes, '
  + 'background, start_time, end_time, end_date, equipment_id, created_at, updated_at';

/** Helpers bound to a loaded week. */
export function makeCtx(data) {
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
    /** Jobs covering a day for a person: attended first, then background. */
    jobsOn(personId, iso) {
      const jobs = data.assignments.filter((a) => a.person_id === personId && coversDay(a, iso));
      return {
        attended: jobs.filter((a) => !this.isBg(a)),
        background: jobs.filter((a) => this.isBg(a)),
      };
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
    /** Problems with a (proposed) assignment: untrained / absent. */
    warningsFor(a, personName) {
      const out = [];
      const task = data.taskById.get(a.task_id);
      const model = data.modelById.get(a.pump_model_id);
      if (task?.requires_pump && model && !data.skills.has(`${a.person_id}|${a.pump_model_id}`)) {
        out.push(`${personName} is not trained on ${model.name}.`);
      }
      return out;
    },
  };
}

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

  loading(main);
  const [data, panel, summaryDemand, hoursRes] = await Promise.all([
    loadWeek(monday),
    demandPanel(monday, () => renderPlanner(main)),
    loadSummaryDemand(),
    supabase.from('app_settings').select('work_start, work_end, break_time, lunch_time').eq('id', 1).maybeSingle(),
  ]);
  if (reportError(data.error || summaryDemand.error, 'Loading the planner')) return;
  const hours = hoursRes.data;
  const ctx = makeCtx(data);
  const admin = auth.isAdmin;
  const reload = () => renderPlanner(main);

  // Rows: active people, plus inactive people who still have work/absence this week.
  const busy = new Set([...data.assignments.map((a) => a.person_id), ...data.absences.map((a) => a.person_id)]);
  const rows = data.people.filter((p) => p.active || busy.has(p.id));
  const personById = new Map(data.people.map((p) => [p.id, p]));

  // ---- one cell (person × day) — used by both the grid and the phone view
  const cell = (person, iso) => {
    const absence = ctx.absenceOn(person.id, iso);
    const { attended, background } = ctx.jobsOn(person.id, iso);
    return h('div', { class: 'cell-inner' },
      absence ? absenceBanner(absence, person) : null,
      attended.map((a) => chip(a, person, absence, iso)),
      background.length ? h('div', { class: 'bg-group' },
        h('span', { class: 'bg-group-label' }, '⏱ Background'),
        background.map((a) => chip(a, person, absence, iso)),
      ) : null,
      !admin && !absence && !attended.length && !background.length ? h('span', { class: 'muted small cell-empty' }, 'Nothing planned') : null,
      admin ? h('div', { class: 'cell-actions' },
        h('button', {
          class: 'btn btn-xs btn-ghost',
          title: `Add work for ${person.name}`,
          'aria-label': `Add work for ${person.name} on ${fmtDayLong(fromISO(iso))}`,
          onclick: () => editAssignment({ ctx, person, iso, isoDays, personById, onSaved: reload }),
        }, '+ Add'),
        absence ? null : h('button', {
          class: 'btn btn-xs btn-ghost',
          title: `Mark ${person.name} absent`,
          onclick: () => editAbsence({ ctx, person, iso, onSaved: reload }),
        }, 'Absent'),
      ) : null,
    );
  };

  const absenceBanner = (absence, person) => {
    const label = ABSENCE_TYPES[absence.absence_type] || absence.absence_type;
    const range = absence.start_date === absence.end_date
      ? fmtDate(fromISO(absence.start_date))
      : `${fmtDate(fromISO(absence.start_date))} – ${fmtDate(fromISO(absence.end_date))}`;
    const tip = `${person.name}: ${label} (${range})${absence.notes ? ` — ${absence.notes}` : ''}`;
    return h(admin ? 'button' : 'div', {
      class: `absence absence-${absence.absence_type}`,
      title: tip,
      type: admin ? 'button' : false,
      onclick: admin ? () => editAbsence({ ctx, person, absence, onSaved: reload }) : false,
    }, label, absence.notes ? h('span', { class: 'absence-note' }, absence.notes) : null);
  };

  const chip = (a, person, absence, iso) => {
    const model = data.modelById.get(a.pump_model_id);
    const task = data.taskById.get(a.task_id);
    const type = data.typeById.get(a.build_type_id);
    const equip = data.equipmentById.get(a.equipment_id);
    const bg = ctx.isBg(a);
    const time = timeLabel(a, iso);
    const continuing = iso !== a.work_date;
    const warnings = ctx.warningsFor(a, person.name);
    // Absence: attended work is flagged on every absent day; a background
    // job only on the day it is started (someone has to set it up).
    if (absence && (!bg || !continuing)) {
      warnings.push(`${person.name} is marked ${ABSENCE_TYPES[absence.absence_type] || 'absent'} this day.`);
    }
    warnings.push(...ctx.clashWarnings(a, personById));
    const label = [model?.name, type?.name, task?.name, a.qty_target != null ? a.qty_target : null].filter((x) => x != null).join(' · ');
    return h('button', {
      type: 'button',
      class: `chip ${bg ? 'chip-bg' : ''} ${continuing ? 'chip-cont' : ''} ${warnings.length ? 'chip-warn' : ''}`,
      style: type ? `--type-color:${type.color}` : false,
      title: [label, bg ? 'Background / unattended' : null, time, equip ? `Equipment: ${equip.name}` : null, a.notes,
        ...warnings.map((w) => `⚠ ${w}`)].filter(Boolean).join('\n'),
      onclick: () => (admin
        ? editAssignment({ ctx, person, iso: a.work_date, assignment: a, isoDays, personById, onSaved: reload })
        : showAssignment(ctx, a, person, warnings)),
    },
      h('span', { class: 'chip-line' },
        warnings.length ? h('span', { class: 'chip-warn-icon', 'aria-label': 'Warning' }, '⚠') : null,
        model ? h('span', { class: 'chip-model' }, model.name) : null,
        type ? typeTag(type) : null,
        h('span', { class: 'chip-task' }, task?.name ?? '?'),
        a.qty_target != null && !continuing ? h('span', { class: 'chip-qty' }, `× ${a.qty_target}`) : null,
      ),
      time || equip || bg ? h('span', { class: 'chip-meta' },
        bg ? h('span', { class: 'chip-bg-icon', 'aria-label': 'Background job', title: 'Background / unattended' }, '⏱') : null,
        time ? h('span', { class: 'chip-time' }, time) : null,
        equip ? h('span', { class: 'equip-tag' }, equip.name) : null,
      ) : null,
      a.notes && !continuing ? h('span', { class: 'chip-notes' }, a.notes) : null,
    );
  };

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
      admin ? h('button', { class: 'btn btn-sm', onclick: () => copyLastWeek({ ctx, monday, isoDays, rows, onDone: reload }) }, 'Copy last week') : null,
    ),
  );

  // Only visible when printing (see @media print in styles.css).
  const printHeader = h('div', { class: 'print-only print-header' },
    h('div', {},
      h('div', { class: 'print-title' }, `Pump Room Plan — ${weekLabel}`),
      hours ? h('div', { class: 'print-sub' },
        `Hours ${hhmm(hours.work_start)}–${hhmm(hours.work_end)} · Break ${hhmm(hours.break_time)} · Lunch ${hhmm(hours.lunch_time)}`) : null,
    ),
    h('div', { class: 'print-sub print-right' },
      'Meditec Medical Ltd', h('br'),
      `Printed ${fmtDate(new Date())} by ${auth.profile?.full_name || auth.profile?.email || ''}`),
  );

  const legend = h('div', { class: 'legend' },
    h('span', { class: 'muted small' }, 'Build types:'),
    data.types.filter((t) => t.active).map(typeTag),
    h('span', { class: 'legend-sep', 'aria-hidden': 'true' }),
    h('span', { class: 'muted small' }, '⚠ = not trained / absent / clash'),
    h('span', { class: 'legend-sep', 'aria-hidden': 'true' }),
    h('span', { class: 'legend-bg' }, '⏱ background job'),
  );

  // ---- desktop grid
  const grid = rows.length
    ? h('div', { class: 'table-scroll planner-grid' },
        h('table', { class: 'planner' },
          h('thead', {}, h('tr', {},
            h('th', { class: 'sticky-col', scope: 'col' }, 'Person'),
            days.map((d, i) => h('th', { scope: 'col', class: isoDays[i] === todayISO ? 'is-today' : '' }, fmtDayShort(d))),
          )),
          h('tbody', {}, rows.map((p) => h('tr', { class: p.active ? '' : 'inactive' },
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
      role: 'tab',
      'aria-selected': String(i === mobileDay),
      class: `day-tab ${i === mobileDay ? 'active' : ''} ${isoDays[i] === todayISO ? 'is-today' : ''}`,
      onclick: () => { mobileDay = i; reload(); },
    }, h('span', {}, fmtWeekday(d)), h('span', { class: 'day-num' }, d.getDate())),
  ));
  const phone = h('div', { class: 'planner-phone' },
    dayTabs,
    h('h3', { class: 'phone-day-title' }, fmtDayLong(days[mobileDay])),
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
    legend,
    h('section', { class: 'card card-flush planner-desktop' }, grid),
    phone,
    summaryCard({ monday, data: ctx, notes: summaryDemand.notes, weekLabel }),
  );
}

export function typeTag(type) {
  return h('span', { class: 'type-tag', style: `--type-color:${type.color}` }, type.name);
}

// ------------------------------------------------------------------ view (viewer)
function showAssignment(ctx, a, person, warnings) {
  const model = ctx.modelById.get(a.pump_model_id);
  const task = ctx.taskById.get(a.task_id);
  const type = ctx.typeById.get(a.build_type_id);
  openModal({
    title: `${person.name} · ${fmtDayLong(fromISO(a.work_date))}`,
    body: h('div', { class: 'stack' },
      h('dl', { class: 'details' },
        h('dt', {}, 'Task'), h('dd', {}, task?.name ?? '—'),
        h('dt', {}, 'Pump model'), h('dd', {}, model?.name ?? '—'),
        h('dt', {}, 'Build type'), h('dd', {}, type ? typeTag(type) : '—'),
        h('dt', {}, 'Quantity'), h('dd', {}, a.qty_target ?? '—'),
        h('dt', {}, 'Time'), h('dd', {}, timeLabel(a, a.work_date) || 'All day'),
        h('dt', {}, 'Runs'), h('dd', {}, ctx.isBg(a) ? '⏱ In the background (unattended)' : 'Attended'),
        h('dt', {}, 'Equipment'), h('dd', {}, ctx.equipmentById.get(a.equipment_id)?.name ?? '—'),
        h('dt', {}, 'Notes'), h('dd', { class: 'pre' }, a.notes || '—'),
      ),
      warnings.map((w) => h('p', { class: 'warn-box' }, `⚠ ${w}`)),
    ),
    actions: [{ label: 'Close' }],
  });
}

// ------------------------------------------------------------------ assignment editor
function options(rows, selectedId, { blank, label = (r) => r.name } = {}) {
  const list = rows.filter((r) => r.active || r.id === selectedId);
  return [
    blank != null ? h('option', { value: '' }, blank) : null,
    ...list.map((r) => {
      const o = h('option', { value: r.id }, label(r) + (r.active ? '' : ' (inactive)'));
      if (r.id === selectedId) o.selected = true;
      return o;
    }),
  ];
}

function editAssignment({ ctx, person, iso, assignment, isoDays, personById, onSaved, copyFrom }) {
  const src = assignment || copyFrom || null;
  const isNew = !assignment;
  const activePeople = [...personById.values()].filter((p) => p.active || p.id === person.id);

  const personSel = h('select', {}, options(activePeople, person.id));
  const taskSel = h('select', {}, options(ctx.tasks, src?.task_id, { blank: src ? null : '— choose a task —' }));
  const modelSel = h('select', {}, options(ctx.models, src?.pump_model_id, { blank: '— none —' }));
  const typeSel = h('select', {}, options(ctx.types, src?.build_type_id ?? ctx.defaultType?.id, { blank: '— none —' }));
  const qty = h('input', { type: 'number', min: 0, step: 1, inputmode: 'numeric', value: src?.qty_target ?? '' });
  const notes = h('textarea', { rows: 2, maxlength: 500 }, src?.notes ?? '');
  const startTime = h('input', { type: 'time', step: 300, value: hm(src?.start_time) ?? '' });
  const endTime = h('input', { type: 'time', step: 300, value: hm(src?.end_time) ?? '' });
  // Duplicates keep the same length (end date moves with the new start day).
  const spanDays = src?.end_date ? Math.round((fromISO(src.end_date) - fromISO(src.work_date || iso)) / 86400000) : null;
  const endDate = h('input', { type: 'date', value: assignment?.end_date ?? '' });
  const bgSel = h('select', {});
  let bgInit = false;
  const setBgOptions = () => {
    const task = ctx.taskById.get(taskSel.value);
    // First time: the saved value; afterwards: whatever is selected now.
    const cur = bgInit ? bgSel.value : (src?.background == null ? '' : String(src.background));
    bgInit = true;
    mount(bgSel,
      h('option', { value: '' }, `Task default (${task?.is_background ? 'background' : 'attended'})`),
      h('option', { value: 'true' }, '⏱ Background / unattended'),
      h('option', { value: 'false' }, 'Attended'));
    bgSel.value = cur;
  };
  const equipSel = h('select', {}, options(ctx.equipment, src?.equipment_id, { blank: '— none —' }));
  const timeHint = h('p', { class: 'muted small time-hint' });
  const warnBox = h('div', { class: 'stack-sm', 'aria-live': 'polite' });
  const error = h('p', { class: 'form-error', role: 'alert' });

  // New work: choose one or more days of this week. Editing: a single date.
  const dayBoxes = isNew
    ? isoDays.map((d) => ({ iso: d, ...checkbox(fmtDayShort(fromISO(d)), !copyFrom && d === iso) }))
    : null;
  const dateInput = isNew ? null : h('input', { type: 'date', value: assignment.work_date, required: true });
  const selectedDates = () => (isNew ? dayBoxes.filter((b) => b.input.checked).map((b) => b.iso) : [dateInput.value]);

  const modelField = field('Pump model', modelSel);
  const typeField = field('Build type', typeSel);

  /** The job(s) as they would be saved, for warnings. */
  const proposed = () => selectedDates().filter(Boolean).map((d) => ({
    id: assignment?.id, person_id: personSel.value, task_id: taskSel.value, work_date: d,
    start_time: startTime.value || null, end_time: endTime.value || null,
    end_date: isNew ? (spanDays != null && !endDate.value ? toISO(addDays(fromISO(d), spanDays)) : endDate.value || null) : endDate.value || null,
    equipment_id: equipSel.value || null,
    background: bgSel.value === '' ? null : bgSel.value === 'true',
  }));

  const refresh = () => {
    setBgOptions();
    const first = proposed()[0];
    timeHint.textContent = first && (first.start_time || first.end_date)
      ? `Shows as: ${timeLabel(first, first.work_date)}${endDateOf(first) !== first.work_date ? ' (and on each following day it covers)' : ''}`
      : 'No times = all day.';
    const task = ctx.taskById.get(taskSel.value);
    const needsPump = task ? task.requires_pump : true;
    modelField.querySelector('label').textContent = needsPump ? 'Pump model' : 'Pump model (optional)';
    typeField.querySelector('label').textContent = needsPump ? 'Build type' : 'Build type (optional)';
    // Default the build type when switching to a pump task.
    if (needsPump && !typeSel.value && ctx.defaultType) typeSel.value = ctx.defaultType.id;

    const p = personById.get(personSel.value);
    const msgs = [];
    if (p) {
      msgs.push(...ctx.warningsFor({ person_id: p.id, task_id: taskSel.value, pump_model_id: modelSel.value }, p.name));
      for (const d of selectedDates()) {
        const ab = ctx.absenceOn(p.id, d);
        if (ab) msgs.push(`${p.name} is marked ${ABSENCE_TYPES[ab.absence_type] || 'absent'} on ${fmtDayLong(fromISO(d))}.`);
      }
      for (const job of proposed()) {
        if (!job.task_id) continue;
        for (const m of ctx.clashWarnings(job, personById)) if (!msgs.includes(m)) msgs.push(m);
      }
    }
    mount(warnBox, msgs.map((m) => h('p', { class: 'warn-box' }, `⚠ ${m}`)));
    return msgs;
  };
  for (const el of [personSel, taskSel, modelSel, dateInput, startTime, endTime, endDate, bgSel, equipSel, ...(dayBoxes || []).map((b) => b.input)]) {
    el?.addEventListener('change', refresh);
  }

  const save = async () => {
    error.textContent = '';
    const task = ctx.taskById.get(taskSel.value);
    if (!task) { error.textContent = 'Please choose a task.'; return false; }
    if (task.requires_pump && !modelSel.value) { error.textContent = `${task.name} needs a pump model.`; return false; }
    if (task.requires_pump && !typeSel.value) { error.textContent = 'Please choose a build type.'; return false; }
    const dates = selectedDates().filter(Boolean);
    if (!dates.length) { error.textContent = 'Please choose at least one day.'; return false; }
    if (qty.value !== '' && (!Number.isInteger(Number(qty.value)) || Number(qty.value) < 0)) {
      error.textContent = 'Quantity must be a whole number (0 or more).'; return false;
    }
    if (endTime.value && !startTime.value) { error.textContent = 'Add a start time (or clear the end time).'; return false; }
    if (endDate.value && endDate.value < dates[0]) { error.textContent = 'The end date is before the start date.'; return false; }
    if (endDate.value && dates.length > 1) { error.textContent = 'With an end date, tick only the start day.'; return false; }

    const warnings = refresh();
    // Equipment bookings outside the loaded week (e.g. long jobs).
    if (equipSel.value) {
      const jobs = proposed();
      const minStart = jobs.map((j) => j.work_date).sort()[0];
      const maxEnd = jobs.map(endDateOf).sort().at(-1);
      const { data: booked } = await supabase.from('assignments').select(JOB_COLUMNS)
        .eq('equipment_id', equipSel.value).lte('work_date', maxEnd)
        .or(`work_date.gte.${toISO(addDays(fromISO(minStart), -1))},end_date.gte.${minStart}`);
      const known = new Set(ctx.assignments.map((x) => x.id));
      for (const o of booked || []) {
        if (known.has(o.id) || o.id === assignment?.id) continue;
        if (jobs.some((j) => overlaps(j, o))) {
          warnings.push(`${ctx.equipmentById.get(equipSel.value)?.name} is also booked for ${personById.get(o.person_id)?.name || 'someone'} (${fmtDayShort(fromISO(o.work_date))}${o.start_time ? ' ' + hm(o.start_time) : ''}).`);
        }
      }
    }
    if (warnings.length) {
      const ok = await confirmDialog('Save anyway?', warnings.join(' '), 'Save anyway', 'primary');
      if (!ok) return false;
    }

    const values = {
      person_id: personSel.value,
      task_id: task.id,
      pump_model_id: modelSel.value || null,
      build_type_id: typeSel.value || null,
      qty_target: qty.value === '' ? null : Number(qty.value),
      notes: notes.value.trim() || null,
      start_time: startTime.value || null,
      end_time: endTime.value || null,
      background: bgSel.value === '' ? null : bgSel.value === 'true',
      equipment_id: equipSel.value || null,
    };
    const rowsToSave = proposed().map((j) => ({ ...values, work_date: j.work_date, end_date: j.end_date }));
    const { error: err } = isNew
      ? await supabase.from('assignments').insert(rowsToSave)
      : await supabase.from('assignments').update(rowsToSave[0]).eq('id', assignment.id);
    if (reportError(err, 'Saving')) return false;
    toast(isNew && dates.length > 1 ? `Added to ${dates.length} days.` : 'Saved.', 'success');
    onSaved();
    return true;
  };

  const actions = [];
  if (!isNew) {
    actions.push({
      label: 'Delete',
      variant: 'danger',
      onClick: async () => {
        if (!(await confirmDialog('Delete this job?', 'Remove it from the plan? (The change history keeps a record.)'))) return false;
        const { error: err } = await supabase.from('assignments').delete().eq('id', assignment.id);
        if (reportError(err, 'Deleting')) return false;
        toast('Deleted.', 'success');
        onSaved();
        return true;
      },
    });
    actions.push({
      label: 'Duplicate…',
      onClick: () => {
        // Re-open as a new job with the same details (pick other days/person).
        setTimeout(() => editAssignment({
          ctx, person: personById.get(personSel.value) || person, iso: dateInput.value,
          isoDays, personById, onSaved,
          copyFrom: {
            task_id: taskSel.value, pump_model_id: modelSel.value, build_type_id: typeSel.value,
            qty_target: qty.value === '' ? null : Number(qty.value), notes: notes.value,
            start_time: startTime.value || null, end_time: endTime.value || null,
            background: bgSel.value === '' ? null : bgSel.value === 'true',
            equipment_id: equipSel.value || null,
            work_date: dateInput.value, end_date: endDate.value || null,
          },
        }), 0);
        return true;
      },
    });
  }
  actions.push({ label: 'Cancel' }, { label: isNew ? 'Add' : 'Save', variant: 'primary', onClick: save });

  openModal({
    title: isNew ? (copyFrom ? 'Duplicate job' : 'Add work') : 'Edit job',
    body: h('div', { class: 'stack' },
      h('div', { class: 'form-grid form-grid-2' },
        field('Person', personSel),
        isNew ? null : field('Date', dateInput),
      ),
      isNew ? h('fieldset', { class: 'skills-fieldset' },
        h('legend', {}, copyFrom ? 'Copy to day(s) this week' : 'Day(s) this week'),
        h('div', { class: 'day-checks' }, dayBoxes.map((b) => b.el)),
      ) : null,
      field('Task / operation', taskSel),
      h('div', { class: 'form-grid form-grid-2' }, modelField, typeField),
      field('Quantity target', qty, 'Units to complete (optional).'),
      h('fieldset', { class: 'skills-fieldset' },
        h('legend', {}, 'Timing & equipment (optional)'),
        h('div', { class: 'form-grid form-grid-3' },
          field('Start time', startTime),
          field('End time', endTime, 'Earlier than start = next day'),
          field('Ends on', endDate, 'Only for jobs over several days'),
        ),
        timeHint,
        h('div', { class: 'form-grid form-grid-2' },
          field('Runs', bgSel),
          field('Equipment / test station', equipSel),
        ),
      ),
      field('Notes', notes),
      warnBox,
      error,
    ),
    actions,
  });
  refresh();
  (isNew && !copyFrom ? taskSel : qty).focus();
}

// ------------------------------------------------------------------ absences
function editAbsence({ ctx, person, iso, absence, onSaved }) {
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
      const values = {
        person_id: person.id, absence_type: typeSel.value,
        start_date: start.value, end_date: end.value, notes: notes.value.trim() || null,
      };
      // Warn if work is already planned in this period.
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
async function copyLastWeek({ ctx, monday, isoDays, rows, onDone }) {
  const prevFrom = toISO(addDays(monday, -7));
  const prevTo = toISO(addDays(monday, -3));
  const { data: prev, error } = await supabase.from('assignments')
    .select('person_id, work_date, pump_model_id, task_id, build_type_id, qty_target, notes, background, start_time, end_time, end_date, equipment_id')
    .gte('work_date', prevFrom).lte('work_date', prevTo).order('created_at');
  if (reportError(error, 'Loading last week')) return;
  if (!prev.length) { toast('Last week has nothing planned to copy.'); return; }

  const activePerson = new Set(rows.filter((p) => p.active).map((p) => p.id));
  const isActive = (map, id) => !id || map.get(id)?.active;
  const copies = [];
  let skippedAbsent = 0;
  let skippedInactive = 0;
  for (const a of prev) {
    const date = toISO(addDays(fromISO(a.work_date), 7));
    if (!activePerson.has(a.person_id) || !isActive(ctx.modelById, a.pump_model_id)
        || !isActive(ctx.taskById, a.task_id) || !isActive(ctx.typeById, a.build_type_id)
        || !isActive(ctx.equipmentById, a.equipment_id)) { skippedInactive++; continue; }
    if (ctx.absenceOn(a.person_id, date)) { skippedAbsent++; continue; }
    copies.push({ ...a, work_date: date, end_date: a.end_date ? toISO(addDays(fromISO(a.end_date), 7)) : null });
  }

  const existing = ctx.assignments.filter((a) => a.work_date >= toISO(monday)).length;
  const parts = [`Copy ${copies.length} job${copies.length === 1 ? '' : 's'} from last week into this week (same people, days and quantities).`];
  if (existing) parts.push(`This week already has ${existing} job${existing === 1 ? '' : 's'}; the copies are added alongside them.`);
  if (skippedAbsent) parts.push(`${skippedAbsent} skipped because the person is absent.`);
  if (skippedInactive) parts.push(`${skippedInactive} skipped because a person, pump model, task, build type or equipment is inactive.`);
  if (!copies.length) { toast(parts.slice(1).join(' ') || 'Nothing to copy.'); return; }

  if (!(await confirmDialog('Copy last week?', parts.join(' '), 'Copy', 'primary'))) return;
  const { error: err } = await supabase.from('assignments').insert(copies);
  if (reportError(err, 'Copying')) return;
  toast(`Copied ${copies.length} job${copies.length === 1 ? '' : 's'}.`, 'success');
  onDone();
}
