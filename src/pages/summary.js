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

import { computeSummary, ANY_ID, NONE } from '../summaryModel.js';
export { computeSummary, ANY_ID };

/** Notes for the summary: not done, with their linked planned quantity. */
export const summaryNotes = (demand) => (demand?.items || []).filter((x) => x.state.status !== 'done')
  .map((x) => ({ ...x.note, linked: x.state.planned, remaining: x.state.remaining, completed: x.state.completed, toDo: x.state.toDo,
    stages: (x.state.stages || []).map((st) => ({ taskId: st.taskId, name: st.name, planned: st.planned, done: st.done })) }));

/** Loads the open demand (with linked jobs) for the summary. */
export async function loadSummaryDemand() {
  const demand = await loadDemand();
  return { notes: summaryNotes(demand), demand, error: demand.error };
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
