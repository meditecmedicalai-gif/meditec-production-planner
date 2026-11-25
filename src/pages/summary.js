import { h, mount, reportError, checkbox } from '../ui.js';
import { supabase } from '../supabase.js';
import { toISO, addDays, fmtDayShort } from '../dates.js';
import { loadDemand } from './demand.js';

// Weekly summary: planned units per pump model × build type vs open demand.
//
// Planned  = sum of quantity targets in the displayed week (Mon–Fri) for tasks
//            marked "counts as output" (normally Final assembly), or for all
//            pump tasks when the toggle is on. Background jobs follow the same
//            rule (they count only if their task counts as output). A job that
//            runs over several days is counted once, on the day it starts.
// Demand   = quantity needed on demand notes (not done) for that model/type
//            that are due by Friday of the displayed week (including overdue).
// Linked   = of that demand, the quantity already planned in jobs linked to
//            the notes ("Covers demand" / "Plan this"), in any week.
// To plan  = Demand − Linked, per note (never below 0) — what still needs planning.
// Done     = units completed at the LAST stage of the notes due ("Units done" on
//            linked jobs + "+ Log completed").
// Still to do = Demand − Done, per note.
// Later    = still to plan on notes due after that Friday or with no date.
// Stages   = per model, planned / done at each production stage for the notes due.
//
// "Planned (output task)" counts jobs of tasks marked "Counts as output" this
// week, linked or not — it is the week's build volume. The demand columns use
// each pump model's stages (the last stage), falling back to "Counts as output"
// for models without stages and for Any / mixed notes.

const KEY = 'summaryPrefs';
let prefs = (() => {
  try { return { allTasks: false, type: '', ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return { allTasks: false, type: '' }; }
})();
const savePrefs = () => { try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* ignore */ } };

const NONE = 'none'; // "Not specified" build type
export const ANY_ID = 'any'; // "Any / mixed pump" row

/** Notes for the summary: not done, with their linked planned quantity. */
export const summaryNotes = (demand) => (demand?.items || []).filter((x) => x.state.status !== 'done')
  .map((x) => ({ ...x.note, linked: x.state.planned, remaining: x.state.remaining, completed: x.state.completed, toDo: x.state.toDo,
    stages: (x.state.stages || []).map((st) => ({ taskId: st.taskId, name: st.name, planned: st.planned, done: st.done })) }));

/** Loads the open demand (with linked jobs) for the summary. */
export async function loadSummaryDemand() {
  const demand = await loadDemand();
  return { notes: summaryNotes(demand), demand, error: demand.error };
}

const FIELDS = ['planned', 'demand', 'linked', 'toPlan', 'later', 'done', 'toDo'];
const sumLines = (lines) => Object.fromEntries(FIELDS.map((f) => [f, lines.reduce((t, l) => t + (l[f] || 0), 0)]));

