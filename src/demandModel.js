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
 * State of one note from the jobs linked to it.
 *   planned  = sum of the linked jobs' quantities, for tasks that count as output (e.g. Final assembly);
 *              a job continued on the next day / over several days is counted once (its part 1).
 *   status   = override, else automatic:
 *              open (nothing planned) → partly (planned < needed) → planned (planned ≥ needed)
 *              → done (fully planned and every linked job's last day has passed).
 *   tooLate  = a linked job finishes after the needed-by date.
 */
export function demandState(note, links, { taskById, todayISO }) {
  const mine = links.filter((a) => a.demand_id === note.id);
  const roots = mine.filter((a) => !a.part_of);
  const counts = (a) => Boolean(taskById.get(a.task_id)?.counts_as_output);
  const planned = roots.filter(counts).reduce((t, a) => t + (a.qty_target || 0), 0);
  const needed = note.quantity ?? null;
  const lastFinish = mine.length ? mine.map(endDateOf).sort().at(-1) : null;
  const allPassed = mine.length > 0 && mine.every((a) => endDateOf(a) < todayISO);
  let auto;
  if (!planned) auto = 'open';
  else if (needed != null && planned < needed) auto = 'partly';
  else auto = allPassed ? 'done' : 'planned';
  const override = note.status_override || null;
  const status = override || auto;
  return {
    planned, needed, remaining: needed != null ? Math.max(0, needed - planned) : null,
    status, auto, overridden: Boolean(override), lastFinish,
    tooLate: Boolean(note.needed_by && lastFinish && lastFinish > note.needed_by && status !== 'done'),
    jobs: roots.slice().sort((a, b) => (a.work_date < b.work_date ? -1 : a.work_date > b.work_date ? 1 : 0)),
  };
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
