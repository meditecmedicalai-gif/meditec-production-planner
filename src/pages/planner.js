import { h, mount, toast, reportError, openModal, confirmDialog, field, checkbox } from '../ui.js';
import { supabase } from '../supabase.js';
import { auth } from '../auth.js';
import { demandPanel } from './demand.js';
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
async function loadWeek(monday) {
  const from = toISO(monday);
  const to = toISO(addDays(monday, 4));
  const [people, models, tasks, types, skills, assignments, absences] = await Promise.all([
    supabase.from('people').select('id, name, job_title, active').order('name'),
    supabase.from('pump_models').select('id, name, short_code, active, sort_order').order('sort_order').order('name'),
    supabase.from('tasks').select('id, name, requires_pump, counts_as_output, active, sort_order').order('sort_order').order('name'),
    supabase.from('build_types').select('id, name, color, is_default, active, sort_order').order('sort_order').order('name'),
    supabase.from('person_skills').select('person_id, pump_model_id'),
    supabase.from('assignments')
      .select('id, person_id, work_date, pump_model_id, task_id, build_type_id, qty_target, notes, created_at, updated_at')
      .gte('work_date', from).lte('work_date', to).order('created_at'),
    supabase.from('absences')
      .select('id, person_id, start_date, end_date, absence_type, notes')
      .lte('start_date', to).gte('end_date', from),
  ]);
  const err = [people, models, tasks, types, skills, assignments, absences].find((r) => r.error)?.error;
  if (err) return { error: err };

  const byId = (rows) => new Map(rows.map((r) => [r.id, r]));
  return {
    people: people.data,
    models: models.data, modelById: byId(models.data),
    tasks: tasks.data, taskById: byId(tasks.data),
    types: types.data, typeById: byId(types.data),
    defaultType: types.data.find((t) => t.is_default) || null,
    skills: new Set(skills.data.map((s) => `${s.person_id}|${s.pump_model_id}`)),
    assignments: assignments.data,
    absences: absences.data,
  };
}

/** Helpers bound to a loaded week. */
function makeCtx(data) {
  return {
    ...data,
    absenceOn(personId, iso) {
      return data.absences.find((a) => a.person_id === personId && a.start_date <= iso && a.end_date >= iso) || null;
    },
    trained(personId, modelId) {
      return data.skills.has(`${personId}|${modelId}`);
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

  mount(main, h('p', { class: 'muted' }, 'Loading week…'));
  const [data, panel] = await Promise.all([loadWeek(monday), demandPanel(monday, () => renderPlanner(main))]);
  if (reportError(data.error, 'Loading the planner')) return;
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
    const jobs = data.assignments.filter((a) => a.person_id === person.id && a.work_date === iso);
    return h('div', { class: 'cell-inner' },
      absence ? absenceBanner(absence, person) : null,
      jobs.map((a) => chip(a, person, absence)),
      !admin && !absence && !jobs.length ? h('span', { class: 'muted small cell-empty' }, 'Nothing planned') : null,
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

  const chip = (a, person, absence) => {
    const model = data.modelById.get(a.pump_model_id);
    const task = data.taskById.get(a.task_id);
    const type = data.typeById.get(a.build_type_id);
    const warnings = ctx.warningsFor(a, person.name);
    if (absence) warnings.push(`${person.name} is marked ${ABSENCE_TYPES[absence.absence_type] || 'absent'} this day.`);
    const label = [model?.name, type?.name, task?.name, a.qty_target != null ? a.qty_target : null].filter((x) => x != null).join(' · ');
    return h('button', {
      type: 'button',
      class: `chip ${warnings.length ? 'chip-warn' : ''}`,
      style: type ? `--type-color:${type.color}` : false,
      title: [label, a.notes, ...warnings.map((w) => `⚠ ${w}`)].filter(Boolean).join('\n'),
      onclick: () => (admin
        ? editAssignment({ ctx, person, iso: a.work_date, assignment: a, isoDays, personById, onSaved: reload })
        : showAssignment(ctx, a, person, warnings)),
    },
      h('span', { class: 'chip-line' },
        warnings.length ? h('span', { class: 'chip-warn-icon', 'aria-label': 'Warning' }, '⚠') : null,
        model ? h('span', { class: 'chip-model' }, model.name) : null,
        type ? typeTag(type) : null,
        h('span', { class: 'chip-task' }, task?.name ?? '?'),
        a.qty_target != null ? h('span', { class: 'chip-qty' }, `× ${a.qty_target}`) : null,
      ),
      a.notes ? h('span', { class: 'chip-notes' }, a.notes) : null,
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
    admin ? h('div', { class: 'planner-actions' },
      h('button', { class: 'btn btn-sm', onclick: () => copyLastWeek({ ctx, monday, isoDays, rows, onDone: reload }) }, 'Copy last week'),
    ) : null,
  );

  const legend = h('div', { class: 'legend' },
    h('span', { class: 'muted small' }, 'Build types:'),
    data.types.filter((t) => t.active).map(typeTag),
    h('span', { class: 'legend-sep', 'aria-hidden': 'true' }),
    h('span', { class: 'muted small' }, '⚠ = not trained / absent'),
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
    h('div', { class: 'page-head' }, h('h1', { class: 'page-title' }, 'Planner')),
    toolbar,
    panel,
    legend,
    h('section', { class: 'card card-flush planner-desktop' }, grid),
    phone,
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

  const refresh = () => {
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
    }
    mount(warnBox, msgs.map((m) => h('p', { class: 'warn-box' }, `⚠ ${m}`)));
    return msgs;
  };
  for (const el of [personSel, taskSel, modelSel, dateInput, ...(dayBoxes || []).map((b) => b.input)]) {
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

    const warnings = refresh();
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
    };
    const { error: err } = isNew
      ? await supabase.from('assignments').insert(dates.map((d) => ({ ...values, work_date: d })))
      : await supabase.from('assignments').update({ ...values, work_date: dates[0] }).eq('id', assignment.id);
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
    .select('person_id, work_date, pump_model_id, task_id, build_type_id, qty_target, notes')
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
        || !isActive(ctx.taskById, a.task_id) || !isActive(ctx.typeById, a.build_type_id)) { skippedInactive++; continue; }
    if (ctx.absenceOn(a.person_id, date)) { skippedAbsent++; continue; }
    copies.push({ ...a, work_date: date });
  }

  const existing = ctx.assignments.length;
  const parts = [`Copy ${copies.length} job${copies.length === 1 ? '' : 's'} from last week into this week (same people, days and quantities).`];
  if (existing) parts.push(`This week already has ${existing} job${existing === 1 ? '' : 's'}; the copies are added alongside them.`);
  if (skippedAbsent) parts.push(`${skippedAbsent} skipped because the person is absent.`);
  if (skippedInactive) parts.push(`${skippedInactive} skipped because a person, pump model, task or build type is inactive.`);
  if (!copies.length) { toast(parts.slice(1).join(' ') || 'Nothing to copy.'); return; }

  if (!(await confirmDialog('Copy last week?', parts.join(' '), 'Copy', 'primary'))) return;
  const { error: err } = await supabase.from('assignments').insert(copies);
  if (reportError(err, 'Copying')) return;
  toast(`Copied ${copies.length} job${copies.length === 1 ? '' : 's'}.`, 'success');
  onDone();
}
