// Recurring jobs: pattern rules shared with the database generator
// (public.recurring_matches in migration 005 — keep the two in step).
import { fromISO, addDays, toISO, mondayOf, fmtDate } from './dates.js';

export const PATTERNS = {
  workdays: 'Every working day (Mon–Fri)',
  daily: 'Every day (incl. weekends)',
  weekly: 'Weekly on chosen days',
  every_n_weeks: 'Every N weeks on chosen days',
};
const DAY = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** ISO weekday 1 (Mon) … 7 (Sun). */
export const isoDow = (iso) => ((fromISO(iso).getDay() + 6) % 7) + 1;

/** Does template `r` fall on date `iso`? */
export function matches(r, iso) {
  if (iso < r.start_date || (r.end_date && iso > r.end_date)) return false;
  const dow = isoDow(iso);
  if (r.pattern === 'daily') return true;
  if (r.pattern === 'workdays') return dow <= 5;
  if (!(r.weekdays || []).includes(dow)) return false;
  const weeks = Math.round((fromISO(iso) - mondayOf(fromISO(r.start_date))) / (7 * 86400000));
  return Math.floor(weeks) % Math.max(r.interval_weeks || 1, 1) === 0;
}

/** "Every working day", "Weekly on Mon, Wed", "Every 2 weeks on Fri", plus the end. */
export function describe(r) {
  let s;
  if (r.pattern === 'workdays') s = 'Every working day';
  else if (r.pattern === 'daily') s = 'Every day';
  else {
    const days = (r.weekdays || []).slice().sort().map((d) => DAY[d]).join(', ') || '—';
    s = r.pattern === 'every_n_weeks' && (r.interval_weeks || 1) > 1 ? `Every ${r.interval_weeks} weeks on ${days}` : `Weekly on ${days}`;
  }
  return `${s} · from ${fmtDate(fromISO(r.start_date))}${r.end_date ? ` until ${fmtDate(fromISO(r.end_date))}` : ' · no end'}`;
}

/** Dates in [fromIso, toIso] the template falls on. */
export function occurrences(r, fromIso, toIso) {
  const out = [];
  for (let d = fromISO(fromIso); toISO(d) <= toIso; d = addDays(d, 1)) {
    const iso = toISO(d);
    if (matches(r, iso)) out.push(iso);
  }
  return out;
}

/** Fields copied between a template and its jobs. */
export const JOB_FIELDS = ['person_id', 'task_id', 'pump_model_id', 'any_pump', 'build_type_id', 'qty_target', 'notes',
  'start_time', 'end_time', 'background', 'equipment_id'];
export const pick = (obj, keys = JOB_FIELDS) => Object.fromEntries(keys.filter((k) => k in obj).map((k) => [k, obj[k]]));
