import { h, mount, reportError, checkbox } from '../ui.js';
import { supabase } from '../supabase.js';
import { toISO, addDays, fmtDayShort } from '../dates.js';

// Weekly summary: planned units per pump model × build type vs open demand.
//
// Planned  = sum of quantity targets in the displayed week (Mon–Fri) for tasks
//            marked "counts as output" (normally Final assembly), or for all
//            pump tasks when the toggle is on. Background jobs follow the same
//            rule (they count only if their task counts as output). A job that
//            runs over several days is counted once, on the day it starts.
// Demand   = open + planned demand notes for that model/type that are due by
//            Friday of the displayed week (including overdue).
// Later    = open + planned notes due after that Friday or with no date
//            (shown for information; not part of the gap).
// Gap      = Planned − Demand.

const KEY = 'summaryPrefs';
let prefs = (() => {
  try { return { allTasks: false, type: '', ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return { allTasks: false, type: '' }; }
})();
const savePrefs = () => { try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* ignore */ } };

const NONE = 'none'; // "Not specified" build type

/** Loads the open demand needed for the summary. */
export async function loadSummaryDemand() {
  const { data, error } = await supabase.from('demand_notes')
    .select('pump_model_id, build_type_id, quantity, needed_by, status')
    .in('status', ['open', 'planned']);
  return { notes: data || [], error };
}

/** Pure calculation — returns rows grouped by model. Exported for testing. */
export function computeSummary({ monday, assignments, notes, tasks, models, types, allTasks, typeFilter }) {
  const from = toISO(monday);
  const friday = toISO(addDays(monday, 4));
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const counts = new Map(); // key model|type -> { planned, demand, later }
  const cell = (modelId, typeId) => {
    const k = `${modelId}|${typeId || NONE}`;
    if (!counts.has(k)) counts.set(k, { planned: 0, demand: 0, later: 0 });
    return counts.get(k);
  };
  const typeOk = (typeId) => !typeFilter || (typeFilter === NONE ? !typeId : typeId === typeFilter);

  for (const a of assignments) {
    const task = taskById.get(a.task_id);
    if (!a.pump_model_id || !task || !typeOk(a.build_type_id)) continue;
    if (a.work_date < from || a.work_date > friday) continue; // counted on its start day only
    if (allTasks ? !task.requires_pump : !task.counts_as_output) continue;
    cell(a.pump_model_id, a.build_type_id).planned += a.qty_target || 0;
  }
  let generalNotes = 0;
  for (const n of notes) {
    if (!n.pump_model_id) { generalNotes++; continue; }
    if (!typeOk(n.build_type_id)) continue;
    const c = cell(n.pump_model_id, n.build_type_id);
    if (n.needed_by && n.needed_by <= friday) c.demand += n.quantity || 0;
    else c.later += n.quantity || 0;
  }

  const typeOrder = new Map(types.map((t, i) => [t.id, i]));
  const groups = [];
  for (const m of models) {
    const lines = [...counts.entries()]
      .filter(([k]) => k.startsWith(`${m.id}|`))
      .map(([k, v]) => ({ typeId: k.split('|')[1], ...v }))
      .filter((l) => l.planned || l.demand || l.later)
      .sort((a, b) => (typeOrder.get(a.typeId) ?? 999) - (typeOrder.get(b.typeId) ?? 999));
    if (!lines.length) continue;
    const total = lines.reduce((t, l) => ({ planned: t.planned + l.planned, demand: t.demand + l.demand, later: t.later + l.later }),
      { planned: 0, demand: 0, later: 0 });
    groups.push({ model: m, lines, total });
  }
  const grand = groups.reduce((t, g) => ({
    planned: t.planned + g.total.planned, demand: t.demand + g.total.demand, later: t.later + g.total.later,
  }), { planned: 0, demand: 0, later: 0 });
  return { groups, grand, generalNotes, friday };
}

