// A job over several working days is ONE job (a "series"): part 1 (the head) plus
// parts 2, 3 … that point at it (assignments.part_of). The job's TOTAL work time is
// stored once, on part 1 (assignments.work_minutes); each part only has its own
// times. Every change re-flows the parts from the job's first start using the
// person's hours, re-using the existing rows in date order — so a job never gets
// more parts than it needs and never two parts on the same day.
//
// Pure functions (no DOM, no Supabase) — see tests/unit/series.test.mjs.
//   part:    { date: 'YYYY-MM-DD', start, end, locked? }   (minutes from midnight)
//   dayInfo: (iso) → { ws, we, breaks: [{ s, e }] } | null   (null = not working / absent)
import { addWork, workBetween, breakMinutes } from './timing.js';
import { toISO, fromISO, addDays } from './dates.js';

const pad = (n) => String(n).padStart(2, '0');
export const fmt = (m) => `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`;
const toMin = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + (m || 0); };
export const daysBetween = (a, b) => Math.round((fromISO(b) - fromISO(a)) / 86400000);
const shift = (iso, n) => toISO(addDays(fromISO(iso), n));

/** Work minutes in one part (less the breaks it pauses for). */
export function partWork(p, dayInfo, pause = true) {
  const info = dayInfo?.(p.date);
  return workBetween(p.start, p.end, pause && info ? info.breaks : [], pause);
}
export const sumWork = (parts, dayInfo, pause = true) => parts.reduce((t, p) => t + partWork(p, dayInfo, pause), 0);

/**
 * Lay `total` work minutes out from `date` at `start`, one part per working day.
 * `fixed` parts (locked by hand) are kept exactly as they are and count towards the
 * total; the rest of the work flows around them. The first day uses `start` (if it is
 * a working day); later days start at the person's start. → [{ date, start, end, work, paused, locked }]
 */
