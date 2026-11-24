// Working-hours dialogs: one-off change for a day, a person's pattern
// (with "effective from" and overrides), and work patterns (Settings).
import { h, toast, reportError, openModal, confirmDialog, field, checkbox } from '../ui.js';
import { supabase } from '../supabase.js';
import { fromISO, fmtDayLong, toISO, today } from '../dates.js';
import { hm } from '../jobs.js';
import { WEEKDAY_NAMES, hoursLong } from '../hours.js';

const timeInput = (v, label) => h('input', { type: 'time', step: 300, value: hm(v) ?? '', 'aria-label': label });
const minsInput = (v, label) => h('input', { type: 'number', min: 0, max: 240, step: 5, inputmode: 'numeric', value: v ?? '', 'aria-label': label });
const val = (inp) => (inp.value === '' ? null : inp.value);
const num = (inp) => (inp.value === '' ? null : Number(inp.value));

// ------------------------------------------------------------------ one-off change for a single day
/**
 * base: hours without the one-off change (workHours.baseFor);
 * existing: the person_day_hours row, if any.
 */
export function editDayHours({ person, iso, base, existing, onSaved }) {
  const cur = { ...base, ...(existing ? Object.fromEntries(Object.entries({
    work_start: existing.start_time, work_end: existing.end_time, break_time: existing.break_time,
    break_minutes: existing.break_minutes, lunch_time: existing.lunch_time, lunch_minutes: existing.lunch_minutes,
  }).filter(([, v]) => v != null)) : {}) };
  const works = checkbox('Working this day', existing ? existing.works : base.works !== false);
  const start = timeInput(cur.work_start, 'Start');
  const end = timeInput(cur.work_end, 'Finish');
  const brk = timeInput(cur.break_time, 'Break at');
  const brkM = minsInput(cur.break_minutes, 'Break (min)');
  const lunch = timeInput(cur.lunch_time, 'Lunch at');
  const lunchM = minsInput(cur.lunch_minutes, 'Lunch (min)');
  const notes = h('input', { type: 'text', maxlength: 200, value: existing?.notes ?? '', placeholder: 'e.g. dentist, leaving early' });
  const error = h('p', { class: 'form-error', role: 'alert' });
  const timeBox = h('div', { class: 'stack-sm' },
    h('div', { class: 'form-grid form-grid-2' }, field('Start', start), field('Finish', end)),
    h('div', { class: 'form-grid form-grid-4' }, field('Break at', brk), field('Break (min)', brkM), field('Lunch at', lunch), field('Lunch (min)', lunchM)));
  const sync = () => { timeBox.hidden = !works.input.checked; };
  works.input.addEventListener('change', sync); sync();

  // Only what differs from the usual hours is stored, so later pattern changes still apply.
  const diff = (inp, baseV, isNum) => {
    const v = isNum ? num(inp) : val(inp);
    if (v == null) return null;
    if (isNum ? v === Number(baseV ?? 0) : hm(v) === hm(baseV)) return null;
    return v;
  };

  const actions = [];
  if (existing) {
    actions.push({
      label: 'Back to usual hours', variant: 'danger',
      onClick: async () => {
        const { error: err } = await supabase.from('person_day_hours').delete().eq('id', existing.id);
        if (reportError(err, 'Removing')) return false;
        toast('Back to the usual hours.', 'success'); onSaved(); return true;
      },
    });
  }
  actions.push({ label: 'Cancel' }, {
    label: 'Save', variant: 'primary',
    onClick: async () => {
      error.textContent = '';
      const w = works.input.checked;
      if (w && (!start.value || !end.value)) { error.textContent = 'Give a start and finish time.'; return false; }
      if (w && end.value <= start.value) { error.textContent = 'The finish time must be after the start.'; return false; }
      const row = {
        person_id: person.id, work_date: iso, works: w, notes: notes.value.trim() || null,
        start_time: w ? diff(start, base.work_start) : null, end_time: w ? diff(end, base.work_end) : null,
        break_time: w ? diff(brk, base.break_time) : null, break_minutes: w ? diff(brkM, base.break_minutes, true) : null,
        lunch_time: w ? diff(lunch, base.lunch_time) : null, lunch_minutes: w ? diff(lunchM, base.lunch_minutes, true) : null,
      };
      if (!base.works && w) Object.assign(row, { start_time: start.value, end_time: end.value });
      const same = w === (base.works !== false) && ['start_time', 'end_time', 'break_time', 'break_minutes', 'lunch_time', 'lunch_minutes'].every((k) => row[k] == null);
      if (same && !row.notes) {
        if (existing) { await supabase.from('person_day_hours').delete().eq('id', existing.id); onSaved(); }
        toast('No change from the usual hours.'); return true;
      }
      const { error: err } = existing
        ? await supabase.from('person_day_hours').update(row).eq('id', existing.id)
        : await supabase.from('person_day_hours').insert(row);
      if (reportError(err, 'Saving hours')) return false;
      toast('Hours for the day saved.', 'success'); onSaved(); return true;
    },
  });
  openModal({
    title: `Hours · ${person.name} · ${fmtDayLong(fromISO(iso))}`,
    body: h('div', { class: 'stack' },
      h('p', { class: 'muted small' }, `Usual hours: ${hoursLong(base)}${base.pattern ? ` (${base.pattern.name})` : ''}. Change them for this day only — e.g. leaving at 14:00 or lunch at 13:30.`),
      works.el, timeBox, field('Notes', notes), error),
    actions,
  });
}

