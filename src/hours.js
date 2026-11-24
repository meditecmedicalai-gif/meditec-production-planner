// Each person's working hours on a given day.
//
//   one-off change for that day (person_day_hours)
//     → the person's pattern in force on that date (person_work_patterns,
//       latest "effective from" on or before the day) + their overrides
//       → the default pattern ("Standard")
//         → Settings working hours (before migration 008), Mon–Fri
//
// Mirrors public.person_works() in migration 008.
import { fromISO } from './dates.js';
import { DEFAULT_HOURS, toMin, fmtMin } from './daytime.js';

export const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const FIELDS = ['start_time', 'end_time', 'break_time', 'break_minutes', 'lunch_time', 'lunch_minutes'];
export const isoDow = (iso) => ((fromISO(iso).getDay() + 6) % 7) + 1; // 1 = Monday

/** Pattern day row → hours object used by daytime.js. */
function fromDay(d) {
  return {
    works: Boolean(d.works),
    work_start: d.start_time, work_end: d.end_time,
    break_time: d.break_time || '00:00', break_minutes: d.break_minutes || 0,
    lunch_time: d.lunch_time || '00:00', lunch_minutes: d.lunch_minutes || 0,
  };
}
const set = (v) => v !== null && v !== undefined && v !== '';
function applyOverrides(h, o) {
  const out = { ...h };
  if (set(o.start_time)) out.work_start = o.start_time;
  if (set(o.end_time)) out.work_end = o.end_time;
  if (set(o.break_time)) out.break_time = o.break_time;
  if (set(o.break_minutes)) out.break_minutes = o.break_minutes;
  if (set(o.lunch_time)) out.lunch_time = o.lunch_time;
  if (set(o.lunch_minutes)) out.lunch_minutes = o.lunch_minutes;
  return out;
}
export const hasOverrides = (o) => FIELDS.some((f) => set(o?.[f]));

/**
 * rows: { patterns, patternDays, personPatterns, dayHours, settings }
 * Returns { forDay(personId, iso), defaultFor(iso), patternOf(personId, iso), patternById }
 */
export function makeHours({ patterns = [], patternDays = [], personPatterns = [], dayHours = [], settings = null } = {}) {
  const patternById = new Map(patterns.map((p) => [p.id, p]));
  const days = new Map(patternDays.map((d) => [`${d.pattern_id}|${d.weekday}`, d]));
  const defaultPattern = patterns.find((p) => p.is_default) || null;
  const legacy = { ...DEFAULT_HOURS, ...(settings || {}) };
  const byPerson = new Map();
  for (const pp of [...personPatterns].sort((a, b) => (a.effective_from < b.effective_from ? -1 : 1))) {
    if (!byPerson.has(pp.person_id)) byPerson.set(pp.person_id, []);
    byPerson.get(pp.person_id).push(pp);
  }
  const oneOff = new Map(dayHours.map((d) => [`${d.person_id}|${d.work_date}`, d]));
  const cache = new Map();

  const patternHours = (patternId, iso) => {
    const d = days.get(`${patternId}|${isoDow(iso)}`);
    return d ? fromDay(d) : null;
  };
  const defaultFor = (iso) => {
    const fromPattern = defaultPattern && patternHours(defaultPattern.id, iso);
    if (fromPattern) return { ...fromPattern, pattern: defaultPattern };
    return { ...legacy, works: isoDow(iso) <= 5, pattern: null };
  };
  /** The person's pattern assignment in force on a date, or null (= default). */
  const assignmentOn = (personId, iso) => {
    const list = byPerson.get(personId) || [];
    let found = null;
    for (const pp of list) if (pp.effective_from <= iso) found = pp;
    return found;
  };

  /** Hours from the pattern (+ overrides), before any one-off change. */
  const baseFor = (personId, iso) => {
    const asg = assignmentOn(personId, iso);
    let h = null;
    if (asg) {
      const ph = patternHours(asg.pattern_id, iso);
      if (ph) h = { ...applyOverrides(ph, asg), pattern: patternById.get(asg.pattern_id) || null, assignment: asg, override: hasOverrides(asg) };
    }
    if (!h) h = { ...defaultFor(iso), assignment: null, override: false };
    return h;
  };
  const forDay = (personId, iso) => {
    const key = `${personId}|${iso}`;
    if (cache.has(key)) return cache.get(key);
    let h = baseFor(personId, iso);
    const one = oneOff.get(key);
    if (one) {
      h = { ...applyOverrides(h, one), works: one.works, oneOff: one };
      if (one.works && (!h.work_start || !h.work_end)) Object.assign(h, { work_start: legacy.work_start, work_end: legacy.work_end });
    }
    cache.set(key, h);
    return h;
  };

  return { forDay, baseFor, defaultFor, assignmentOn, patternById, defaultPattern, oneOff: (personId, iso) => oneOff.get(`${personId}|${iso}`) || null };
}

/** "08:30–16:30" */
export const hoursText = (h) => (h?.works ? `${fmtMin(toMin(h.work_start))}–${fmtMin(toMin(h.work_end))}` : 'Not working');
/** "08:30–16:30 · break 10:30 (15m) · lunch 12:30 (30m)" */
export function hoursLong(h) {
  if (!h?.works) return 'Not working';
  const parts = [hoursText(h)];
  if (h.break_minutes > 0) parts.push(`break ${fmtMin(toMin(h.break_time))} (${h.break_minutes}m)`);
  if (h.lunch_minutes > 0) parts.push(`lunch ${fmtMin(toMin(h.lunch_time))} (${h.lunch_minutes}m)`);
  return parts.join(' · ');
}
/** Short description of a one-off change: "Leaving 14:00", "Lunch 13:30", "Day off". */
export function oneOffText(one) {
  if (!one) return null;
  if (!one.works) return 'Not working (one-off)';
  const bits = [];
  if (set(one.start_time)) bits.push(`Starting ${fmtMin(toMin(one.start_time))}`);
  if (set(one.end_time)) bits.push(`Leaving ${fmtMin(toMin(one.end_time))}`);
  if (set(one.lunch_time)) bits.push(`Lunch ${fmtMin(toMin(one.lunch_time))}`);
  if (set(one.break_time)) bits.push(`Break ${fmtMin(toMin(one.break_time))}`);
  if (!bits.length && (set(one.lunch_minutes) || set(one.break_minutes))) bits.push('Breaks changed');
  return bits.join(' · ') || 'Hours changed';
}

/** "Mon–Thu 08:30–16:30 · Fri 08:30–13:00 · Sat–Sun off" */
export function patternSummary(days) {
  const short = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const byDow = new Map(days.map((d) => [d.weekday, d]));
  const key = (d) => (!d || !d.works ? 'off'
    : `${fmtMin(toMin(d.start_time))}–${fmtMin(toMin(d.end_time))}`
      + (d.break_minutes ? ` · break ${fmtMin(toMin(d.break_time))}` : '') + (d.lunch_minutes ? ` · lunch ${fmtMin(toMin(d.lunch_time))}` : ''));
  const groups = [];
  for (let w = 1; w <= 7; w++) {
    const k = key(byDow.get(w));
    const last = groups.at(-1);
    if (last && last.k === k) last.to = w; else groups.push({ k, from: w, to: w });
  }
  return groups.map((g) => `${short[g.from - 1]}${g.to > g.from ? `–${short[g.to - 1]}` : ''} ${g.k === 'off' ? 'off' : g.k}`).join('  ·  ');
}
