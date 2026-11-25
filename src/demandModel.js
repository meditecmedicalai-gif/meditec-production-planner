// Demand notes ↔ jobs: planned quantity, automatic status, due-date words.
// Pure functions (no DOM, no database) — shared by the Demand page, the
// planner panel, Today, the weekly summary and the Excel export.
import { endDateOf } from './jobs.js';
import { toISO, fromISO, addDays } from './dates.js';

export const PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, low: 3 };

/** Sections on the Demand page, in order. */
export const SECTIONS = [
  { key: 'open', icon: '⚠', label: 'Needs planning' },
  { key: 'partly', icon: '', label: 'Partly planned' }, // half-circle drawn in CSS (.ico-partly)
  { key: 'planned', icon: '✓', label: 'Fully planned' },
  { key: 'done', icon: '', label: 'Done' },
];
export const STATUS_LABEL = { open: 'Needs planning', partly: 'Partly planned', planned: 'Fully planned', done: 'Done' };

/**
 * Production stages for a note: the pump model's stages in order (Settings → Pump models → Stages).
 * Without stages (or for Any / mixed): the tasks marked "counts as output" (normally Final assembly).
 * → [taskId, …]; the LAST one counts as planned / complete for the note.
 */
export function stagesFor(note, { stagesByModel, taskById }) {
  const own = !note.any_pump && note.pump_model_id ? stagesByModel?.get(note.pump_model_id) : null;
  if (own?.length) return own;
  return [...taskById.values()].filter((t) => t.counts_as_output).sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)).map((t) => t.id);
}

/**
 * State of one note.
 * Per stage: planned = linked jobs' quantities (a continued / multi-day job once) + "Planned (manual)";
 *            done    = linked jobs' "units done" + "+ Log completed" entries.
 * The note's planned / completed are the LAST stage's.
 * Status (override "done" wins, else automatic):
 *   done (completed ≥ needed) → planned (planned ≥ needed) → partly (anything planned at any stage) → open.
 *   tooLate = a linked job finishes after the needed-by date; overdue = past needed-by and not done.
 * opts: { taskById, todayISO, stagesByModel: Map(modelId → [taskId]), manual: [{demand_id, task_id, qty}],
 *         logs: [{demand_id, task_id, qty, work_date, note, created_by}] }
 */
export function demandState(note, links, { taskById, todayISO, stagesByModel = null, manual = [], logs = [] }) {
  const mine = links.filter((a) => a.demand_id === note.id);
  const roots = mine.filter((a) => !a.part_of);
  const stageIds = stagesFor(note, { stagesByModel, taskById });
  const last = stageIds.at(-1) ?? null;
  const myManual = manual.filter((m) => m.demand_id === note.id);
  const myLogs = logs.filter((l) => l.demand_id === note.id)
    .sort((a, b) => (b.work_date || '').localeCompare(a.work_date || '') || (b.created_at || '').localeCompare(a.created_at || ''));
  const stages = stageIds.map((tid) => {
    const plannedJobs = roots.filter((a) => a.task_id === tid).reduce((t, a) => t + (a.qty_target || 0), 0);
    const plannedManual = myManual.filter((m) => m.task_id === tid).reduce((t, m) => t + (m.qty || 0), 0);
    const doneJobs = mine.filter((a) => a.task_id === tid).reduce((t, a) => t + (a.qty_done || 0), 0);
    const doneLogged = myLogs.filter((l) => (l.task_id || last) === tid).reduce((t, l) => t + (l.qty || 0), 0);
    return { taskId: tid, name: taskById.get(tid)?.name || 'Stage', plannedJobs, plannedManual, planned: plannedJobs + plannedManual, doneJobs, doneLogged, done: doneJobs + doneLogged };
  });
  const lastStage = stages.at(-1) || { planned: 0, done: 0, plannedJobs: 0, plannedManual: 0, doneJobs: 0, doneLogged: 0 };
  const planned = lastStage.planned;
  const completed = lastStage.done;
  const needed = note.quantity ?? null;
  const anyPlanned = stages.some((x) => x.planned > 0);
  const lastFinish = mine.length ? mine.map(endDateOf).sort().at(-1) : null;
  let auto;
  if (needed != null && completed >= needed && needed > 0) auto = 'done';
  else if (needed != null ? planned >= needed && planned > 0 : planned > 0) auto = 'planned';
  else if (anyPlanned) auto = 'partly';
  else auto = 'open';
  const override = note.status_override === 'done' ? 'done' : null; // only "Done" can be set by hand now
  const status = override || auto;
  const stageOf = new Set(stageIds);
  return {
    stages, planned, completed, needed, lastStageName: lastStage.name || null,
    plannedJobs: lastStage.plannedJobs, plannedManual: lastStage.plannedManual,
    remaining: needed != null ? Math.max(0, needed - planned) : null,     // still to plan
    toDo: needed != null ? Math.max(0, needed - completed) : null,         // still to do
    status, auto, overridden: Boolean(override), lastFinish,
    overdue: Boolean(note.needed_by && note.needed_by < todayISO && status !== 'done'),
    tooLate: Boolean(note.needed_by && lastFinish && lastFinish > note.needed_by && status !== 'done'),
    jobs: roots.slice().sort((a, b) => (a.work_date < b.work_date ? -1 : a.work_date > b.work_date ? 1 : 0))
      .map((a) => Object.assign(a, { _stage: stageOf.has(a.task_id) ? taskById.get(a.task_id)?.name : null })),
    logs: myLogs,
  };
}