/** Summary card for the planner page. */
export function summaryCard({ monday, data, notes, weekLabel }) {
  const card = h('section', { class: 'card summary-card', id: 'weekly-summary' });
  const draw = () => {
    const outputTasks = data.tasks.filter((t) => t.counts_as_output).map((t) => t.name);
    const r = computeSummary({
      monday, assignments: data.assignments, notes,
      tasks: data.tasks, models: data.models, types: data.types,
      allTasks: prefs.allTasks, typeFilter: prefs.type,
    });

    const typeSel = h('select', {
      'aria-label': 'Filter by build type',
      onchange: (e) => { prefs.type = e.target.value; savePrefs(); draw(); },
    }, [['', 'All build types'], ...data.types.map((t) => [t.id, t.name]), [NONE, 'Not specified']].map(([v, l]) => {
      const o = h('option', { value: v }, l);
      if (v === prefs.type) o.selected = true;
      return o;
    }));
    const allToggle = checkbox('Count all pump tasks', prefs.allTasks, {
      onchange: (e) => { prefs.allTasks = e.target.checked; savePrefs(); draw(); },
    }).el;

    const typeCell = (typeId) => {
      const t = data.typeById.get(typeId);
      return t ? h('span', { class: 'type-tag', style: `--type-color:${t.color}` }, t.name) : h('span', { class: 'muted small' }, 'Not specified');
    };
    const num = (v) => h('td', { class: 'num' }, v ? String(v) : '–');
    const gap = (l) => {
      const g = l.planned - l.demand;
      if (!l.planned && !l.demand) return h('td', { class: 'num muted' }, '–');
      return h('td', { class: `num gap ${g < 0 ? 'gap-short' : 'gap-ok'}` }, g > 0 ? `+${g}` : String(g));
    };

    const body = r.groups.flatMap((g) => {
      const rows = g.lines.map((l, i) => h('tr', { class: i === 0 ? 'group-start' : '' },
        i === 0 ? h('th', { scope: 'rowgroup', rowspan: g.lines.length + (g.lines.length > 1 ? 1 : 0), class: 'model-cell' }, g.model.name) : null,
        h('td', {}, typeCell(l.typeId)),
        num(l.planned), num(l.demand), gap(l), num(l.later),
      ));
      if (g.lines.length > 1) {
        rows.push(h('tr', { class: 'subtotal' },
          h('td', { class: 'muted small' }, 'All types'),
          num(g.total.planned), num(g.total.demand), gap(g.total), num(g.total.later)));
      }
      return rows;
    });

    const plannedLabel = prefs.allTasks ? 'Planned (all pump tasks)' : `Planned (${outputTasks.join(', ') || 'no output task set'})`;
    mount(card,
      h('div', { class: 'card-head' },
        h('h2', {}, 'Weekly summary', weekLabel ? h('span', { class: 'print-only-inline' }, ` — ${weekLabel}`) : null),
        h('div', { class: 'summary-controls no-print' }, typeSel, allToggle),
      ),
      h('p', { class: 'muted small' },
        `Planned units this week vs open demand due by ${fmtDayShort(addDays(monday, 4))} (including overdue).`,
        prefs.type ? ` Filtered to ${prefs.type === NONE ? 'Not specified' : data.typeById.get(prefs.type)?.name} build type.` : ''),
      r.groups.length
        ? h('div', { class: 'table-scroll summary-scroll' },
            h('table', { class: 'summary' },
              h('thead', {}, h('tr', {},
                h('th', { scope: 'col' }, 'Pump model'),
                h('th', { scope: 'col' }, 'Build type'),
                h('th', { scope: 'col', class: 'num' }, plannedLabel),
                h('th', { scope: 'col', class: 'num' }, 'Demand due'),
                h('th', { scope: 'col', class: 'num' }, 'Gap'),
                h('th', { scope: 'col', class: 'num', title: 'Open demand due after this week or with no date' }, 'Later / no date'),
              )),
              h('tbody', {}, body),
              h('tfoot', {}, h('tr', {},
                h('th', { scope: 'row', colspan: 2 }, 'Total'),
                num(r.grand.planned), num(r.grand.demand), gap(r.grand), num(r.grand.later),
              )),
            ))
        : h('p', { class: 'empty' }, 'Nothing planned and no open demand for pump models this week.'),
      r.generalNotes
        ? h('p', { class: 'muted small summary-foot' }, `${r.generalNotes} open general note${r.generalNotes === 1 ? '' : 's'} without a pump model ${r.generalNotes === 1 ? 'is' : 'are'} not included.`)
        : null,
    );
  };
  draw();
  return card;
}

export async function summaryForWeek(monday, data) {
  const { notes, error } = await loadSummaryDemand();
  if (reportError(error, 'Loading demand for summary')) return null;
  return summaryCard({ monday, data, notes });
}