export function planSeries({ date, start = null, total, pause = true, dayInfo, fixed = [], maxDays = 90 }) {
  const fixedBy = new Map(fixed.map((p) => [p.date, p]));
  const parts = [];
  let left = Math.max(0, total);
  let first = true;
  for (let i = 0, iso = date; i < maxDays; i++, iso = shift(iso, 1)) {
    if (left <= 0 && !fixedBy.size) break;
    const info = dayInfo(iso);
    const brk = pause && info ? info.breaks : [];
    if (fixedBy.has(iso)) {
      const p = fixedBy.get(iso); fixedBy.delete(iso);
      const work = workBetween(p.start, p.end, brk, pause);
      parts.push({ date: iso, start: p.start, end: p.end, work, paused: p.end - p.start - work, locked: true });
      left -= work; first = false;
      continue;
    }
    if (left <= 0 || !info) continue;
    const s = first && start != null && iso === date ? start : info.ws;
    first = false;
    if (s >= info.we) continue;
    const { end, paused } = addWork(s, left, brk);
    if (end <= info.we) { parts.push({ date: iso, start: s, end, work: left, paused, locked: false }); left = 0; continue; }
    const work = workBetween(s, info.we, brk, pause);
    if (work <= 0) continue;
    parts.push({ date: iso, start: s, end: info.we, work, paused: breakMinutes(s, info.we, brk), locked: false });
    left -= work;
  }
  for (const p of fixedBy.values()) parts.push({ ...p, work: p.end - p.start, paused: 0, locked: true }); // (beyond maxDays)
  return parts.sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** A one-day job that runs past the finish, kept as overtime: a single part. */
export const overtimePart = ({ date, start, total, pause = true, dayInfo }) => {
  const info = dayInfo(date);
  const { end, paused } = addWork(start, total, pause && info ? info.breaks : []);
  return [{ date, start, end, work: total, paused, locked: false }];
};

/** Does the job (date, start, total) run past the person's finish that day? */
export function runsPastFinish({ date, start, total, pause = true, dayInfo }) {
  const info = dayInfo(date);
  if (!info || start == null || total == null) return false;
  return addWork(start, total, pause ? info.breaks : []).end > info.we;
}

/** Rows of one job (head + parts, any order) → parts sorted by date with minutes. */
export function partsOf(rows) {
  return [...rows].sort((a, b) => (a.work_date < b.work_date ? -1 : a.work_date > b.work_date ? 1 : (a.part_of ? 1 : 0) - (b.part_of ? 1 : 0)))
    .map((r) => {
      const s = r.start_time != null ? toMin(r.start_time) : null;
      let e = r.end_time != null ? toMin(r.end_time) : null;
      if (s != null && e != null && e <= s) e += 24 * 60;
      return { id: r.id, date: r.work_date, start: s, end: e, locked: Boolean(r.part_locked) };
    });
}

/** The job's total work time: stored on part 1, else the sum of its parts. */
export function totalOf(rows, dayInfo, pause = true) {
  const head = rows.find((r) => !r.part_of) || rows[0];
  if (head?.work_minutes != null) return head.work_minutes;
  return sumWork(partsOf(rows).filter((p) => p.start != null && p.end != null), dayInfo, pause);
}

// ------------------------------------------------------------------ changes to a whole job
/** New start and/or total (the job form): re-flow from the (new) first start. Locks are
 *  kept only while the start date stays the same. */
export function editJob({ current = [], date, start, total, pause = true, dayInfo, keepLocks = true }) {
  const sameStart = current[0] && current[0].date === date;
  const fixed = keepLocks && sameStart ? current.slice(1).filter((p) => p.locked) : [];
  return planSeries({ date, start, total, pause, dayInfo, fixed });
}

/** Move the whole job so that part `index` lands on `toDate` (drag-and-drop, date of any
 *  part, copy to another week). All parts shift together and re-flow from the new start. */
export function moveJob({ current, index = 0, toDate, total, pause = true, dayInfo }) {
  const delta = daysBetween(current[index].date, toDate);
  return planSeries({ date: shift(current[0].date, delta), start: current[0].start, total, pause, dayInfo });
}

/**
 * "Adjust this part only": part `index` gets new times (and is locked). Earlier parts stay
 * as they are. mode 'reflow': the following parts re-flow to keep the total;
 * mode 'lock': the following parts keep their times and the total becomes the new sum.
 * → { parts, total }
 */
export function adjustPart({ current, index, start, end, mode = 'reflow', total, pause = true, dayInfo }) {
  const before = current.slice(0, index).map((p) => ({ ...p, locked: true }));
  const me = { ...current[index], start, end, locked: true };
  const after = current.slice(index + 1).map((p) => ({ ...p, locked: true }));
  const fixed = mode === 'lock' ? [...before, me, ...after] : [...before, me];
  const t = mode === 'lock' ? sumWork(fixed, dayInfo, pause) : total;
  const parts = planSeries({ date: current[0].date, start: current[0].start, total: t, pause, dayInfo, fixed });
  // the earlier parts were only fixed to keep them in place: they are not "set by hand"
  const was = (iso) => Boolean(current.find((c) => c.date === iso && c.locked));
  for (const p of parts) {
    p.locked = p.date === me.date || (mode === 'lock' && after.some((a) => a.date === p.date))
      || (before.some((b) => b.date === p.date) && was(p.date));
  }
  return { parts, total: t };
}

/** Remove one part ("This part only"): the rest stay where they are; the total shrinks. */
export function removePart({ current, index, pause = true, dayInfo }) {
  const parts = current.filter((_, i) => i !== index);
  return { parts, total: sumWork(parts, dayInfo, pause) };
}

// ------------------------------------------------------------------ rows to save
/**
 * Turn planned parts into the rows to save, re-using the existing rows in date order
 * (update), adding only what is missing (insert) and removing the rest (delete).
 * `values` are the fields shared by every part. Part 1 carries the total work time,
 * units done and the demand link counts once (on part 1).
 * → { rows: [{ id?, ...fields }], remove: [ids] }   rows[0] is part 1.
 */
export function diffParts(existing, parts, values, { total = null } = {}) {
  const old = [...existing];
  const rows = parts.map((p, i) => {
    const row = {
      ...values,
      work_date: p.date, end_date: null,
      start_time: p.start != null ? fmt(p.start) : values.start_time ?? null,
      end_time: p.end != null ? fmt(p.end) : values.end_time ?? null,
      part_locked: Boolean(p.locked),
      work_minutes: i === 0 && parts.length > 1 ? total : null,
    };
    // units done count once, on part 1 (only sent when known, so it is never wiped by accident)
    if (i > 0) row.qty_done = null;
    else if ('qty_done' in values) row.qty_done = values.qty_done ?? null;
    else delete row.qty_done;
    if (old[i]?.id) row.id = old[i].id;
    return row;
  });
  return { rows, remove: old.slice(parts.length).map((p) => p.id).filter(Boolean) };
}

/** Problems with a set of parts (used by the tests and as a last check before saving). */
export function checkParts(parts, { dayInfo, total, pause = true } = {}) {
  const problems = [];
  const days = new Set();
  for (const p of parts) {
    if (days.has(p.date)) problems.push(`two parts on ${p.date}`);
    days.add(p.date);
    if (p.end <= p.start) problems.push(`empty part on ${p.date}`);
    if (dayInfo && !p.locked && !dayInfo(p.date)) problems.push(`part on a non-working day ${p.date}`);
  }
  if (dayInfo && total != null && parts.length > 1) {
    const sum = sumWork(parts, dayInfo, pause);
    if (sum !== total && !parts.some((p) => p.locked)) problems.push(`work ${sum} ≠ total ${total}`);
    // more parts than needed: the work would fit without the last part
    if (sum - partWork(parts.at(-1), dayInfo, pause) >= total && !parts.at(-1).locked) problems.push('more parts than needed');
  }
  return problems;
}

/** "Tue 15:30–16:30 → Wed 08:30–09:45" */
export function partsText(parts, dayName) {
  return parts.map((p) => `${dayName(p.date)} ${fmt(p.start)}–${fmt(p.end)}`).join(' → ');
}