/** The first stage that still needs planning (for "Plan this"): { taskId, qty } or null. */
export function nextStageToPlan(state) {
  if (state.needed == null) return state.stages[0] ? { taskId: state.stages.at(-1).taskId, qty: null } : null;
  const s = state.stages.find((x) => x.planned < state.needed);
  return s ? { taskId: s.taskId, qty: state.needed - s.planned } : null;
}

/** The value kept in demand_notes.status for anything that still reads it. */
export const legacyStatus = (status) => (status === 'done' ? 'done' : status === 'planned' ? 'planned' : 'open');

/** "Overdue 2 days", "Due today", "Due tomorrow", "In 5 days" + urgency level. */
export function dueWords(neededBy, todayISO) {
  if (!neededBy) return { text: 'No date', level: 'none', days: null };
  const days = Math.round((fromISO(neededBy) - fromISO(todayISO)) / 86400000);
  if (days < 0) return { text: `Overdue ${-days} day${days === -1 ? '' : 's'}`, level: 'overdue', days };
  if (days === 0) return { text: 'Due today', level: 'today', days };
  if (days === 1) return { text: 'Due tomorrow', level: 'soon', days };
  if (days <= 7) return { text: `In ${days} days`, level: 'week', days };
  return { text: `In ${days} days`, level: 'later', days };
}

/** Overdue first (unless done), then by needed-by date (no date last), then priority, then newest. */
export function sortByUrgency(items, todayISO) {
  const overdue = (x) => (x.state.status !== 'done' && x.note.needed_by && x.note.needed_by < todayISO ? 0 : 1);
  return items.slice().sort((a, b) => overdue(a) - overdue(b)
    || (a.note.needed_by ?? '9999').localeCompare(b.note.needed_by ?? '9999')
    || (PRIORITY_RANK[a.note.priority] ?? 9) - (PRIORITY_RANK[b.note.priority] ?? 9)
    || (b.note.created_at || '').localeCompare(a.note.created_at || ''));
}

const isWorkday = (d) => d.getDay() !== 0 && d.getDay() !== 6;
/** Suggested day for "Plan this": the working day before it's needed (never in the past). */
export function suggestDate(neededBy, todayISO) {
  let t = fromISO(todayISO);
  while (!isWorkday(t)) t = addDays(t, 1);
  if (!neededBy) return toISO(t);
  let d = addDays(fromISO(neededBy), -1);
  while (!isWorkday(d)) d = addDays(d, -1);
  return toISO(d) < toISO(t) ? toISO(t) : toISO(d);
}

/** Notes a job for this pump can cover (not done; same model, or Any / mixed). */
export function coverableNotes(items, { pumpModelId, anyPump }) {
  return items.filter((x) => x.state.status !== 'done'
    && (anyPump ? x.note.any_pump : x.note.pump_model_id && x.note.pump_model_id === pumpModelId));
}
