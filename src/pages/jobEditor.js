// Job form (add / edit / duplicate), recurring-job form and the
// "this one / this and future / all" choices for recurring jobs.
import { h, mount, toast, reportError, openModal, confirmDialog, field, checkbox } from '../ui.js';
import { supabase } from '../supabase.js';
import { endDateOf, timeLabel, overlaps, hm, pumpModelsOf, ABSENCE_TYPES } from '../jobs.js';
import { capacityForDay, isTestingJob, stationMismatch } from '../capacity.js';
import { PATTERNS, describe as describeRepeat, isoDow, JOB_FIELDS, pick } from '../recurring.js';
import { toISO, fromISO, addDays, today, fmtDayShort, fmtDayLong } from '../dates.js';
import { placeOn, fmtMin, toMin, workDay, nextFree, fmtDur } from '../daytime.js';
import { hoursText, makeHours } from '../hours.js';
import { addWork, breakMinutes, workBetween, planWork, dayInfoFrom, parseDuration } from '../timing.js';
import { planSeries, editJob, adjustPart, removePart, diffParts, partsOf, totalOf, sumWork } from '../series.js';
import { isSeriesRow, loadJobRows, dayInfoFor, saveParts, restoreJob, splitText, pickShared } from '../jobSeries.js';
import { belowZero } from '../demandModel.js';
import { coverableNotes } from '../demandModel.js';
import { noteText } from './demand.js';
import { miniDay } from './dayTimeline.js';

const ANY = '__any';
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const TEMPLATE_FIELDS = ['title', 'pattern', 'weekdays', 'interval_weeks', ...JOB_FIELDS];

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

const extend = () => supabase.rpc('extend_recurring_jobs');

// ------------------------------------------------------------------ shared field groups
/**
 * Pump model select. Tasks with "Allows mixed pumps" (Settings → Tasks, e.g. Repair, Rework) also offer
 * "Several pumps (mixed)": a quantity per pump model plus "Any / unknown" for pumps not identified yet.
 * The job's quantity is then the sum (the database keeps it so).
 */
function pumpFields(ctx, src, taskSel, { mix: allowMix = true } = {}) {
  const modelSel = h('select', {});
  const mixInputs = new Map();
  const qtyOf = (id) => (src?.pump_mix || []).find((x) => (x.pump_model_id || null) === id)?.qty ?? '';
  const totalLine = h('p', { class: 'mix-total muted small', 'aria-live': 'polite' });
  const listeners = [];
  const mixInput = (id, label) => {
    const inp = h('input', { type: 'number', min: 0, step: 1, inputmode: 'numeric', 'aria-label': `${label} quantity`, value: qtyOf(id) });
    inp.addEventListener('input', () => { sum(); listeners.forEach((f) => f()); });
    mixInputs.set(id, inp);
    return h('label', { class: `mix-item${id ? '' : ' mix-unknown'}` }, h('span', {}, label), inp);
  };
  const mixBox = h('fieldset', { class: 'skills-fieldset mix-box', hidden: true },
    h('legend', {}, 'Pumps on this job — quantity per model'),
    h('div', { class: 'mix-grid' },
      ctx.models.filter((m) => m.active || qtyOf(m.id) !== '').map((m) => mixInput(m.id, m.short_code || m.name)),
      mixInput(null, 'Any / unknown')),
    totalLine);
  const entries = () => [...mixInputs].map(([id, inp]) => ({ pump_model_id: id, qty: Number(inp.value) || 0 })).filter((x) => x.qty > 0);
  const sum = () => {
    const list = entries();
    const t = list.reduce((a, x) => a + x.qty, 0);
    totalLine.textContent = t ? `Total ${t} pump${t === 1 ? '' : 's'} — the job’s quantity` : 'Enter how many of each (leave “Any / unknown” for pumps not identified yet).';
    return t;
  };
  let init = false;
  const rebuild = () => {
    const task = ctx.taskById.get(taskSel.value);
    const cur = init ? modelSel.value : (src?.any_pump ? ANY : src?.pump_model_id || '');
    init = true;
    const allowAny = task?.allows_any_pump || cur === ANY;
    mount(modelSel, options(ctx.models, null, { blank: '— none —' }),
      allowAny ? h('option', { value: ANY }, allowMix ? 'Several pumps (mixed)' : 'Any / unknown pump') : null);
    modelSel.value = [...modelSel.options].some((o) => o.value === cur) ? cur : '';
    mixBox.hidden = !allowMix || modelSel.value !== ANY;
    sum();
  };
  modelSel.addEventListener('change', () => { mixBox.hidden = !allowMix || modelSel.value !== ANY; listeners.forEach((f) => f()); });
  const values = () => {
    const any = modelSel.value === ANY;
    const mix = any && allowMix ? entries() : [];
    return { pump_model_id: any ? null : modelSel.value || null, any_pump: any, pump_mix: mix.length ? mix : null };
  };
  /** Mixed with quantities: the total, else null. */
  const mixTotal = () => (allowMix && modelSel.value === ANY && entries().length ? sum() : null);
  return { modelSel, mixBox, rebuild, values, mixTotal, onMix: (f) => listeners.push(f) };
}

/** Repeat pattern fields. */
function repeatFields(initial = {}) {
  const patternSel = h('select', {},
    h('option', { value: '' }, 'Does not repeat'),
    Object.entries(PATTERNS).map(([k, v]) => h('option', { value: k }, v)));
  patternSel.value = initial.pattern || '';
  const dayBoxes = WEEKDAYS.map((d, i) => ({ dow: i + 1, ...checkbox(d, (initial.weekdays || []).includes(i + 1)) }));
  let touched = false; // once the user picks repeat days themselves, stop following the ticked days
  dayBoxes.forEach((b) => b.input.addEventListener('change', () => { touched = true; }));
  const interval = h('input', { type: 'number', min: 2, max: 12, step: 1, value: initial.interval_weeks > 1 ? initial.interval_weeks : 2 });
  const endDate = h('input', { type: 'date', value: initial.end_date || '' });
  const daysRow = h('div', { class: 'day-checks' }, dayBoxes.map((b) => b.el));
  const daysField = h('div', { class: 'field' }, h('label', {}, 'On'), daysRow);
  const intervalField = field('Every … weeks', interval);
  const endField = field('Repeat until', endDate, 'Leave empty for no end (12 weeks are planned ahead and topped up automatically).');
  const sync = () => {
    const p = patternSel.value;
    daysField.hidden = !(p === 'weekly' || p === 'every_n_weeks');
    intervalField.hidden = p !== 'every_n_weeks';
    endField.hidden = !p;
  };
  patternSel.addEventListener('change', sync);
  sync();
  return {
    patternSel, dayBoxes, endDate,
    el: h('div', { class: 'stack-sm' }, field('Repeat', patternSel), daysField, intervalField, endField),
    values: () => ({
      pattern: patternSel.value || null,
      weekdays: patternSel.value === 'workdays' ? [1, 2, 3, 4, 5] : patternSel.value === 'daily' ? [1, 2, 3, 4, 5, 6, 7] : dayBoxes.filter((b) => b.input.checked).map((b) => b.dow),
      interval_weeks: patternSel.value === 'every_n_weeks' ? Math.max(2, Number(interval.value) || 2) : 1,
      end_date: endDate.value || null,
    }),
    setDefaultDays: (dows) => { if (!touched) dayBoxes.forEach((b) => { b.input.checked = dows.includes(b.dow); }); },
  };
}

/** Ask how far a change to a recurring job should reach. Resolves 'one' | 'future' | 'all' | null. */
export function askScope(verb) {
  return new Promise((resolve) => {
    let done = false;
    const pickScope = (s) => () => { done = true; resolve(s); };
    const { dialog } = openModal({
      title: `${verb} recurring job`,
      body: h('p', {}, `This job repeats. Which jobs should this ${verb.toLowerCase()} apply to?`),
      actions: [
        { label: 'Cancel', onClick: pickScope(null) },
        { label: 'This one only', onClick: pickScope('one') },
        { label: 'This and future', onClick: pickScope('future') },
        { label: 'All', variant: 'primary', onClick: pickScope('all') },
      ],
    });
    dialog.addEventListener('close', () => { if (!done) resolve(null); });
  });
}

async function loadTemplate(ctx, id) {
  if (ctx.recurringById?.get(id)) return ctx.recurringById.get(id);
  const { data } = await supabase.from('recurring_jobs').select('*').eq('id', id).maybeSingle();
  return data;
}

// ------------------------------------------------------------------ job form
/**
 * Add / edit a job. A job over several days is ONE job: opening any of its parts opens
 * the whole job (part 1's start, the total work time, all parts listed).
 */
export function editAssignment(args) {
  const { ctx, assignment } = args;
  if (assignment && !args.series && !assignment.recurring_id && isSeriesRow(ctx, assignment)) {
    loadJobRows(assignment).then(({ rows, error }) => {
      if (reportError(error, 'Opening the job') || !rows?.length) return;
      editAssignment({ ...args, series: rows, openedId: assignment.id, assignment: rows.find((r) => !r.part_of) || rows[0] });
    });
    return;
  }
  editAssignmentForm(args);
}

