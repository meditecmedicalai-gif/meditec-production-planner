// Job timing against a person's working hours:
//   * pausing for breaks (work time → end time, and back);
//   * splitting work that runs past the finish onto the next working days;
//   * attended multi-day jobs only take working hours each day (not nights).
// Minutes are from midnight of the day concerned.
import { intervalOf, hm } from './jobs.js';
import { placeOn, workDay, toMin } from './daytime.js';
import { toISO, fromISO, addDays } from './dates.js';

const sorted = (breaks) => [...(breaks || [])].sort((a, b) => a.s - b.s);

/** End time for `work` minutes starting at `start`, pausing for breaks. → { end, paused } */
export function addWork(start, work, breaks) {
  let t = start; let left = Math.max(0, work); let paused = 0;
  for (const b of sorted(breaks)) {
    if (b.e <= t) continue;
    if (b.s >= t + left) break;
    if (b.s > t) { left -= b.s - t; t = b.s; }
    paused += b.e - t; t = b.e;
  }
  return { end: t + left, paused };
}

/** Minutes of break inside [s, e). */
export function breakMinutes(s, e, breaks) {
  return sorted(breaks).reduce((t, b) => t + Math.max(0, Math.min(e, b.e) - Math.max(s, b.s)), 0);
}

/** Work minutes in [s, e), less breaks when pausing. */
export const workBetween = (s, e, breaks, pause = true) => Math.max(0, e - s - (pause ? breakMinutes(s, e, breaks) : 0));

export const isMultiDay = (job) => Boolean(job.end_date && job.end_date > job.work_date);
export const pauses = (job, bg) => !bg && job.pause_for_breaks !== false;

/**
 * Where a job sits on day `iso` ({ s, e } minutes, or null if not that day).
 * Attended multi-day jobs only count the person's working hours each day (not
 * overnight), and skip non-working days and absences. Everything else: as timed.
 */
export function placeJob(job, iso, { hoursFor, isBg, absentOn } = {}) {
  if (!hoursFor || isBg?.(job) || !isMultiDay(job) || !job.start_time) return placeOn(job, iso);
  if (iso < job.work_date || iso > job.end_date) return null;
  const h = hoursFor(job.person_id, iso);
  if (!h?.works || absentOn?.(job.person_id, iso)) return null;
  const { ws, we } = workDay(h);
  const s = iso === job.work_date ? Math.max(ws, toMin(job.start_time)) : ws;
  const e = iso === job.end_date && job.end_time ? Math.min(we, toMin(job.end_time)) : we;
  return e > s ? { s, e } : null;
}

/** Epoch-minute intervals a job occupies (for test capacity). */
export function segmentsOf(job, opts = {}) {
  if (!opts.hoursFor || opts.isBg?.(job) || !isMultiDay(job) || !job.start_time) return [intervalOf(job)];
  const out = [];
  for (let d = fromISO(job.work_date); toISO(d) <= job.end_date; d = addDays(d, 1)) {
    const iso = toISO(d);
    const p = placeJob(job, iso, opts);
    if (!p) continue;
    const [day0] = intervalOf({ work_date: iso });
    out.push([day0 + p.s, day0 + p.e]);
  }
  return out.length ? out : [intervalOf(job)];
}

/**
 * Spread `work` minutes over working days, starting on `iso` at `start` (or the
 * person's start). dayInfo(iso) → { ws, we, breaks } or null (not working / absent).
 * → [{ date, start, end, work, paused }]  (the last part may run to `we` if maxDays is hit)
 */
export function planWork({ iso, start, work, pause = true, dayInfo, maxDays = 21 }) {
  const parts = [];
  let left = work;
  let d = fromISO(iso);
  for (let i = 0; i < maxDays && left > 0; i++, d = addDays(d, 1)) {
    const date = toISO(d);
    const info = dayInfo(date);
    if (!info) continue;
    const s = Math.max(i === 0 && start != null ? start : info.ws, info.ws);
    if (s >= info.we) continue;
    const brk = pause ? info.breaks : [];
    const { end, paused } = addWork(s, left, brk);
    if (end <= info.we) { parts.push({ date, start: s, end, work: left, paused }); left = 0; break; }
    const done = workBetween(s, info.we, brk, pause);
    parts.push({ date, start: s, end: info.we, work: done, paused: breakMinutes(s, info.we, brk) });
    left -= done;
  }
  return parts;
}

/** dayInfo for planWork from a ctx-like source (hoursFor + absences). */
export function dayInfoFrom(hoursFor, absentOn, personId) {
  return (iso) => {
    const h = hoursFor(personId, iso);
    if (!h?.works || absentOn?.(personId, iso)) return null;
    const { ws, we, breaks } = workDay(h);
    return { ws, we, breaks };
  };
}

/** "1h 30m" / "90" / "1:30" / "1.5h" → minutes (or null). */
export function parseDuration(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return null;
  let m;
  if ((m = t.match(/^(\d+):(\d{1,2})$/))) return Number(m[1]) * 60 + Number(m[2]);
  if ((m = t.match(/^(\d+(?:\.\d+)?)\s*h(?:ours?|rs?)?(?:\s*(\d+)\s*m(?:in(?:ute)?s?)?)?$/))) return Math.round(Number(m[1]) * 60) + (m[2] ? Number(m[2]) : 0);
  if ((m = t.match(/^(\d+)\s*m(?:in(?:ute)?s?)?$/))) return Number(m[1]);
  if ((m = t.match(/^\d+$/))) return Number(t);
  return null;
}

export const hmOf = (t) => (t == null ? null : hm(t));
