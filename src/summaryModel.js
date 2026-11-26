// Weekly summary calculation (pure: no DOM, no database) — used by the planner, Today and the tests.
import { toISO, addDays } from './dates.js';
import { pumpQtys } from './jobs.js';

export const NONE = 'none'; // "Not specified" build type
export const ANY_ID = 'any'; // "Any / unknown" row (pumps not identified yet, "Any / mixed pump" notes)

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
    if ((!a.pump_model_id && !a.any_pump) || !task || !typeOk(a.build_type_id)) continue;
    if (a.work_date < from || a.work_date > friday) continue; // counted on its start day only
    if (a.part_of) continue; // a job continued on the next day: its quantity counts once, on part 1
    if (allTasks ? !task.requires_pump : !task.counts_as_output) continue;
    // mixed pumps count per model; pumps not identified yet go to the "Any / unknown" row
    for (const x of pumpQtys(a)) cell(x.pump_model_id || ANY_ID, a.build_type_id).planned += x.qty;
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
  // pumps not identified yet ("Any / unknown") and "Any / mixed pump" notes get their own row at the end.
  for (const m of [...models, { id: ANY_ID, name: 'Any / unknown', short_code: 'Any / unknown' }]) {
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