/** Pure calculation — returns rows grouped by model. Exported for testing. */
export function computeSummary({ monday, assignments, notes, tasks, models, types, allTasks, typeFilter }) {
  const from = toISO(monday);
  const friday = toISO(addDays(monday, 4));
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const counts = new Map(); // key model|type -> { planned, demand, later }
  const cell = (modelId, typeId) => {
    const k = `${modelId}|${typeId || NONE}`;
    if (!counts.has(k)) counts.set(k, { planned: 0, demand: 0, linked: 0, toPlan: 0, later: 0, done: 0, toDo: 0 });
    return counts.get(k);
  };
  const typeOk = (typeId) => !typeFilter || (typeFilter === NONE ? !typeId : typeId === typeFilter);

  for (const a of assignments) {
    const task = taskById.get(a.task_id);
    const modelKey = a.any_pump ? ANY_ID : a.pump_model_id;
    if (!modelKey || !task || !typeOk(a.build_type_id)) continue;
    if (a.work_date < from || a.work_date > friday) continue; // counted on its start day only
    if (a.part_of) continue; // a job continued on the next day: its quantity counts once, on part 1
    if (allTasks ? !task.requires_pump : !task.counts_as_output) continue;
    cell(modelKey, a.build_type_id).planned += a.qty_target || 0;
  }
  let generalNotes = 0;
  const stagesByModel = new Map(); // model → Map(stage name → { name, planned, done, needed })
  for (const n of notes) {
    const noteKey = n.any_pump ? ANY_ID : n.pump_model_id;
    if (!noteKey) { generalNotes++; continue; }
    if (!typeOk(n.build_type_id)) continue;
    const c = cell(noteKey, n.build_type_id);
    const need = n.quantity || 0;
    const linked = Math.min(n.linked || 0, need);
    const rest = n.remaining != null ? n.remaining : Math.max(0, need - linked);
    if (n.needed_by && n.needed_by <= friday) {
      c.demand += need; c.linked += linked; c.toPlan += rest;
      c.done += Math.min(n.completed || 0, need);
      c.toDo += n.toDo != null ? n.toDo : Math.max(0, need - (n.completed || 0));
      if (!stagesByModel.has(noteKey)) stagesByModel.set(noteKey, new Map());
      const sm = stagesByModel.get(noteKey);
      for (const st of n.stages || []) {
        if (!sm.has(st.name)) sm.set(st.name, { name: st.name, planned: 0, done: 0, needed: 0 });
        const x = sm.get(st.name);
        x.planned += Math.min(st.planned || 0, need); x.done += Math.min(st.done || 0, need); x.needed += need;
      }
    } else c.later += rest;
  }

  const typeOrder = new Map(types.map((t, i) => [t.id, i]));
  const groups = [];
  // "Any / mixed pump" jobs and notes get their own row at the end.
  for (const m of [...models, { id: ANY_ID, name: 'Any / mixed', short_code: 'Any / mixed' }]) {
    const lines = [...counts.entries()]
      .filter(([k]) => k.startsWith(`${m.id}|`))
      .map(([k, v]) => ({ typeId: k.split('|')[1], ...v }))
      .filter((l) => l.planned || l.demand || l.later || l.linked || l.done)
      .sort((a, b) => (typeOrder.get(a.typeId) ?? 999) - (typeOrder.get(b.typeId) ?? 999));
    if (!lines.length) continue;
    const total = sumLines(lines);
    // a stage row only adds something when there is more than one stage
    const stageList = [...(stagesByModel.get(m.id)?.values() || [])];
    const stages = stageList.length > 1 ? stageList : [];
    groups.push({ model: m, lines, total, stages });
  }
  const grand = sumLines(groups.map((g) => g.total));
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
    const todo = (l) => {
      if (!l.demand) return h('td', { class: 'num muted' }, '–');
      return h('td', { class: `num ${l.toDo > 0 ? '' : 'gap-ok'}` }, l.toDo > 0 ? String(l.toDo) : '✓ 0');
    };
    const gap = (l) => {
      if (!l.demand) return h('td', { class: 'num muted' }, '–');
      return h('td', { class: `num gap ${l.toPlan > 0 ? 'gap-short' : 'gap-ok'}` }, l.toPlan > 0 ? String(l.toPlan) : '✓ 0');
    };

    const body = r.groups.flatMap((g) => {
      const rows = g.lines.map((l, i) => h('tr', { class: i === 0 ? 'group-start' : '' },
        i === 0 ? h('th', { scope: 'rowgroup', rowspan: g.lines.length + (g.lines.length > 1 ? 1 : 0) + (g.stages.length ? 1 : 0), class: 'model-cell' }, g.model.name) : null,
        h('td', {}, typeCell(l.typeId)),
        num(l.planned), num(l.demand), num(l.linked), gap(l), num(l.done), todo(l), num(l.later),
      ));
      if (g.lines.length > 1) {
        rows.push(h('tr', { class: 'subtotal' },
          h('td', { class: 'muted small' }, 'All types'),
          num(g.total.planned), num(g.total.demand), num(g.total.linked), gap(g.total), num(g.total.done), todo(g.total), num(g.total.later)));
      }
      if (g.stages.length) {
        rows.push(h('tr', { class: 'stage-row' },
          h('td', { colspan: 8, class: 'small' },
            h('span', { class: 'muted' }, 'Stages (demand due): '),
            g.stages.map((st, i) => h('span', { class: 'sum-stage' }, i ? ' → ' : '',
              h('b', {}, st.name), ` ${st.planned}/${st.needed} planned · `, h('span', { class: 'st-done' }, `${st.done} done`))))));
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
        `Planned units this week, and demand due by ${fmtDayShort(addDays(monday, 4))} (including overdue) with how much of it is planned and done (at each pump model's last stage).`,
        prefs.type ? ` Filtered to ${prefs.type === NONE ? 'Not specified' : data.typeById.get(prefs.type)?.name} build type.` : ''),
      r.groups.length
        ? h('div', { class: 'table-scroll summary-scroll' },
            h('table', { class: 'summary' },
              h('thead', {}, h('tr', {},
                h('th', { scope: 'col' }, 'Pump model'),
                h('th', { scope: 'col' }, 'Build type'),
                h('th', { scope: 'col', class: 'num' }, plannedLabel),
                h('th', { scope: 'col', class: 'num' }, 'Demand due'),
                h('th', { scope: 'col', class: 'num', title: 'Quantity planned in jobs linked to these notes (any week)' }, 'Planned for it'),
                h('th', { scope: 'col', class: 'num', title: 'Demand due − planned for it' }, 'Still to plan'),
                h('th', { scope: 'col', class: 'num', title: 'Units completed at the last stage (units done on jobs + logged)' }, 'Done'),
                h('th', { scope: 'col', class: 'num', title: 'Demand due − done' }, 'Still to do'),
                h('th', { scope: 'col', class: 'num', title: 'Still to plan on notes due after this week or with no date' }, 'Later / no date'),
              )),
              h('tbody', {}, body),
              h('tfoot', {}, h('tr', {},
                h('th', { scope: 'row', colspan: 2 }, 'Total'),
                num(r.grand.planned), num(r.grand.demand), num(r.grand.linked), gap(r.grand), num(r.grand.done), todo(r.grand), num(r.grand.later),
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
