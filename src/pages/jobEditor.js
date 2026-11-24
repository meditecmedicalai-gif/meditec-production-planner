// Job form (add / edit / duplicate), recurring-job form and the
// "this one / this and future / all" choices for recurring jobs.
import { h, mount, toast, reportError, openModal, confirmDialog, field, checkbox } from '../ui.js';
import { supabase } from '../supabase.js';
import { endDateOf, timeLabel, overlaps, hm, ABSENCE_TYPES } from '../jobs.js';
import { capacityForDay, isTestingJob } from '../capacity.js';
import { PATTERNS, describe as describeRepeat, isoDow, JOB_FIELDS, pick } from '../recurring.js';
import { toISO, fromISO, addDays, today, fmtDayShort, fmtDayLong } from '../dates.js';

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
/** Pump model select with "Any / mixed pump" for tasks that allow it, plus the optional mix list. */
function pumpFields(ctx, src, taskSel) {
  const modelSel = h('select', {});
  const mixInputs = new Map();
  const mixBox = h('fieldset', { class: 'skills-fieldset mix-box', hidden: true },
    h('legend', {}, 'Actual pumps (optional — fill in when known)'),
    h('div', { class: 'mix-grid' }, ctx.models.filter((m) => m.active).map((m) => {
      const inp = h('input', { type: 'number', min: 0, step: 1, inputmode: 'numeric', 'aria-label': `${m.name} count`,
        value: (src?.pump_mix || []).find((x) => x.pump_model_id === m.id)?.qty ?? '' });
      mixInputs.set(m.id, inp);
      return h('label', { class: 'mix-item' }, h('span', {}, m.short_code || m.name), inp);
    })),
  );
  let init = false;
  const rebuild = () => {
    const task = ctx.taskById.get(taskSel.value);
    const cur = init ? modelSel.value : (src?.any_pump ? ANY : src?.pump_model_id || '');
    init = true;
    const allowAny = task?.allows_any_pump || cur === ANY;
    mount(modelSel, options(ctx.models, null, { blank: '— none —' }),
      allowAny ? h('option', { value: ANY }, 'Any / mixed pump') : null);
    modelSel.value = [...modelSel.options].some((o) => o.value === cur) ? cur : '';
    mixBox.hidden = modelSel.value !== ANY;
  };
  modelSel.addEventListener('change', () => { mixBox.hidden = modelSel.value !== ANY; });
  const values = () => {
    const any = modelSel.value === ANY;
    const mix = any ? [...mixInputs].map(([id, inp]) => ({ pump_model_id: id, qty: Number(inp.value) || 0 })).filter((x) => x.qty > 0) : [];
    return { pump_model_id: any ? null : modelSel.value || null, any_pump: any, pump_mix: mix.length ? mix : null };
  };
  return { modelSel, mixBox, rebuild, values };
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
export function editAssignment({ ctx, person, iso, assignment, isoDays, personById, onSaved, copyFrom }) {
  const src = assignment || copyFrom || null;
  const isNew = !assignment;
  const activePeople = [...personById.values()].filter((p) => p.active || p.id === person?.id);

  const personSel = h('select', {}, options(activePeople, person?.id),
    isNew ? h('option', { value: '' }, '— Not assigned yet (recurring only) —') : null);
  const taskSel = h('select', {}, options(ctx.tasks, src?.task_id, { blank: src ? null : '— choose a task —' }));
  const pumps = pumpFields(ctx, src, taskSel);
  const typeSel = h('select', {}, options(ctx.types, src?.build_type_id ?? ctx.defaultType?.id, { blank: '— none —' }));
  const qty = h('input', { type: 'number', min: 0, step: 1, inputmode: 'numeric', value: src?.qty_target ?? '' });
  const notes = h('textarea', { rows: 2, maxlength: 500 }, src?.notes ?? '');
  const startTime = h('input', { type: 'time', step: 300, value: hm(src?.start_time) ?? '' });
  const endTime = h('input', { type: 'time', step: 300, value: hm(src?.end_time) ?? '' });
  const spanDays = src?.end_date ? Math.round((fromISO(src.end_date) - fromISO(src.work_date || iso)) / 86400000) : null;
  const endDate = h('input', { type: 'date', value: assignment?.end_date ?? '' });
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
  const timeHint = h('p', { class: 'muted small time-hint' });
  const warnBox = h('div', { class: 'stack-sm', 'aria-live': 'polite' });
  const error = h('p', { class: 'form-error', role: 'alert' });

  const dayBoxes = isNew ? isoDays.map((d) => ({ iso: d, ...checkbox(fmtDayShort(fromISO(d)), !copyFrom && d === iso) })) : null;
  const dateInput = isNew ? null : h('input', { type: 'date', value: assignment.work_date, required: true });
  const selectedDates = () => (isNew ? dayBoxes.filter((b) => b.input.checked).map((b) => b.iso) : [dateInput.value]);
  const repeat = isNew ? repeatFields({}) : null;

  const modelField = field('Pump model', pumps.modelSel);
  const typeField = field('Build type', typeSel);

  /** The job(s) as they would be saved, for warnings. */
  const proposed = () => selectedDates().filter(Boolean).map((d, i) => ({
    id: assignment?.id || `proposed-${i}`, person_id: personSel.value, task_id: taskSel.value, work_date: d,
    ...pumps.values(), qty_target: qty.value === '' ? null : Number(qty.value),
    start_time: startTime.value || null, end_time: endTime.value || null,
    end_date: isNew ? (spanDays != null && !endDate.value ? toISO(addDays(fromISO(d), spanDays)) : endDate.value || null) : endDate.value || null,
    equipment_id: equipSel.value || null, background: bgSel.value === '' ? null : bgSel.value === 'true',
  }));

  const capacityWarnings = () => {
    const jobs = proposed();
    if (!jobs.length || !isTestingJob(jobs[0], ctx.capacity)) return [];
    const others = ctx.assignments.filter((x) => x.id !== assignment?.id);
    const msgs = [];
    for (const job of jobs) {
      for (let d = job.work_date; d <= endDateOf(job); d = toISO(addDays(fromISO(d), 1))) {
        const c = capacityForDay([...others, ...jobs], ctx.capacity, d);
        for (const m of c.jobMsgs.get(job.id) || []) {
          const msg = `Test capacity on ${fmtDayShort(fromISO(d))} — ${m}`;
          if (!msgs.includes(msg)) msgs.push(msg);
        }
      }
    }
    return msgs;
  };

  const refresh = () => {
    setBgOptions();
    pumps.rebuild();
    const first = proposed()[0];
    timeHint.textContent = first && (first.start_time || first.end_date)
      ? `Shows as: ${timeLabel(first, first.work_date)}${endDateOf(first) !== first.work_date ? ' (and on each following day it covers)' : ''}`
      : 'No times = all day (counts all day towards test capacity).';
    const task = ctx.taskById.get(taskSel.value);
    const needsPump = task ? task.requires_pump : true;
    modelField.querySelector('label').textContent = needsPump ? 'Pump model' : 'Pump model (optional)';
    typeField.querySelector('label').textContent = needsPump ? 'Build type' : 'Build type (optional)';
    if (needsPump && !typeSel.value && ctx.defaultType) typeSel.value = ctx.defaultType.id;
    if (repeat) repeat.setDefaultDays(selectedDates().map(isoDow));

    const p = personById.get(personSel.value);
    const msgs = [];
    if (p) {
      msgs.push(...ctx.warningsFor({ person_id: p.id, task_id: taskSel.value, ...pumps.values() }, p.name));
      for (const d of selectedDates()) {
        const ab = ctx.absenceOn(p.id, d);
        if (ab) msgs.push(`${p.name} is marked ${ABSENCE_TYPES[ab.absence_type] || 'absent'} on ${fmtDayLong(fromISO(d))}.`);
      }
      for (const job of proposed()) {
        if (!job.task_id) continue;
        for (const m of ctx.clashWarnings(job, personById)) if (!msgs.includes(m)) msgs.push(m);
      }
    }
    msgs.push(...capacityWarnings());
    mount(warnBox, msgs.map((m) => h('p', { class: 'warn-box' }, `⚠ ${m}`)));
    return msgs;
  };
  for (const el of [personSel, taskSel, pumps.modelSel, typeSel, qty, dateInput, startTime, endTime, endDate, bgSel, equipSel,
    ...(dayBoxes || []).map((b) => b.input), repeat?.patternSel]) {
    el?.addEventListener('change', refresh);
  }
  qty.addEventListener('input', refresh);

  const save = async () => {
    error.textContent = '';
    const task = ctx.taskById.get(taskSel.value);
    const pv = pumps.values();
    const rep = repeat?.values() || {};
    if (!task) { error.textContent = 'Please choose a task.'; return false; }
    if (task.requires_pump && !pv.pump_model_id && !pv.any_pump) { error.textContent = `${task.name} needs a pump model${task.allows_any_pump ? ' (or "Any / mixed pump")' : ''}.`; return false; }
    if (pv.any_pump && !task.allows_any_pump) { error.textContent = '"Any / mixed pump" is only for repair-type tasks.'; return false; }
    if (task.requires_pump && !typeSel.value) { error.textContent = 'Please choose a build type.'; return false; }
    const dates = selectedDates().filter(Boolean).sort();
    if (!dates.length) { error.textContent = rep.pattern ? 'Tick the first day it starts on.' : 'Please choose at least one day.'; return false; }
    if (!personSel.value && !rep.pattern) { error.textContent = 'Choose a person (only recurring jobs can wait for a person).'; return false; }
    if (qty.value !== '' && (!Number.isInteger(Number(qty.value)) || Number(qty.value) < 0)) { error.textContent = 'Quantity must be a whole number (0 or more).'; return false; }
    if (endTime.value && !startTime.value) { error.textContent = 'Add a start time (or clear the end time).'; return false; }
    if (endDate.value && endDate.value < dates[0]) { error.textContent = 'The end date is before the start date.'; return false; }
    if (endDate.value && (dates.length > 1 || rep.pattern)) { error.textContent = 'With an end date, tick only the start day and don’t repeat.'; return false; }
    if ((rep.pattern === 'weekly' || rep.pattern === 'every_n_weeks') && !rep.weekdays.length) { error.textContent = 'Choose the day(s) it repeats on.'; return false; }
    if (rep.end_date && rep.end_date < dates[0]) { error.textContent = '"Repeat until" is before the start.'; return false; }

    const warnings = refresh();
    if (pv.pump_model_id === null && !pv.any_pump) { /* nothing */ }
    // Equipment bookings outside the loaded week (e.g. long jobs).
    if (equipSel.value) {
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
      end_time: endTime.value || null,
      background: bgSel.value === '' ? null : bgSel.value === 'true',
      equipment_id: equipSel.value || null,
    };

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

    const rowsToSave = proposed().map((j) => ({ ...values, work_date: j.work_date, end_date: j.end_date }));
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
        setTimeout(() => editAssignment({
          ctx, person: personById.get(personSel.value) || person, iso: dateInput.value, isoDays, personById, onSaved,
          copyFrom: {
            task_id: taskSel.value, ...pumps.values(), build_type_id: typeSel.value,
            qty_target: qty.value === '' ? null : Number(qty.value), notes: notes.value,
            start_time: startTime.value || null, end_time: endTime.value || null,
            background: bgSel.value === '' ? null : bgSel.value === 'true', equipment_id: equipSel.value || null,
            work_date: dateInput.value, end_date: endDate.value || null,
          },
        }), 0);
        return true;
      },
    });
  }
  actions.push({ label: 'Cancel' }, { label: isNew ? 'Add' : 'Save', variant: 'primary', onClick: save });

  openModal({
    title: isNew ? (copyFrom ? 'Duplicate job' : 'Add work') : assignment.recurring_id ? '🔁 Edit recurring job' : 'Edit job',
    body: h('div', { class: 'stack' },
      h('div', { class: 'form-grid form-grid-2' }, field('Person', personSel), isNew ? null : field('Date', dateInput)),
      isNew ? h('fieldset', { class: 'skills-fieldset' },
        h('legend', {}, copyFrom ? 'Copy to day(s) this week' : 'Day(s) this week'),
        h('div', { class: 'day-checks' }, dayBoxes.map((b) => b.el)),
      ) : null,
      field('Task / operation', taskSel),
      h('div', { class: 'form-grid form-grid-2' }, modelField, typeField),
      pumps.mixBox,
      field('Quantity target', qty, 'Units to complete — for testing tasks, the number of pumps on test.'),
      h('fieldset', { class: 'skills-fieldset' },
        h('legend', {}, 'Timing & equipment (optional)'),
        h('div', { class: 'form-grid form-grid-3' },
          field('Start time', startTime), field('End time', endTime, 'Earlier than start = next day'), field('Ends on', endDate, 'Only for jobs over several days')),
        timeHint,
        h('div', { class: 'form-grid form-grid-2' }, field('Runs', bgSel), field('Equipment / test station', equipSel)),
      ),
      repeat ? h('fieldset', { class: 'skills-fieldset' }, h('legend', {}, '🔁 Repeat'), repeat.el) : null,
      assignment?.recurring_id ? h('p', { class: 'muted small' }, `🔁 Part of a recurring series${ctx.recurringById?.get(assignment.recurring_id) ? ` — ${describeRepeat(ctx.recurringById.get(assignment.recurring_id))}` : ''}.`) : null,
      field('Notes', notes),
      warnBox,
      error,
    ),
    actions,
  });
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
  const pumps = pumpFields(ctx, t, taskSel);
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
      field('Task / operation', taskSel),
      h('div', { class: 'form-grid form-grid-2' }, field('Pump model', pumps.modelSel), field('Build type', typeSel)),
      pumps.mixBox,
      h('div', { class: 'form-grid form-grid-3' }, field('Quantity', qty), field('Start time', startTime), field('End time', endTime)),
      h('div', { class: 'form-grid form-grid-2' }, field('Runs', bgSel), field('Equipment', equipSel)),
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
          if (task.requires_pump && !pv.pump_model_id && !pv.any_pump) { error.textContent = `${task.name} needs a pump model${task.allows_any_pump ? ' (or "Any / mixed pump")' : ''}.`; return false; }
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
