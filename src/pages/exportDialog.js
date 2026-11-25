// "Export to Excel": choose a date range and people, then download an .xlsx.
import { h, toast, reportError, openModal, field, checkbox } from '../ui.js';
import { supabase } from '../supabase.js';
import { toISO, fromISO, addDays, mondayOf, today, fmtDate } from '../dates.js';
import { loadRange, makeCtx } from './planner.js';
import { exportRows } from '../exportData.js';
import { loadDemand } from './demand.js';

const MAX_DAYS = 186;

function presets(weekMonday) {
  const t = today();
  const mon = mondayOf(t);
  const first = new Date(t.getFullYear(), t.getMonth(), 1);
  const last = new Date(t.getFullYear(), t.getMonth() + 1, 0);
  const shown = weekMonday && toISO(weekMonday) !== toISO(mon) ? weekMonday : null;
  return [
    { key: 'this-week', label: 'This week', from: toISO(mon), to: toISO(addDays(mon, 4)) },
    { key: 'last-week', label: 'Last week', from: toISO(addDays(mon, -7)), to: toISO(addDays(mon, -3)) },
    shown ? { key: 'shown-week', label: 'Week shown in the planner', from: toISO(shown), to: toISO(addDays(shown, 4)) } : null,
    { key: 'this-month', label: 'This month', from: toISO(first), to: toISO(last) },
    { key: 'custom', label: 'Custom dates…' },
  ].filter(Boolean);
}

export async function openExport({ weekMonday = null } = {}) {
  const { data: people, error } = await supabase.from('people').select('id, name, active').order('name');
  if (reportError(error, 'Loading people')) return;
  const opts = presets(weekMonday);
  const rangeSel = h('select', {}, opts.map((o) => h('option', { value: o.key }, o.label + (o.from ? ` (${fmtDate(fromISO(o.from))} – ${fmtDate(fromISO(o.to))})` : ''))));
  rangeSel.value = weekMonday && opts.some((o) => o.key === 'shown-week') ? 'shown-week' : 'this-week';
  const from = h('input', { type: 'date', 'aria-label': 'From' });
  const to = h('input', { type: 'date', 'aria-label': 'To' });
  const customBox = h('div', { class: 'form-grid form-grid-2' }, field('From', from), field('To (inclusive)', to));
  const sync = () => {
    const o = opts.find((x) => x.key === rangeSel.value);
    customBox.hidden = o.key !== 'custom';
    if (o.from) { from.value = o.from; to.value = o.to; }
  };
  rangeSel.addEventListener('change', sync); sync();

  const everyone = checkbox('Everyone', true);
  const boxes = people.map((p) => ({ id: p.id, ...checkbox(p.active ? p.name : `${p.name} (inactive)`, false) }));
  const list = h('div', { class: 'export-people check-grid', hidden: true }, boxes.map((b) => b.el));
  everyone.input.addEventListener('change', () => { list.hidden = everyone.input.checked; });
  const status = h('p', { class: 'export-progress', 'aria-live': 'polite' });
  const err = h('p', { class: 'form-error', role: 'alert' });

  openModal({
    title: 'Export to Excel',
    body: h('div', { class: 'stack' },
      field('Dates', rangeSel), customBox,
      h('fieldset', { class: 'skills-fieldset' }, h('legend', {}, 'People'), everyone.el, list),
      h('p', { class: 'muted small' }, 'Sheets: Timesheet (jobs, free time, breaks — each person’s own hours; overnight jobs split by day), Absences, Summary by person, Summary by pump, Demand (with the jobs planned for it), Test capacity.'),
      status, err),
    actions: [{ label: 'Cancel' }, {
      label: 'Download .xlsx', variant: 'primary',
      onClick: async () => {
        err.textContent = '';
        if (!from.value || !to.value) { err.textContent = 'Choose the dates.'; return false; }
        if (to.value < from.value) { err.textContent = '"To" is before "From".'; return false; }
        if ((fromISO(to.value) - fromISO(from.value)) / 86400000 > MAX_DAYS) { err.textContent = 'Please export six months or less at a time.'; return false; }
        const personIds = everyone.input.checked ? [] : boxes.filter((b) => b.input.checked).map((b) => b.id);
        if (!everyone.input.checked && !personIds.length) { err.textContent = 'Tick at least one person.'; return false; }
        status.textContent = 'Preparing the spreadsheet…';
        try {
          const [data, demand, xlsx] = await Promise.all([loadRange(from.value, to.value), loadDemand(), import('../exportXlsx.js')]);
          if (data.error) throw data.error;
          const rows = exportRows(makeCtx(data), { from: from.value, to: to.value, personIds, demand: demand.error ? null : demand });
          const name = `Pump room plan ${from.value} to ${to.value}.xlsx`;
          const wb = await xlsx.buildWorkbook(rows, { from: from.value, to: to.value, title: `Pump room plan ${from.value} to ${to.value}` });
          await xlsx.downloadWorkbook(wb, name);
          toast(`Downloaded “${name}”.`, 'success');
          return true;
        } catch (e) {
          status.textContent = '';
          reportError(e, 'Exporting');
          return false;
        }
      },
    }],
  });
}