// ------------------------------------------------------------------ a person's pattern (People page)
/** assignments: that person's person_work_patterns rows. */
export function editPersonPattern({ person, patterns, assignment, onSaved }) {
  const active = patterns.filter((p) => p.active || p.id === assignment?.pattern_id);
  const patSel = h('select', {}, active.map((p) => h('option', { value: p.id }, p.name + (p.is_default ? ' (default)' : ''))));
  patSel.value = assignment?.pattern_id || (patterns.find((p) => p.is_default) || active[0])?.id || '';
  const from = h('input', { type: 'date', value: assignment?.effective_from || toISO(today()), required: true });
  const o = assignment || {};
  const start = timeInput(o.start_time, 'Start (override)');
  const end = timeInput(o.end_time, 'Finish (override)');
  const brk = timeInput(o.break_time, 'Break at (override)');
  const brkM = minsInput(o.break_minutes, 'Break minutes (override)');
  const lunch = timeInput(o.lunch_time, 'Lunch at (override)');
  const lunchM = minsInput(o.lunch_minutes, 'Lunch minutes (override)');
  const error = h('p', { class: 'form-error', role: 'alert' });
  const actions = [];
  if (assignment) {
    actions.push({
      label: 'Delete', variant: 'danger',
      onClick: async () => {
        if (!(await confirmDialog('Delete this hours change?', `${person.name} goes back to the pattern before ${assignment.effective_from} (or the default).`))) return false;
        const { error: err } = await supabase.from('person_work_patterns').delete().eq('id', assignment.id);
        if (reportError(err, 'Deleting')) return false;
        toast('Deleted.', 'success'); onSaved(); return true;
      },
    });
  }
  actions.push({ label: 'Cancel' }, {
    label: 'Save', variant: 'primary',
    onClick: async () => {
      if (!patSel.value || !from.value) { error.textContent = 'Choose a pattern and a date.'; return false; }
      if (start.value && end.value && end.value <= start.value) { error.textContent = 'The finish must be after the start.'; return false; }
      const row = {
        person_id: person.id, pattern_id: patSel.value, effective_from: from.value,
        start_time: val(start), end_time: val(end), break_time: val(brk), break_minutes: num(brkM), lunch_time: val(lunch), lunch_minutes: num(lunchM),
      };
      const { error: err } = assignment
        ? await supabase.from('person_work_patterns').update(row).eq('id', assignment.id)
        : await supabase.from('person_work_patterns').insert(row);
      if (err?.code === '23505') { error.textContent = 'There is already a change on that date — edit that one instead.'; return false; }
      if (reportError(err, 'Saving')) return false;
      toast('Working hours saved.', 'success'); onSaved(); return true;
    },
  });
  openModal({
    title: `Working hours · ${person.name}`,
    body: h('div', { class: 'stack' },
      h('div', { class: 'form-grid form-grid-2' }, field('Work pattern', patSel), field('Effective from', from, 'Weeks before this date keep their old hours.')),
      h('fieldset', { class: 'skills-fieldset' },
        h('legend', {}, 'Overrides for this person (optional — leave empty to use the pattern)'),
        h('div', { class: 'form-grid form-grid-2' }, field('Start', start), field('Finish', end)),
        h('div', { class: 'form-grid form-grid-4' }, field('Break at', brk), field('Break (min)', brkM), field('Lunch at', lunch), field('Lunch (min)', lunchM)),
        h('p', { class: 'muted small' }, 'Overrides apply on every working day of the pattern.')),
      error),
    actions,
  });
}