/** Open the whole job (from a notice's "Edit"): loads it fresh first. */
export async function openWholeJob(args, headId) {
  const { rows, error } = await loadJobRows({ id: headId });
  if (reportError(error, 'Opening the job') || !rows?.length) return;
  const head = rows.find((r) => !r.part_of) || rows[0];
  editAssignment({ ...args, assignment: head, iso: head.work_date, person: args.personById.get(head.person_id), series: rows.length > 1 ? rows : null });
}

/** "This part only / Whole job / Cancel" — resolves 'part' | 'job' | null. */
function askPartOrJob(n, total) {
  return new Promise((resolve) => {
    let done = false;
    const pick = (v) => () => { done = true; resolve(v); };
    const { dialog } = openModal({
      title: 'Delete job over several days',
      body: h('p', {}, `This is part ${n} of ${total} of one job. Delete only this part (the other parts stay where they are), or the whole job?`),
      actions: [
        { label: 'Cancel', onClick: pick(null) },
        { label: 'This part only', onClick: pick('part') },
        { label: 'Whole job', variant: 'danger', onClick: pick('job') },
      ],
    });
    dialog.addEventListener('close', () => { if (!done) resolve(null); });
  });
}

function editAssignmentForm({ ctx, person, iso, assignment, isoDays, personById, onSaved, copyFrom, times, prefill, series = null, openedId = null }) {
  const src = assignment || copyFrom || (times || prefill ? { ...(prefill || {}), ...(times ? { start_time: times.start, end_time: times.end } : {}) } : null);
  const isNew = !assignment;
  const formArgs = { ctx, isoDays, personById, onSaved };
  // the person's working days for the live preview: from what's loaded at once, then their
  // absences and one-off hours for the next weeks (fetched in the background; saving reloads them)
  const fullDays = new Map();
  const quickDays = (pid) => {
    if (fullDays.has(pid)) return fullDays.get(pid) || dayInfoFrom((p, d) => ctx.hoursFor(p, d), (p, d) => Boolean(ctx.absenceOn(p, d)), pid);
    fullDays.set(pid, null);
    dayInfoFor(ctx, pid, isoDays?.[0] || iso || toISO(today())).then((di) => { fullDays.set(pid, di); if (formModal) refresh(); }).catch(() => {});
    return dayInfoFrom((p, d) => ctx.hoursFor(p, d), (p, d) => Boolean(ctx.absenceOn(p, d)), pid);
  };
  const seriesParts = series && series.length > 1 ? partsOf(series) : null;
  const seriesTotal = seriesParts ? totalOf(series, quickDays(assignment.person_id), assignment.pause_for_breaks !== false) : null;
  const overflowMode = ctx.overflowMode || 'continue';
  const activePeople = [...personById.values()].filter((p) => p.active || p.id === person?.id);

  const personSel = h('select', {}, options(activePeople, person?.id),
    isNew ? h('option', { value: '' }, '— Not assigned yet (recurring only) —') : null);
  const taskSel = h('select', {}, options(ctx.tasks, src?.task_id, { blank: src?.task_id ? null : '— choose a task —' }));
  const pumps = pumpFields(ctx, src, taskSel);
  const typeSel = h('select', {}, options(ctx.types, src?.build_type_id ?? ctx.defaultType?.id, { blank: '— none —' }));
  const qty = h('input', { type: 'number', min: 0, step: 1, inputmode: 'numeric', value: src?.qty_target ?? '' });
  const notes = h('textarea', { rows: 2, maxlength: 500 }, src?.notes ?? '');
  const startTime = h('input', { type: 'time', step: 300, value: hm(src?.start_time) ?? '' });
  const endTime = h('input', { type: 'time', step: 300, value: hm(src?.end_time) ?? '' });
  const spanDays = src?.end_date ? Math.round((fromISO(src.end_date) - fromISO(src.work_date || iso)) / 86400000) : null;
  // "Ends on" is only for jobs over several days: hidden behind its own switch so it
  // can't be filled by accident (a stray key in a date box sets today's date).
  const endDate = h('input', { type: 'date', value: src?.end_date && src.end_date > (src.work_date || iso) && assignment ? src.end_date : '' });
  const multiDay = checkbox('Runs over several days', Boolean(src?.end_date && src.end_date > (src.work_date || iso)));
  const clearEnd = h('button', { type: 'button', class: 'btn btn-xs btn-ghost', title: 'Make it a one-day job again',
    onclick: () => { endDate.value = ''; multiDay.input.checked = false; changed(); } }, 'Clear');
  const endDateBox = h('div', { class: 'multi-day-box' }, field('Ends on', endDate, 'The last day of the job'), clearEnd);
  const workDur = h('input', { type: 'text', placeholder: 'e.g. 1h 30m', 'aria-label': 'Work time', autocomplete: 'off' });
  const pauseBox = checkbox('Pause for breaks', src?.pause_for_breaks !== false);
  const summaryBox = h('div', { class: 'timing-summary', 'aria-live': 'polite' });
  const partsBox = h('div', { class: 'parts-box', hidden: true, 'aria-live': 'polite' });
  let formModal = null;
  let durMode = 'end';
  const overtimeDefault = overflowMode === 'overtime';
  let overtimeOK = overtimeDefault;  // "Keep as is (overtime)" (Settings: "Allow overtime" makes it the default)
  let splitPlan = null;        // "Continue next working day": [{ date, start, end, work, paused }]
  let startTouched = Boolean(src?.start_time);
  const modeEnd = h('button', { type: 'button', class: 'seg-btn active', 'aria-pressed': 'true', onclick: () => setMode('end') }, 'End time');
  const modeWork = h('button', { type: 'button', class: 'seg-btn', 'aria-pressed': 'false', onclick: () => setMode('work') }, 'Work time');
  const endField = field('End time', endTime, 'Earlier than start = next day');
  const workField = field('Work time', workDur, 'Breaks are added automatically');
  workField.hidden = true;
  const bgSel = h('select', {});
  let bgInit = false;
  const setBgOptions = () => {
    const task = ctx.taskById.get(taskSel.value);
    const cur = bgInit ? bgSel.value : (src?.background == null ? '' : String(src.background));
    bgInit = true;
    mount(bgSel,
      h('option', { value: '' }, `Task default (${task?.is_background ? 'background' : 'attended'})`),
      h('option', { value: 'true' }, '⏱ Background / unattended'),
      h('option', { value: 'false' }, 'Attended'));
    bgSel.value = cur;
  };
  const equipSel = h('select', {}, options(ctx.equipment, src?.equipment_id, { blank: '— none —' }));
  // "Covers demand": open notes for this pump model (or Any / mixed); a note can be covered by several jobs
  const demandSel = ctx.demand && !ctx.demand.error ? h('select', {}) : null;
  const demandField = demandSel ? field('Covers demand', demandSel, 'Optional. Its quantity counts towards the note’s “planned”.') : null;
  let demandInit = false;
  const rebuildDemand = () => {
    if (!demandSel) return;
    const cur = demandInit ? demandSel.value : (src?.demand_id || '');
    demandInit = true;
    const pv = pumps.values();
    const list = coverableNotes(ctx.demand.items, { pumpModelId: pv.pump_model_id, anyPump: pv.any_pump, models: pumpModelsOf(pv) });
    const current = cur && !list.some((x) => x.note.id === cur) ? ctx.demand.items.find((x) => x.note.id === cur) : null;
    const label = (x) => {
      const n = x.note; const s = x.state;
      return [noteText(n, ctx.demand), n.needed_by ? `by ${fmtDayShort(fromISO(n.needed_by))}` : 'no date',
        `${s.planned}${s.needed != null ? `/${s.needed}` : ''} planned`, ctx.demand.nameOf(n.created_by)].join(' · ');
    };
    mount(demandSel, h('option', { value: '' }, list.length || current ? '— none —' : '— no open demand for this pump —'),
      [...(current ? [current] : []), ...list].map((x) => h('option', { value: x.note.id }, label(x))));
    demandSel.value = [...demandSel.options].some((o) => o.value === cur) ? cur : '';
    demandField.hidden = !list.length && !current;
  };
  const timeHint = h('p', { class: 'muted small time-hint' });
  const miniBox = h('div', { class: 'mini-box', 'aria-live': 'polite' });
  const warnBox = h('div', { class: 'stack-sm', 'aria-live': 'polite' });
  const error = h('p', { class: 'form-error', role: 'alert' });

  const dayBoxes = isNew ? isoDays.map((d) => ({ iso: d, ...checkbox(fmtDayShort(fromISO(d)), !copyFrom && d === iso) })) : null;
  const dateInput = isNew ? null : h('input', { type: 'date', value: assignment.work_date, required: true });
  const selectedDates = () => (isNew ? dayBoxes.filter((b) => b.input.checked).map((b) => b.iso) : [dateInput.value]);
  const repeat = isNew ? repeatFields({}) : null;

  const modelField = field('Pump model', pumps.modelSel);
  const typeField = field('Build type', typeSel);
  // Office / non-production jobs: no pump, type, quantity or station; notes up top
  const isOffice = () => ctx.taskById.get(taskSel.value)?.category === 'office';
  const qtyField = field('Quantity target', qty, 'Units to complete — for testing tasks, the number of pumps on test.');
  const doneInp = h('input', { type: 'number', min: 0, step: 1, inputmode: 'numeric', value: assignment?.qty_done ?? '', 'aria-label': 'Units done' });
  const showDone = !isNew && 'qty_done' in (assignment || {});
  const doneClear = h('button', { type: 'button', class: 'btn btn-xs btn-ghost', title: 'Clear units done', onclick: () => { doneInp.value = ''; doneInp.focus(); } }, 'Clear');
  const doneField = showDone ? field('Units done', doneInp, 'So far, e.g. 4 of 5 — counts once per job, towards the demand note it covers. Lower it or clear it to correct.') : null;
  if (doneField) { const row = h('div', { class: 'inline-row' }); doneInp.replaceWith(row); row.append(doneInp, doneClear); }
  const qtyRow = h('div', { class: 'form-grid form-grid-2' }, qtyField, doneField);
  const syncMixQty = () => {
    const t = pumps.mixTotal();
    qty.readOnly = t != null;
    if (t != null) qty.value = String(t);
    qtyField.querySelector('.hint').textContent = t != null ? 'The total of the pumps listed above.' : 'Units to complete — for testing tasks, the number of pumps on test.';
  };
  pumps.onMix(() => { syncMixQty(); refresh(); });
  const equipField = field('Equipment / test station', equipSel);
  const notesField = field('Notes', notes);
  const notesTop = h('div', { class: 'notes-top' });
  const notesBottom = h('div', {});
  const todoItems = ctx.todos?.ready ? ctx.todos.items : [];
  const todoSel = todoItems.length || src?.todo_id ? h('select', {}, h('option', { value: '' }, '— none —'),
    todoItems.filter((x) => x.todo.status !== 'done' || x.todo.id === src?.todo_id).map((x) => h('option', { value: x.todo.id, selected: x.todo.id === src?.todo_id },
      [x.todo.title, x.todo.due_date ? `due ${fmtDayShort(fromISO(x.todo.due_date))}` : null, ctx.todos.nameOf(x.todo.owner_id)].filter(Boolean).join(' · ')))) : null;
  const todoField = todoSel ? field('For to-do', todoSel, 'Optional. The time block shows on the to-do’s card.') : null;
  const applyOffice = () => {
    const office = isOffice();
    for (const el of [modelField, typeField, qtyRow, equipField, demandField]) if (el) el.hidden = office;
    if (office) pumps.mixBox.hidden = true;
    if (todoField) todoField.hidden = !office;
    notesField.querySelector('label').textContent = office ? 'What are you working on?' : 'Notes';
    notes.rows = office ? 3 : 2;
    notes.placeholder = office ? 'e.g. Update the QPro build instructions' : '';
    (office ? notesTop : notesBottom).append(notesField);
  };

  const isBgNow = () => (bgSel.value === '' ? Boolean(ctx.taskById.get(taskSel.value)?.is_background) : bgSel.value === 'true');
  const personHours = (d) => (personSel.value && ctx.hoursFor ? ctx.hoursFor(personSel.value, d) : null);

  /** Effective times on day d: end from the end time or the work time (+ breaks), else the end of the person's day. */
  const timesFor = (d) => {
    if (!d) return { s: null, e: null, paused: 0, work: null, multi: multiDay.input.checked };
    const s0 = startTime.value ? toMin(startTime.value) : null;
    const hrs = personHours(d);
    const day = hrs?.works ? workDay(hrs) : null;
    const bg = isBgNow();
    const pause = pauseBox.input.checked && !bg;
    const brk = pause && day ? day.breaks : [];
    const out = { s: s0, e: null, paused: 0, work: null, auto: false, hrs, day, bg, pause, multi: multiDay.input.checked };
    if (s0 == null || out.multi) { if (out.multi && endTime.value) out.e = toMin(endTime.value); return out; }
    if (durMode === 'work') {
      const w = parseDuration(workDur.value);
      if (w != null) { const r2 = addWork(s0, w, brk); Object.assign(out, { e: r2.end, paused: r2.paused, work: w }); }
    } else if (endTime.value) {
      let e = toMin(endTime.value); if (e <= s0) e += 24 * 60;
      Object.assign(out, { e, paused: breakMinutes(s0, e, brk), work: e - s0 - breakMinutes(s0, e, brk) });
    }
    if (out.e == null && !bg && day && s0 < day.we) {
      // start only: until their next job (the end of this free slot), else the end of their day
      const others = ctx.jobsOn ? ctx.jobsOn(personSel.value, d).attended.filter((o) => o.id !== assignment?.id && o.start_time) : [];
      const nextStart = Math.min(day.we, ...others.map((o) => (ctx.place ? ctx.place(o, d) : placeOn(o, d))).filter((pl) => pl && pl.s > s0).map((pl) => pl.s));
      Object.assign(out, { e: nextStart, auto: nextStart < day.we ? 'slot' : 'day', paused: breakMinutes(s0, nextStart, brk), work: workBetween(s0, nextStart, brk, pause) });
    }
    return out;
  };
  const endText = (e) => (e == null ? null : fmtMin(e >= 24 * 60 ? e - 24 * 60 : e));

  /** The job(s) as they would be saved, for warnings. */
  const proposed = () => selectedDates().filter(Boolean).map((d, i) => {
    const t = timesFor(d);
    const plan = !splitPlan && i === 0 ? planFor(d) : null;
    const part = splitPlan && i === 0 ? splitPlan[0] : plan?.split ? plan.parts[0] : null;
    return {
      id: assignment?.id || `proposed-${i}`, person_id: personSel.value, task_id: taskSel.value, work_date: d,
      ...pumps.values(), qty_target: qty.value === '' ? null : Number(qty.value),
      start_time: startTime.value || null,
      end_time: part ? fmtMin(part.end) : t.multi ? endTime.value || null : t.e != null && (durMode === 'work' || t.auto) ? endText(t.e) : endTime.value || null,
      end_date: multiDay.input.checked
        ? (endDate.value || (isNew && spanDays ? toISO(addDays(fromISO(d), spanDays)) : null))
        : null,
      equipment_id: equipSel.value || null, background: bgSel.value === '' ? null : bgSel.value === 'true',
      pause_for_breaks: pauseBox.input.checked,
    };
  });
  /** Parts 2, 3 … of a job continued on the next working day(s). */
  const extraParts = () => (splitPlan ? splitPlan.slice(1) : []);

  function setMode(mode) {
    if (mode === durMode) return;
    const t = timesFor(selectedDates()[0]);
    if (mode === 'work' && t.work != null) workDur.value = fmtDur(t.work).replace(/ /g, ' ');
    if (mode === 'end' && t.e != null) endTime.value = endText(t.e);
    durMode = mode;
    endField.hidden = mode !== 'end'; workField.hidden = mode !== 'work';
    modeEnd.classList.toggle('active', mode === 'end'); modeWork.classList.toggle('active', mode === 'work');
    modeEnd.setAttribute('aria-pressed', String(mode === 'end')); modeWork.setAttribute('aria-pressed', String(mode === 'work'));
    changed();
  }
  /** Any change to the timing invalidates an earlier choice (split / overtime). */
  function changed() { splitPlan = null; overtimeOK = overtimeDefault; refresh(); }

  /** How the job will be laid out on day d: one part, or parts over working days. */
  const planFor = (d) => {
    const t = timesFor(d);
    if (!d || t.s == null || t.e == null || t.bg || t.multi || !personSel.value) return null;
    const total = t.work ?? workBetween(t.s, t.e, t.day?.breaks || [], t.pause);
    const late = Boolean(t.day && t.e > t.day.we) || !t.day;
    const split = !overtimeOK && (Boolean(splitPlan) || (late && overflowMode === 'continue') || Boolean(seriesParts));
    if (!split) return { total, parts: [{ date: d, start: t.s, end: t.e }], split: false, late };
    const parts = splitPlan || editJob({ current: seriesParts || [], date: d, start: t.s, total, pause: t.pause, dayInfo: quickDays(personSel.value) });
    return { total, parts, split: parts.length > 1, late };
  };

  /** "Continue next working day": spread the rest of the work over their next working days. */
  async function continueNextDay() {
    const d = selectedDates()[0]; const pid = personSel.value; const t = timesFor(d);
    if (!pid || t.s == null || t.e == null) return;
    const total = t.work ?? workBetween(t.s, t.e, t.day?.breaks || [], t.pause);
    const until = toISO(addDays(fromISO(d), 30));
    const [ab, dh] = await Promise.all([
      supabase.from('absences').select('person_id, start_date, end_date').eq('person_id', pid).lte('start_date', until).gte('end_date', d),
      supabase.from('person_day_hours').select('*').eq('person_id', pid).gte('work_date', d).lte('work_date', until).then((x) => (x.error ? { data: [] } : x)),
    ]);
    const absences = [...(ab.data || []), ...ctx.absences.filter((a) => a.person_id === pid)];
    const hrs = makeHours({ patterns: ctx.patterns || [], patternDays: ctx.patternDays || [], personPatterns: ctx.personPatterns || [],
      dayHours: [...(ctx.dayHours || []).filter((x) => x.person_id !== pid || x.work_date < d), ...(dh.data || [])], settings: ctx.hours });
    const absentOn = (p, iso) => absences.some((a) => a.start_date <= iso && a.end_date >= iso);
    const parts = planWork({ iso: d, start: t.s, work: total, pause: t.pause, dayInfo: dayInfoFrom(hrs.forDay, absentOn, pid) });
    if (parts.length < 2) return;
    splitPlan = parts; overtimeOK = false;
    durMode = 'end'; endField.hidden = false; workField.hidden = true; modeEnd.classList.add('active'); modeWork.classList.remove('active');
    endTime.value = fmtMin(parts[0].end);
    refresh();
  }

  /** One-line summary + choices when the job doesn't fit the person's hours. */
  function renderSummary(first, p) {
    if (!first || !p) { mount(summaryBox); return; }
    const d = first.work_date; const t = timesFor(d);
    const who = p.name.split(' ')[0];
    const dayName = fmtDayShort(fromISO(d)).split(' ')[0];
    if (t.s == null) {
      mount(summaryBox, h('p', { class: 'ts-line muted' }, `${who} · ${dayName} · no times — counts as all day (add a start time to place it)`));
      return;
    }
    if (t.multi) {
      const last = first.end_date;
      mount(summaryBox, h('p', { class: 'ts-line ts-multi' }, `⇢ Multi-day: ${who} · ${dayName} ${fmtMin(t.s)} → ${last ? fmtDayShort(fromISO(last)) : '…'}${endTime.value ? ` ${endTime.value}` : ''}`,
        t.bg ? ' · runs continuously in the background' : ' · counts only their working hours each day (not overnight)'));
      return;
    }
    if (t.bg) {
      mount(summaryBox, h('p', { class: 'ts-line' }, `⏱ Background · ${dayName} ${fmtMin(t.s)}${t.e != null ? `–${endText(t.e)}${t.e >= 24 * 60 ? ' next day' : ''}` : ' onwards'} · runs through breaks and doesn’t keep ${who} busy`));
      return;
    }
    const hrs = t.hrs; const day = t.day;
    const span = `${fmtMin(t.s)}–${t.e != null ? endText(t.e) : '…'}`;
    const brk = t.paused ? ` (incl. ${t.paused} min break)` : '';
    const lines = [];
    const actions = [];
    if (!hrs?.works) {
      lines.push(h('p', { class: 'ts-line ts-warn' }, `⚠ ${who} · ${dayName} ${span}${brk} · not a working day for ${who}`));
    } else {
      const early = t.s < day.ws;
      const late = t.e != null && t.e > day.we;
      const plan = planFor(d);
      if (plan?.split && !splitPlan) {
        lines.push(h('p', { class: 'ts-line ts-ok' }, `${who} · ${seriesParts ? 'one job over' : late ? 'runs past finish — continues over' : 'over'} ${plan.parts.length} working days ✓`),
          h('ul', { class: 'ts-parts' }, plan.parts.map((x) => h('li', {}, `${fmtDayShort(fromISO(x.date))} ${fmtMin(x.start)}–${fmtMin(x.end)}${x.locked ? ' 🔒' : ''}`))));
        actions.push(h('button', { type: 'button', class: 'btn btn-xs', onclick: () => { overtimeOK = true; refresh(); } }, 'Keep on one day (overtime)'));
      } else if (seriesParts && plan && !plan.split) {
        lines.push(h('p', { class: 'ts-line ts-ok' }, `${who} · ${dayName} ${span}${brk} · ${late ? 'kept on one day (overtime)' : 'fits in one day'} — the other part${seriesParts.length > 2 ? 's' : ''} will be removed`));
        if (overtimeOK && late) actions.push(h('button', { type: 'button', class: 'btn btn-xs btn-ghost', onclick: () => { overtimeOK = false; refresh(); } }, 'Continue next working day instead'));
      } else if (splitPlan) {
        lines.push(h('p', { class: 'ts-line ts-ok' }, `${who} · continued over ${splitPlan.length} working days ✓`),
          h('ul', { class: 'ts-parts' }, splitPlan.map((x) => h('li', {}, `${fmtDayShort(fromISO(x.date))} ${fmtMin(x.start)}–${fmtMin(x.end)}${x.paused ? ` (incl. ${x.paused} min break)` : ''}`))));
        actions.push(h('button', { type: 'button', class: 'btn btn-xs', onclick: () => { splitPlan = null; endTime.value = t.e != null ? endText(timesFor(d).e) : endTime.value; refresh(); } }, 'Undo'));
      } else if (late && !overtimeOK) {
        lines.push(h('p', { class: 'ts-line ts-warn' }, `⚠ ${who} · ${dayName} ${span}${brk} · runs ${fmtDur(t.e - day.we)} past ${who}’s finish (${fmtMin(day.we)})`));
        actions.push(
          h('button', { type: 'button', class: 'btn btn-xs btn-primary', onclick: continueNextDay }, 'Continue next working day'),
          h('button', { type: 'button', class: 'btn btn-xs', onclick: () => { overtimeOK = true; refresh(); } }, 'Keep as is (overtime)'),
          h('button', { type: 'button', class: 'btn btn-xs', onclick: () => { setMode('end'); endTime.value = fmtMin(day.we); changed(); } }, 'Shorten to end of day'));
      } else if (late && overtimeOK && !seriesParts) {
        lines.push(h('p', { class: 'ts-line ts-ot' }, `${who} · ${dayName} ${span}${brk} · overtime ${fmtDur(t.e - day.we)}${overtimeDefault ? ' (Settings: allow overtime)' : ' (agreed)'}`));
        actions.push(h('button', { type: 'button', class: 'btn btn-xs btn-ghost', onclick: () => { overtimeOK = false; if (overflowMode !== 'continue') continueNextDay(); else refresh(); } }, overtimeDefault ? 'Continue next working day' : 'Undo'));
      }
      if (early) {
        lines.push(h('p', { class: 'ts-line ts-warn' }, `⚠ Starts before ${who}’s start (${fmtMin(day.ws)})`));
        actions.push(h('button', { type: 'button', class: 'btn btn-xs btn-primary', onclick: () => {
          const len = t.e != null ? t.e - t.s : null;
          startTime.value = fmtMin(day.ws); startTouched = true;
          if (durMode === 'end' && len != null && endTime.value) endTime.value = endText(toMin(startTime.value) + len);
          changed();
        } }, `Move to ${fmtMin(day.ws)}`));
      }
      if (!late && !early && !splitPlan && !seriesParts) {
        lines.push(h('p', { class: 'ts-line ts-ok' }, `${who} · ${dayName} ${span}${brk}${t.auto === 'slot' ? ' (until their next job)' : t.auto ? ` (to the end of ${who}’s day)` : ''} · within hours ✓`));
      }
      if (durMode === 'work' && t.e != null && !splitPlan && !planFor(d)?.split) lines.push(h('p', { class: 'ts-end' }, `Ends ${endText(t.e)}${t.paused ? ` (incl. ${t.paused} min break)` : ''}`));
    }
    mount(summaryBox, lines, actions.length ? h('div', { class: 'ts-actions' }, actions) : null);
  }

  /** "Total work time: 3h · Part 1 Tue 15:00–16:30 · Part 2 Wed 08:30–10:00", each with "Adjust this part only". */
  function renderParts() {
    if (!seriesParts) { partsBox.hidden = true; return; }
    partsBox.hidden = false;
    const day = (x) => fmtDayShort(fromISO(x.date));
    mount(partsBox,
      h('div', { class: 'parts-total' }, `One job over ${seriesParts.length} days · total work time ${fmtDur(seriesTotal)}`),
      h('ol', { class: 'parts-list', 'aria-label': 'Parts of this job' }, seriesParts.map((x, i) => h('li', { class: x.id === openedId ? 'is-open' : '' },
        `Part ${i + 1} · ${day(x)} ${fmtMin(x.start)}–${fmtMin(x.end)}`, x.locked ? h('span', { class: 'lock', title: 'Times set by hand — kept when the job re-flows' }, '🔒 set by hand') : null,
        x.id === openedId ? h('span', { class: 'muted small' }, '(opened)') : null,
        h('button', { type: 'button', class: 'btn btn-xs btn-ghost', onclick: () => adjustThisPart(i) }, 'Adjust this part only')))),
      h('p', { class: 'muted small' }, 'Changes here apply to the whole job: it re-flows from part 1 with the person’s hours (work time = the total). Moving the start date moves every part.'));
  }

  /** "Adjust this part only": new times for one part; the following parts re-flow (or are locked). */
  function adjustThisPart(index) {
    const x = seriesParts[index];
    const st = h('input', { type: 'time', step: 300, value: fmtMin(x.start), 'aria-label': 'Start' });
    const en = h('input', { type: 'time', step: 300, value: fmtMin(x.end), 'aria-label': 'End' });
    const reflow = h('input', { type: 'radio', name: 'follow', value: 'reflow', checked: true });
    const lock = h('input', { type: 'radio', name: 'follow', value: 'lock' });
    const err = h('p', { class: 'form-error', role: 'alert' });
    const later = seriesParts.length - index - 1;
    openModal({
      title: `Adjust part ${index + 1} of ${seriesParts.length} · ${fmtDayShort(fromISO(x.date))}`,
      body: h('div', { class: 'stack' },
        h('div', { class: 'form-grid form-grid-2' }, field('Start', st), field('End', en)),
        later ? h('fieldset', { class: 'skills-fieldset' }, h('legend', {}, `The following part${later > 1 ? 's' : ''}`),
          h('label', { class: 'check' }, reflow, h('span', {}, 'Re-flow to keep the total work time')),
          h('label', { class: 'check' }, lock, h('span', {}, 'Lock them where they are (the total changes)'))) : null,
        h('p', { class: 'muted small' }, 'This part keeps these times when the job re-flows later (🔒).'),
        err),
      actions: [{ label: 'Cancel' }, {
        label: 'Save this part', variant: 'primary',
        onClick: async () => {
          if (!st.value || !en.value || toMin(en.value) <= toMin(st.value)) { err.textContent = 'Enter a start and an end later than the start.'; return false; }
          const { rows: before, error: e0 } = await loadJobRows(assignment);
          if (reportError(e0, 'Saving')) return false;
          const head = before.find((r) => !r.part_of) || before[0];
          const pause = head.pause_for_breaks !== false;
          const dayInfo = await dayInfoFor(ctx, head.person_id, before[0].work_date);
          const cur = partsOf(before);
          const i = cur.findIndex((c) => c.date === x.date);
          if (i < 0) { err.textContent = 'This part has changed — close and open the job again.'; return false; }
          const res = adjustPart({ current: cur, index: i, start: toMin(st.value), end: toMin(en.value), mode: lock.checked ? 'lock' : 'reflow', total: totalOf(before, dayInfo, pause), pause, dayInfo });
          const { rows, remove } = diffParts(before, res.parts, { ...pickShared(head), qty_done: head.qty_done ?? null }, { total: res.total });
          const out = await saveParts({ rows, remove });
          if (reportError(out.error, 'Saving')) return false;
          formModal?.close();
          toast(`Part ${index + 1} adjusted${res.parts.length !== cur.length ? ` — the job now has ${res.parts.length} part${res.parts.length === 1 ? '' : 's'}` : ''}.`, 'success',
            [{ label: 'Undo', onClick: async () => { if (await restoreJob(before, out.headId)) onSaved(); } }]);
          onSaved();
          return true;
        },
      }],
    });
  }

  const capacityWarnings = () => {
    const jobs = proposed();
    if (!jobs.length || !isTestingJob(jobs[0], ctx.capacity)) return [];
    if (!jobs[0].start_time) return [];
    const others = ctx.assignments.filter((x) => x.id !== assignment?.id);
    const msgs = [];
    for (const job of jobs) {
      for (let d = job.work_date; d <= endDateOf(job); d = toISO(addDays(fromISO(d), 1))) {
        const c = capacityForDay([...others, ...jobs], ctx.capacityCfg || ctx.capacity, d);
        for (const m of c.jobMsgs.get(job.id) || []) {
          const msg = `Test capacity on ${fmtDayShort(fromISO(d))} — ${m}`;
          if (!msgs.includes(msg)) msgs.push(msg);
        }
      }
    }
    return msgs;
  };

  const refresh = () => {
    renderParts();
    setBgOptions();
    pumps.rebuild();
    syncMixQty();
    rebuildDemand();
    applyOffice();
    // default start: the person's next free slot within their hours (new jobs only, until you type a start)
    if (isNew && !copyFrom && !times && !startTouched && personSel.value && selectedDates()[0] && ctx.dayOf) {
      const d0 = selectedDates()[0];
      const pd = ctx.dayOf(personSel.value, d0);
      const now = new Date();
      const fromMin = d0 === toISO(today()) ? now.getHours() * 60 + now.getMinutes() : 0;
      const slot = nextFree(pd, fromMin);
      startTime.value = slot ? fmtMin(Math.ceil(slot[0] / 5) * 5) : '';
    }
    endDateBox.hidden = !multiDay.input.checked;
    if (!multiDay.input.checked) endDate.value = '';
    pauseBox.el.hidden = isBgNow();
    const first = proposed()[0];
    timeHint.textContent = first && first.end_date
      ? `Shows as: ${timeLabel(first, first.work_date)} (and on each following day it covers)`
      : '';
    const task = ctx.taskById.get(taskSel.value);
    const needsPump = task ? task.requires_pump : true;
    modelField.querySelector('label').textContent = needsPump ? 'Pump model' : 'Pump model (optional)';
    typeField.querySelector('label').textContent = needsPump ? 'Build type' : 'Build type (optional)';
    if (needsPump && !typeSel.value && ctx.defaultType) typeSel.value = ctx.defaultType.id;
    if (repeat) repeat.setDefaultDays(selectedDates().map(isoDow));

    const p = personById.get(personSel.value);
    renderMini(p, first);
    renderSummary(first, p);
    const msgs = [];
    const notes = [];
    if (p) {
      msgs.push(...ctx.warningsFor({ person_id: p.id, task_id: taskSel.value, ...pumps.values() }, p.name));
      for (const d of selectedDates()) {
        const ab = ctx.absenceOn(p.id, d);
        if (ab) msgs.push(`${p.name} is marked ${ABSENCE_TYPES[ab.absence_type] || 'absent'} on ${fmtDayLong(fromISO(d))}.`);
      }
      for (const job of proposed()) {
        const asSaved = { ...job, background: bgSel.value === '' ? null : bgSel.value === 'true' };
        // within-hours checks are shown live in the timing summary; "Outside hours" only needs confirming if not agreed
        if (ctx.hoursWarnings) for (const m of ctx.hoursWarnings(asSaved, p.name, job.work_date)) if (!msgs.includes(m) && !((overtimeOK || splitPlan || planFor(job.work_date)?.split) && /^Outside/.test(m))) msgs.push(m);
        if (ctx.breakNotes) for (const m of ctx.breakNotes(asSaved, p.name, job.work_date)) if (!notes.includes(m)) notes.push(m);
        if (!job.task_id) continue;
        for (const m of ctx.clashWarnings(job, personById)) if (!msgs.includes(m)) msgs.push(m);
      }
    }
    const wrongStation = first && stationMismatch(first, ctx.capacity);
    if (wrongStation) msgs.push(wrongStation);
    msgs.push(...capacityWarnings());
    if (first && !first.start_time && isTestingJob(first, ctx.capacity)) notes.push('No times set — this test job is not counted in test capacity until you add a start and end time.');
    mount(warnBox, msgs.map((m) => h('p', { class: 'warn-box' }, `⚠ ${m}`)), notes.map((m) => h('p', { class: 'note-box' }, /^Works through/.test(m) ? `⏰ ${m}` : `ℹ ${m}`)));
    return msgs;
  };
  /** The person's day as a mini timeline, with this job on it. */
  function renderMini(p, job) {
    if (!p || !job || !ctx.dayOf) { mount(miniBox); return; }
    const d = job.work_date;
    const { attended, background } = ctx.jobsOn(p.id, d);
    const others = [...attended, ...background].filter((x) => x.id !== assignment?.id);
    const task = ctx.taskById.get(taskSel.value);
    const bg = bgSel.value === '' ? Boolean(task?.is_background) : bgSel.value === 'true';
    const tt = timesFor(d);
    const proposedSpan = job.start_time && !tt.multi && tt.e != null ? { s: tt.s, e: tt.e } : job.start_time ? placeOn(job, d) : null;
    mount(miniBox,
      h('div', { class: 'mini-head' }, h('b', {}, `${p.name.split(' ')[0]}’s day`), ` · ${fmtDayShort(fromISO(d))}`,
        ctx.hoursFor ? h('span', { class: 'muted small' }, ` · hours ${hoursText(ctx.hoursFor(p.id, d))}`) : null,
        !job.start_time ? h('span', { class: 'muted small' }, ' · set a start time to place this job') : null),
      miniDay({
        ctx, jobs: others, iso: d, hours: ctx.hoursFor ? ctx.hoursFor(p.id, d) : ctx.hours, absent: ctx.absenceOn(p.id, d),
        proposed: proposedSpan ? { ...proposedSpan, bg } : null,
        onPick: (s, e) => { startTouched = true; startTime.value = fmtMin(s); if (durMode !== 'end') setMode('end'); endTime.value = fmtMin(e); changed(); },
      }));
  }
  for (const el of [taskSel, pumps.modelSel, typeSel, qty, equipSel, repeat?.patternSel]) el?.addEventListener('change', refresh);
  // anything that moves the job in time re-checks it against the person's hours straight away
  for (const el of [personSel, dateInput, endDate, bgSel, multiDay.input, pauseBox.input, ...(dayBoxes || []).map((b) => b.input)]) el?.addEventListener('change', changed);
  // (registered first, so a start you type is never replaced by the suggested one)
  startTime.addEventListener('input', () => { startTouched = true; });
  startTime.addEventListener('change', () => { startTouched = true; });
  // 'input' only: a 'change' on blur would redraw the summary under the mouse and swallow a click on its buttons
  for (const el of [startTime, endTime, workDur]) el.addEventListener('input', changed);
  qty.addEventListener('input', refresh);

  const save = async () => {
    error.textContent = '';
    const task = ctx.taskById.get(taskSel.value);
    const pv = pumps.values();
    const rep = repeat?.values() || {};
    if (!task) { error.textContent = 'Please choose a task.'; return false; }
    if (task.requires_pump && !pv.pump_model_id && !pv.any_pump) { error.textContent = `${task.name} needs a pump model${task.allows_any_pump ? ' (or several pumps)' : ''}.`; return false; }
    if (pv.any_pump && !task.allows_any_pump) { error.textContent = `${task.name} doesn’t allow mixed pumps (Settings → Tasks → Allows mixed pumps).`; return false; }
    if (task.requires_pump && !typeSel.value) { error.textContent = 'Please choose a build type.'; return false; }
    const dates = selectedDates().filter(Boolean).sort();
    if (!dates.length) { error.textContent = rep.pattern ? 'Tick the first day it starts on.' : 'Please choose at least one day.'; return false; }
    if (!personSel.value && !rep.pattern) { error.textContent = 'Choose a person (only recurring jobs can wait for a person).'; return false; }
    if (qty.value !== '' && (!Number.isInteger(Number(qty.value)) || Number(qty.value) < 0)) { error.textContent = 'Quantity must be a whole number (0 or more).'; return false; }
    if ((endTime.value || workDur.value) && !startTime.value) { error.textContent = 'Add a start time (or clear the end / work time).'; return false; }
    if (durMode === 'work' && workDur.value && parseDuration(workDur.value) == null) { error.textContent = 'Enter the work time like 1h 30m, 2h or 45m.'; return false; }
    if (multiDay.input.checked && !endDate.value) { error.textContent = 'Choose the last day (Ends on), or untick "Runs over several days".'; return false; }
    if (endDate.value && endDate.value <= dates[0]) { error.textContent = '"Ends on" must be after the first day — or untick "Runs over several days".'; return false; }
    if (endDate.value && (dates.length > 1 || rep.pattern)) { error.textContent = 'With an end date, tick only the start day and don’t repeat.'; return false; }
    if ((rep.pattern === 'weekly' || rep.pattern === 'every_n_weeks') && !rep.weekdays.length) { error.textContent = 'Choose the day(s) it repeats on.'; return false; }
    if (rep.end_date && rep.end_date < dates[0]) { error.textContent = '"Repeat until" is before the start.'; return false; }

    const warnings = refresh();
    if (pv.pump_model_id === null && !pv.any_pump) { /* nothing */ }
    // Equipment bookings outside the loaded week (e.g. long jobs).
    if (equipSel.value && !(ctx.equipmentShared && ctx.equipmentShared(equipSel.value))) {
      const jobs = proposed();
      const minStart = jobs.map((j) => j.work_date).sort()[0];
      const maxEnd = jobs.map(endDateOf).sort().at(-1);
      const { data: booked } = await supabase.from('assignments').select('id, person_id, work_date, start_time, end_time, end_date')
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
    if (warnings.length && !(await confirmDialog('Save anyway?', warnings.join(' '), 'Save anyway', 'primary'))) return false;

    const values = {
      person_id: personSel.value || null,
      task_id: task.id,
      ...pv,
      build_type_id: typeSel.value || null,
      qty_target: qty.value === '' ? null : Number(qty.value),
      notes: notes.value.trim() || null,
      start_time: startTime.value || null,
      end_time: proposed()[0]?.end_time ?? (endTime.value || null),
      background: bgSel.value === '' ? null : bgSel.value === 'true',
      equipment_id: equipSel.value || null,
    };
    // demand_id comes with migration 011: only sent when used
    if (demandSel && (demandSel.value || src?.demand_id)) values.demand_id = demandSel.value || null;
    // migration 012: units done (admin) and the to-do an office job is for
    if (showDone) {
      const d = doneInp.value === '' ? null : Number(doneInp.value);
      if (d != null && (!Number.isInteger(d) || d < 0)) { error.textContent = 'Units done must be a whole number (0 or more).'; return false; }
      if (d != null && values.qty_target != null && d > values.qty_target
          && !(await confirmDialog('More than planned?', `${d} done, but the job is for ${values.qty_target}. Save anyway?`, 'Save anyway', 'primary'))) return false;
      // lowering it can't take the note's completed units below 0 (after negative corrections)
      const note = (demandSel?.value || src?.demand_id) && ctx.demand?.items?.find((x) => x.note.id === (demandSel?.value || src?.demand_id));
      const drop = (d ?? 0) - (assignment?.qty_done ?? 0);
      const below = note && drop < 0 ? belowZero(note.state, [{ taskId: task.id, delta: drop }]) : null;
      if (below) { error.textContent = below; return false; }
      values.qty_done = d;
    }
    if (todoSel && (todoSel.value || src?.todo_id)) values.todo_id = isOffice() ? todoSel.value || null : null;
    if (isOffice()) {
      Object.assign(values, { pump_model_id: null, any_pump: false, pump_mix: null, build_type_id: null, qty_target: null, equipment_id: null });
      if ('demand_id' in values || src?.demand_id) values.demand_id = null;
    }
    // only sent when off, so the form also works before migration 009
    if (!pauseBox.input.checked) values.pause_for_breaks = false;
    else if (assignment && assignment.pause_for_breaks === false) values.pause_for_breaks = true;

    // New recurring job → template + generated jobs
    if (isNew && rep.pattern) {
      const { error: err } = await supabase.from('recurring_jobs').insert({
        ...values, title: task.name, pattern: rep.pattern, weekdays: rep.weekdays, interval_weeks: rep.interval_weeks,
        start_date: dates[0], end_date: rep.end_date,
      });
      if (reportError(err, 'Saving recurring job')) return false;
      const { data: added } = await extend();
      toast(values.person_id ? `Recurring job created — ${added ?? 0} job${added === 1 ? '' : 's'} planned ahead.` : 'Recurring job saved — waiting for a person (see "Recurring jobs").', 'success');
      onSaved();
      return true;
    }

    const rowsToSave = proposed().map((j) => ({ ...values, end_time: j.end_time, work_date: j.work_date, end_date: j.end_date }));

    // Attended jobs with times that run over several working days (or already do) are saved as
    // ONE job: its parts re-flow from the first start and re-use the job's rows — never duplicates.
    const flowable = !multiDay.input.checked && !isBgNow() && Boolean(startTime.value) && !assignment?.recurring_id && !rep.pattern;
    const plans = flowable ? dates.map(planFor) : [];
    if (flowable && plans.every(Boolean) && (plans.some((x) => x.split) || seriesParts)) {
      const shared = { ...values };
      delete shared.start_time; delete shared.end_time;
      const fresh = isNew ? { rows: [] } : await loadJobRows(assignment);   // always the job as saved now
      if (reportError(fresh.error, 'Saving')) return false;
      const before = fresh.rows || [];
      const made = [];
      for (const [i, d] of dates.entries()) {
        const plan = plans[i];
        const t = timesFor(d);
        let parts = plan.parts;
        if (plan.split || (!isNew && before.length > 1 && !overtimeOK)) {
          if (splitPlan && i === 0) parts = splitPlan;
          else {
            const dayInfo = await dayInfoFor(ctx, values.person_id, d);
            parts = editJob({ current: isNew ? [] : partsOf(before), date: d, start: t.s, total: plan.total, pause: t.pause, dayInfo });
          }
        }
        const { rows, remove } = diffParts(isNew ? [] : before, parts, shared, { total: plan.total });
        const out = await saveParts({ rows, remove });
        if (reportError(out.error, 'Saving')) return false;
        made.push({ parts, headId: out.headId });
      }
      const m = made[0];
      const msg = made.length > 1 ? `Added to ${made.length} days (each job that runs past finish continues on the next working day).`
        : m.parts.length > 1 ? `${splitText(m.parts)}.` : before.length > 1 ? 'Saved — now fits in one day.' : 'Saved.';
      toast(msg, 'success', made.length === 1 ? [
        { label: 'Undo', onClick: async () => { if (await restoreJob(before, m.headId)) onSaved(); } },
        { label: 'Edit', onClick: () => openWholeJob({ ...formArgs, person }, m.headId) },
      ] : null);
      onSaved();
      return true;
    }

    if (isNew) {
      const { error: err } = await supabase.from('assignments').insert(rowsToSave);
      if (reportError(err, 'Saving')) return false;
      toast(dates.length > 1 ? `Added to ${dates.length} days.` : 'Saved.', 'success');
      onSaved();
      return true;
    }

    if (assignment.recurring_id) {
      const scope = await askScope('Edit');
      if (!scope) return false;
      if (!(await saveRecurringEdit(ctx, assignment, rowsToSave[0], scope))) return false;
      toast(scope === 'one' ? 'Saved (this one only).' : scope === 'future' ? 'Saved for this and future jobs.' : 'Saved for all jobs in the series.', 'success');
      onSaved();
      return true;
    }
    const { error: err } = await supabase.from('assignments').update(rowsToSave[0]).eq('id', assignment.id);
    if (reportError(err, 'Saving')) return false;
    toast('Saved.', 'success');
    onSaved();
    return true;
  };

  const actions = [];
  if (!isNew) {
    actions.push({
      label: 'Delete',
      variant: 'danger',
      onClick: async () => {
        if (assignment.recurring_id) {
          const scope = await askScope('Delete');
          if (!scope) return false;
          if (!(await deleteRecurring(ctx, assignment, scope))) return false;
          toast(scope === 'one' ? 'Deleted (this one only).' : scope === 'future' ? 'Deleted this and future jobs.' : 'Deleted the whole series.', 'success');
          onSaved();
          return true;
        }
        if (seriesParts) {
          const opened = Math.max(0, seriesParts.findIndex((x) => x.id === (openedId || assignment.id)));
          const choice = await askPartOrJob(opened + 1, seriesParts.length);
          if (!choice) return false;
          const { rows: before, error: e0 } = await loadJobRows(assignment);
          if (reportError(e0, 'Deleting')) return false;
          const head = before.find((r) => !r.part_of) || before[0];
          let headId = null;
          if (choice === 'job') {
            const { error: err } = await supabase.from('assignments').delete().eq('id', head.id);   // its parts go with it
            if (reportError(err, 'Deleting')) return false;
          } else {
            const cur = partsOf(before);
            const idx = cur.findIndex((x) => x.id === (openedId || assignment.id));
            const dayInfo = await dayInfoFor(ctx, head.person_id, before[0].work_date);
            const res = removePart({ current: cur, index: idx < 0 ? opened : idx, pause: head.pause_for_breaks !== false, dayInfo });
            const { rows, remove } = diffParts(before, res.parts, { ...pickShared(head), qty_done: head.qty_done ?? null }, { total: res.total });
            const out = await saveParts({ rows, remove });
            if (reportError(out.error, 'Deleting')) return false;
            headId = out.headId;
          }
          toast(choice === 'job' ? 'Deleted the whole job.' : 'Deleted this part.', 'success',
            [{ label: 'Undo', onClick: async () => { if (await restoreJob(before, headId)) onSaved(); } }]);
          onSaved();
          return true;
        }
        if (!(await confirmDialog('Delete this job?', 'Remove it from the plan? (The change history keeps a record.)'))) return false;
        const { error: err } = await supabase.from('assignments').delete().eq('id', assignment.id);
        if (reportError(err, 'Deleting')) return false;
        toast('Deleted.', 'success', [{ label: 'Undo', onClick: async () => { if (await restoreJob([assignment], null)) onSaved(); } }]);
        onSaved();
        return true;
      },
    });
    actions.push({
      label: 'Duplicate…',
      onClick: () => {
        setTimeout(() => editAssignment({
          ctx, person: personById.get(personSel.value) || person, iso: dateInput.value, isoDays, personById, onSaved,
          copyFrom: {
            task_id: taskSel.value, ...pumps.values(), build_type_id: typeSel.value,
            qty_target: qty.value === '' ? null : Number(qty.value), notes: notes.value,
            start_time: startTime.value || null, end_time: endTime.value || null,
            background: bgSel.value === '' ? null : bgSel.value === 'true', equipment_id: equipSel.value || null,
            work_date: dateInput.value, end_date: endDate.value || null,
            _total: seriesTotal ?? (durMode === 'work' ? parseDuration(workDur.value) : null),
          },
        }), 0);
        return true;
      },
    });
  }
  actions.push({ label: 'Cancel' }, { label: isNew ? 'Add' : 'Save', variant: 'primary', onClick: save });

  formModal = openModal({
    title: isNew ? (copyFrom ? 'Duplicate job' : 'Add work') : assignment.recurring_id ? '🔁 Edit recurring job' : seriesParts ? `Edit job · over ${seriesParts.length} days` : 'Edit job',
    body: h('div', { class: 'stack' },
      h('div', { class: 'form-grid form-grid-2' }, field('Person', personSel), isNew ? null : field(seriesParts ? 'Starts on' : 'Date', dateInput, seriesParts ? 'Moving it moves every part' : undefined)),
      isNew ? h('fieldset', { class: 'skills-fieldset' },
        h('legend', {}, copyFrom ? 'Copy to day(s) this week' : 'Day(s) this week'),
        h('div', { class: 'day-checks' }, dayBoxes.map((b) => b.el)),
      ) : null,
      field('Task / operation', taskSel),
      notesTop,
      todoField,
      h('div', { class: 'form-grid form-grid-2' }, modelField, typeField),
      pumps.mixBox,
      qtyRow,
      h('fieldset', { class: 'skills-fieldset' },
        h('legend', {}, 'Timing & equipment (optional)'),
        h('div', { class: 'form-grid form-grid-3 timing-grid' },
          field('Start time', startTime),
          h('div', { class: 'field' }, h('div', { class: 'seg seg-sm', role: 'group', 'aria-label': 'Set the end by' }, modeEnd, modeWork), endField, workField),
          h('div', { class: 'field timing-checks' }, pauseBox.el, multiDay.el)),
        endDateBox,
        partsBox,
        summaryBox,
        timeHint,
        miniBox,
        h('div', { class: 'form-grid form-grid-2' }, field('Runs', bgSel), equipField),
        demandField,
      ),
      repeat ? h('fieldset', { class: 'skills-fieldset' }, h('legend', {}, '🔁 Repeat'), repeat.el) : null,
      assignment?.recurring_id ? h('p', { class: 'muted small' }, `🔁 Part of a recurring series${ctx.recurringById?.get(assignment.recurring_id) ? ` — ${describeRepeat(ctx.recurringById.get(assignment.recurring_id))}` : ''}.`) : null,
      notesBottom,
      warnBox,
      error,
    ),
    actions,
  });
  if (seriesParts) multiDay.el.hidden = true;   // a job over several days is shown by its parts instead
  const initWork = seriesTotal ?? copyFrom?._total ?? null;
  if (initWork != null) {
    durMode = 'work';
    workDur.value = fmtDur(initWork).replace(/ /g, ' ');
    endField.hidden = true; workField.hidden = false;
    modeWork.classList.add('active'); modeEnd.classList.remove('active');
    modeWork.setAttribute('aria-pressed', 'true'); modeEnd.setAttribute('aria-pressed', 'false');
  }
  refresh();
  (isNew && !copyFrom ? taskSel : qty).focus();
}

// ------------------------------------------------------------------ recurring edits / deletes
async function saveRecurringEdit(ctx, assignment, row, scope) {
  const tpl = await loadTemplate(ctx, assignment.recurring_id);
  const d = assignment.recurring_date || assignment.work_date;
  const fields = pick(row);
  if (scope === 'one' || !tpl) {
    const { error } = await supabase.from('assignments').update({ ...row, recurring_detached: true }).eq('id', assignment.id);
    return !reportError(error, 'Saving');
  }
  if (scope === 'future' && d > tpl.start_date) {
    const todayISO = toISO(today());
    const { data: created, error: e1 } = await supabase.from('recurring_jobs')
      .insert({ ...pick(tpl, TEMPLATE_FIELDS), ...fields, start_date: d, end_date: tpl.end_date }).select('id').single();
    if (reportError(e1, 'Saving')) return false;
    let { error } = await supabase.from('recurring_jobs').update({ end_date: toISO(addDays(fromISO(d), -1)) }).eq('id', tpl.id);
    if (reportError(error, 'Saving')) return false;
    if (d >= todayISO) {
      ({ error } = await supabase.from('assignments').delete().eq('recurring_id', tpl.id).gte('recurring_date', d));
    } else {
      ({ error } = await supabase.from('assignments').update({ ...row, recurring_id: created.id, recurring_date: d, recurring_detached: false }).eq('id', assignment.id));
      if (!error) ({ error } = await supabase.from('assignments').delete().eq('recurring_id', tpl.id).gte('recurring_date', todayISO));
    }
    if (reportError(error, 'Saving')) return false;
    await extend();
    return true;
  }
  // all (also "future" from the first job)
  let { error } = await supabase.from('recurring_jobs').update(fields).eq('id', tpl.id);
  if (!error) ({ error } = await supabase.from('assignments').update(fields).eq('recurring_id', tpl.id).eq('recurring_detached', false));
  if (!error && row.work_date !== assignment.work_date) {
    ({ error } = await supabase.from('assignments').update({ work_date: row.work_date, end_date: row.end_date }).eq('id', assignment.id));
  }
  if (reportError(error, 'Saving')) return false;
  await extend();
  return true;
}

async function deleteRecurring(ctx, assignment, scope) {
  const tpl = await loadTemplate(ctx, assignment.recurring_id);
  const d = assignment.recurring_date || assignment.work_date;
  let error;
  if (scope === 'one' || !tpl) {
    ({ error } = await supabase.from('assignments').delete().eq('id', assignment.id));
    if (!error && tpl) ({ error } = await supabase.from('recurring_exceptions').insert({ recurring_id: tpl.id, skip_date: d }));
  } else if (scope === 'future' && d > tpl.start_date) {
    ({ error } = await supabase.from('assignments').delete().eq('recurring_id', tpl.id).gte('recurring_date', d));
    if (!error) ({ error } = await supabase.from('recurring_jobs').update({ end_date: toISO(addDays(fromISO(d), -1)) }).eq('id', tpl.id));
  } else {
    ({ error } = await supabase.from('assignments').delete().eq('recurring_id', tpl.id));
    if (!error) ({ error } = await supabase.from('recurring_jobs').delete().eq('id', tpl.id));
  }
  return !reportError(error, 'Deleting');
}

// ------------------------------------------------------------------ recurring template form
export function editTemplate({ ctx, template, personById, onSaved }) {
  const t = template || { pattern: 'workdays', weekdays: [1, 2, 3, 4, 5], start_date: toISO(today()) };
  const title = h('input', { type: 'text', maxlength: 80, value: t.title || '', placeholder: 'e.g. Rental repairs' });
  const personSel = h('select', {}, h('option', { value: '' }, '— Not assigned yet —'),
    options([...personById.values()].filter((p) => p.active || p.id === t.person_id), t.person_id));
  personSel.value = t.person_id || '';
  const taskSel = h('select', {}, options(ctx.tasks, t.task_id, { blank: t.task_id ? null : '— choose a task —' }));
  const pumps = pumpFields(ctx, t, taskSel, { mix: false });   // recurring templates: no per-model list
  const typeSel = h('select', {}, options(ctx.types, t.build_type_id ?? ctx.defaultType?.id, { blank: '— none —' }));
  const qty = h('input', { type: 'number', min: 0, step: 1, value: t.qty_target ?? '' });
  const startTime = h('input', { type: 'time', step: 300, value: hm(t.start_time) ?? '' });
  const endTime = h('input', { type: 'time', step: 300, value: hm(t.end_time) ?? '' });
  const bgSel = h('select', {}, h('option', { value: '' }, 'Task default'), h('option', { value: 'true' }, '⏱ Background / unattended'), h('option', { value: 'false' }, 'Attended'));
  bgSel.value = t.background == null ? '' : String(t.background);
  const equipSel = h('select', {}, options(ctx.equipment, t.equipment_id, { blank: '— none —' }));
  const startDate = h('input', { type: 'date', value: t.start_date, required: true });
  const notes = h('textarea', { rows: 2, maxlength: 500 }, t.notes ?? '');
  const repeat = repeatFields(t);
  repeat.patternSel.querySelector('option[value=""]').remove();
  repeat.patternSel.value = t.pattern;
  repeat.patternSel.dispatchEvent(new Event('change'));
  const error = h('p', { class: 'form-error', role: 'alert' });
  taskSel.addEventListener('change', pumps.rebuild);
  pumps.rebuild();

  openModal({
    title: template ? (template.person_id ? '🔁 Edit recurring job' : '🔁 Assign recurring job') : '🔁 New recurring job',
    body: h('div', { class: 'stack' },
      h('div', { class: 'form-grid form-grid-2' }, field('Name', title), field('Person', personSel, 'Jobs are created once a person is chosen.')),
      h('div', { class: 'form-grid form-grid-2 times-first' },
        field('Start time', startTime, 'Set the time yourself — leave empty for all day.'),
        field('End time', endTime, 'Earlier than start = runs overnight.')),
      field('Task / operation', taskSel),
      h('div', { class: 'form-grid form-grid-2' }, field('Pump model', pumps.modelSel), field('Build type', typeSel)),
      pumps.mixBox,
      field('Quantity', qty),
      h('div', { class: 'form-grid form-grid-2' }, field('Runs', bgSel), field('Equipment / test station', equipSel)),
      h('fieldset', { class: 'skills-fieldset' }, h('legend', {}, 'Repeat'), field('Starts on', startDate), repeat.el),
      field('Notes', notes),
      template ? h('p', { class: 'muted small' }, 'Saving updates this job from today onwards; past jobs stay as they were.') : null,
      error,
    ),
    actions: [
      { label: 'Cancel' },
      {
        label: template && !template.person_id ? 'Assign & plan' : 'Save',
        variant: 'primary',
        onClick: async () => {
          error.textContent = '';
          const task = ctx.taskById.get(taskSel.value);
          const pv = pumps.values();
          const rep = repeat.values();
          if (!task) { error.textContent = 'Please choose a task.'; return false; }
          if (task.requires_pump && !pv.pump_model_id && !pv.any_pump) { error.textContent = `${task.name} needs a pump model${task.allows_any_pump ? ' (or several pumps)' : ''}.`; return false; }
          if ((rep.pattern === 'weekly' || rep.pattern === 'every_n_weeks') && !rep.weekdays.length) { error.textContent = 'Choose the day(s) it repeats on.'; return false; }
          if (endTime.value && !startTime.value) { error.textContent = 'Add a start time (or clear the end time).'; return false; }
          if (rep.end_date && rep.end_date < startDate.value) { error.textContent = '"Repeat until" is before the start.'; return false; }
          const values = {
            title: title.value.trim() || task.name, person_id: personSel.value || null, task_id: task.id, ...pv,
            build_type_id: typeSel.value || null, qty_target: qty.value === '' ? null : Number(qty.value),
            start_time: startTime.value || null, end_time: endTime.value || null,
            background: bgSel.value === '' ? null : bgSel.value === 'true', equipment_id: equipSel.value || null,
            notes: notes.value.trim() || null, start_date: startDate.value, ...rep, active: true,
          };
          let err;
          if (template) {
            ({ error: err } = await supabase.from('recurring_jobs').update(values).eq('id', template.id));
            // Re-plan from today: remove future jobs that weren't edited individually, then regenerate.
            if (!err) ({ error: err } = await supabase.from('assignments').delete().eq('recurring_id', template.id).gte('recurring_date', toISO(today())).eq('recurring_detached', false));
          } else {
            ({ error: err } = await supabase.from('recurring_jobs').insert(values));
          }
          if (reportError(err, 'Saving recurring job')) return false;
          const { data: added } = await extend();
          toast(values.person_id ? `Saved — ${added ?? 0} job${added === 1 ? '' : 's'} planned ahead.` : 'Saved — waiting for a person.', 'success');
          onSaved();
          return true;
        },
      },
    ],
  });
}

/** "Stop" a recurring job: future jobs from today are removed, past ones stay. */
export async function deleteTemplate({ template, onDone }) {
  const todayISO = toISO(today());
  const ok = await confirmDialog('Stop this recurring job?',
    `“${template.title || 'Recurring job'}” will stop repeating. Its jobs from today onwards are removed; past jobs stay in the plan.`, 'Stop repeating');
  if (!ok) return;
  let { error } = await supabase.from('assignments').delete().eq('recurring_id', template.id).gte('recurring_date', todayISO);
  if (!error) {
    ({ error } = template.start_date >= todayISO
      ? await supabase.from('recurring_jobs').delete().eq('id', template.id)
      : await supabase.from('recurring_jobs').update({ active: false, end_date: toISO(addDays(today(), -1)) }).eq('id', template.id));
  }
  if (reportError(error, 'Stopping')) return;
  toast('Recurring job stopped.', 'success');
  onDone();
}

/** Change the times of a recurring job from the 🔁 panel. */
export async function saveTemplateTimes({ template, start, end, hasJobs, onSaved }) {
  if (end && !start) { toast('Add a start time (or clear the end time).', 'error'); return; }
  const times = { start_time: start || null, end_time: end || null };
  let scope = 'template';
  if (hasJobs) {
    scope = await new Promise((resolve) => {
      let done = false;
      const pickScope = (v) => () => { done = true; resolve(v); };
      const { dialog } = openModal({
        title: 'Change times',
        body: h('div', { class: 'stack-sm' },
          h('p', {}, `New times for “${template.title || 'Recurring job'}”: ${start || 'all day'}${end ? ` – ${end}` : ''}.`),
          h('p', { class: 'muted small' }, 'Jobs you changed individually (“this one only”) keep their own times. To change just one day, open that job in the planner.')),
        actions: [
          { label: 'Cancel', onClick: pickScope(null) },
          { label: 'From today onwards', onClick: pickScope('future') },
          { label: 'All jobs in the series', variant: 'primary', onClick: pickScope('all') },
        ],
      });
      dialog.addEventListener('close', () => { if (!done) resolve(null); });
    });
    if (!scope) return;
  }
  let { error } = await supabase.from('recurring_jobs').update(times).eq('id', template.id);
  if (!error && scope !== 'template') {
    let q = supabase.from('assignments').update(times).eq('recurring_id', template.id).eq('recurring_detached', false);
    if (scope === 'future') q = q.gte('recurring_date', toISO(today()));
    ({ error } = await q);
  }
  if (reportError(error, 'Saving times')) return;
  toast(scope === 'future' ? 'Times changed from today onwards.' : scope === 'all' ? 'Times changed for the whole series.' : 'Times saved.', 'success');
  onSaved();
}