// ------------------------------------------------------------------ work pattern (Settings)
/** days: that pattern's work_pattern_days rows (7 or fewer). */
export function editPattern({ pattern, days, onSaved, isOnlyDefault }) {
  const name = h('input', { type: 'text', maxlength: 60, value: pattern?.name ?? '', required: true, placeholder: 'e.g. Early 07:00–15:00' });
  const notes = h('input', { type: 'text', maxlength: 120, value: pattern?.notes ?? '' });
  const isDefault = checkbox('Default pattern (for anyone without one)', Boolean(pattern?.is_default));
  if (isOnlyDefault) isDefault.input.disabled = true;
  const byDow = new Map((days || []).map((d) => [d.weekday, d]));
  const seed = byDow.get(1) || { start_time: '08:30', end_time: '16:30', break_time: '10:30', break_minutes: 15, lunch_time: '12:30', lunch_minutes: 30 };
  const rows = WEEKDAY_NAMES.map((dn, i) => {
    const w = i + 1;
    const d = byDow.get(w) || { ...seed, works: w <= 5 };
    const works = h('input', { type: 'checkbox', checked: Boolean(d.works), 'aria-label': `${dn}: working day` });
    const f = {
      start: timeInput(d.start_time || seed.start_time, `${dn} start`), end: timeInput(d.end_time || seed.end_time, `${dn} finish`),
      brk: timeInput(d.break_time || seed.break_time, `${dn} break at`), brkM: minsInput(d.break_minutes ?? seed.break_minutes, `${dn} break minutes`),
      lunch: timeInput(d.lunch_time || seed.lunch_time, `${dn} lunch at`), lunchM: minsInput(d.lunch_minutes ?? seed.lunch_minutes, `${dn} lunch minutes`),
    };
    const tr = h('tr', {},
      h('th', { scope: 'row' }, h('label', { class: 'wd-label' }, works, ` ${dn.slice(0, 3)}`)),
      Object.values(f).map((inp) => h('td', {}, inp)));
    const sync = () => { tr.classList.toggle('off', !works.checked); Object.values(f).forEach((x) => { x.disabled = !works.checked; }); };
    works.addEventListener('change', sync); sync();
    return { w, dn, works, f, tr };
  });
  const copyMon = h('button', { type: 'button', class: 'btn btn-xs', onclick: () => {
    const m = rows[0];
    for (const r of rows.slice(1)) if (r.works.checked) for (const k of Object.keys(r.f)) r.f[k].value = m.f[k].value;
  } }, 'Copy Monday to the other working days');
  const error = h('p', { class: 'form-error', role: 'alert' });
  const actions = [{ label: 'Cancel' }, {
    label: 'Save', variant: 'primary',
    onClick: async () => {
      error.textContent = '';
      if (!name.value.trim()) { error.textContent = 'Give the pattern a name.'; return false; }
      for (const r of rows) {
        if (!r.works.checked) continue;
        if (!r.f.start.value || !r.f.end.value || r.f.end.value <= r.f.start.value) { error.textContent = `${r.dn}: the finish must be after the start.`; return false; }
      }
      if (!rows.some((r) => r.works.checked)) { error.textContent = 'Tick at least one working day.'; return false; }
      const values = { name: name.value.trim(), notes: notes.value.trim() || null };
      let id = pattern?.id;
      if (isDefault.input.checked && !pattern?.is_default) {
        const { error: e1 } = await supabase.from('work_patterns').update({ is_default: false }).eq('is_default', true);
        if (reportError(e1, 'Saving')) return false;
        values.is_default = true;
      }
      if (id) {
        const { error: err } = await supabase.from('work_patterns').update(values).eq('id', id);
        if (err?.code === '23505') { error.textContent = 'A pattern with this name already exists.'; return false; }
        if (reportError(err, 'Saving')) return false;
      } else {
        const { data, error: err } = await supabase.from('work_patterns').insert(values).select('id').single();
        if (err?.code === '23505') { error.textContent = 'A pattern with this name already exists.'; return false; }
        if (reportError(err, 'Saving')) return false;
        id = data.id;
      }
      const dayRows = rows.map((r) => (r.works.checked
        ? { pattern_id: id, weekday: r.w, works: true, start_time: r.f.start.value, end_time: r.f.end.value,
            break_time: val(r.f.brk), break_minutes: num(r.f.brkM) || 0, lunch_time: val(r.f.lunch), lunch_minutes: num(r.f.lunchM) || 0 }
        : { pattern_id: id, weekday: r.w, works: false, start_time: null, end_time: null, break_time: null, break_minutes: 0, lunch_time: null, lunch_minutes: 0 }));
      const { error: e2 } = await supabase.from('work_pattern_days').upsert(dayRows, { onConflict: 'pattern_id,weekday' });
      if (reportError(e2, 'Saving the days')) return false;
      toast('Work pattern saved.', 'success'); onSaved(); return true;
    },
  }];
  openModal({
    title: pattern ? `Edit work pattern · ${pattern.name}` : 'New work pattern',
    wide: true,
    body: h('div', { class: 'stack' },
      h('div', { class: 'form-grid form-grid-2' }, field('Name', name), field('Notes', notes)),
      isDefault.el,
      h('div', { class: 'table-scroll' }, h('table', { class: 'pattern-table' },
        h('thead', {}, h('tr', {}, ['Day', 'Start', 'Finish', 'Break at', 'Break (min)', 'Lunch at', 'Lunch (min)'].map((t) => h('th', { scope: 'col' }, t)))),
        h('tbody', {}, rows.map((r) => r.tr)))),
      h('div', {}, copyMon, h('span', { class: 'muted small' }, ' · Untick a day for a non-working day (e.g. part-time).')),
      error),
    actions,
  });
}
