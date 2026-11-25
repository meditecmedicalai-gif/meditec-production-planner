// A person's working day: busy / free / break time.
//
// Used by the Day timeline, the busy/free bar in the week grid, "Who's free
// now" on Today and the mini timeline in the job form.
//
// Times are minutes from midnight of the day being looked at, so a job that
// started the evening before has a negative start and one running into the
// next day ends after 1440.
//
// Rules:
//  * attended jobs with a start time make the person busy;
//  * background jobs never make the person busy (shown as a band);
//  * jobs without a start time are "No time set" — not placed on the clock;
//  * breaks and lunch are neither busy nor free;
//  * an absence makes the whole day unavailable.
import { intervalOf, hm } from './jobs.js';

export const DEFAULT_HOURS = { work_start: '08:30', work_end: '16:30', break_time: '10:30', break_minutes: 15, lunch_time: '12:30', lunch_minutes: 30 };

export const toMin = (t) => { const [a, b] = String(hm(t) || '00:00').split(':').map(Number); return a * 60 + b; };
export const fmtMin = (m) => {
  const x = ((Math.round(m) % 1440) + 1440) % 1440;
  return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`;
};
/** "5h", "5h 15m", "45m". */
export const fmtDur = (m) => {
  m = Math.max(0, Math.round(m));
  const hh = Math.floor(m / 60); const mm = m % 60;
  if (!hh) return `${mm}m`;
  return mm ? `${hh}h ${mm}m` : `${hh}h`;
};

/** Working window and breaks (minutes from midnight). */
export function workDay(hours) {
  const x = { ...DEFAULT_HOURS, ...(hours || {}) };
  const ws = toMin(x.work_start); const we = toMin(x.work_end);
  const breaks = [];
  if (x.break_minutes > 0) breaks.push({ s: toMin(x.break_time), e: toMin(x.break_time) + x.break_minutes, label: 'Break' });
  if (x.lunch_minutes > 0) breaks.push({ s: toMin(x.lunch_time), e: toMin(x.lunch_time) + x.lunch_minutes, label: 'Lunch' });
  return { ws, we, breaks: breaks.map((b) => ({ ...b, s: Math.max(ws, b.s), e: Math.min(we, b.e) })).filter((b) => b.e > b.s).sort((a, b) => a.s - b.s) };
}

/** Merge [s, e] pairs. */
function merge(list) {
  const out = [];
  for (const [s, e] of list.filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0])) {
    const last = out.at(-1);
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}
/** `base` minus `cut` (both lists of [s, e]). */
function subtract(base, cut) {
  let out = base.map((x) => [...x]);
  for (const [cs, ce] of cut) {
    out = out.flatMap(([s, e]) => (ce <= s || cs >= e ? [[s, e]] : [[s, Math.min(e, cs)], [Math.max(s, ce), e]].filter(([a, b]) => b > a)));
  }
  return out;
}
const total = (list) => list.reduce((t, [s, e]) => t + (e - s), 0);

/** Where a job sits on day `iso` (minutes from that day's midnight). */
export function placeOn(job, iso) {
  const [day0] = intervalOf({ work_date: iso });
  const [s, e] = intervalOf(job);
  return { s: s - day0, e: e - day0 };
}
/** A job has a clock time on this day if it has a start time (any day it covers). */
export const isTimed = (job) => Boolean(job.start_time);

/**
 * One person's day.
 *   jobs:   that person's jobs covering `iso`
 *   isBg:   (job) => boolean
 *   absent: absence row or null
 * Returns { attended:[{job,s,e}], background:[{job,s,e}], untimed:[job], busy:[[s,e]],
 *           free:[[s,e]], breaks, ws, we, busyMin, freeMin, absent }
 */
export function personDay({ jobs, iso, isBg, hours, absent = null, place = null }) {
  const { ws, we, breaks } = workDay(hours);
  const attended = []; const background = []; const untimed = [];
  const byStart = (a, b) => a.s - b.s || a.e - b.e;
  for (const job of jobs) {
    if (!isTimed(job)) { if (!isBg(job)) untimed.push(job); else background.push({ job, ...placeOn(job, iso), untimed: true }); continue; }
    const pl = place ? place(job, iso) : placeOn(job, iso);
    if (!pl) continue; // e.g. a multi-day job on a non-working day
    (isBg(job) ? background : attended).push({ job, ...pl });
  }
  attended.sort(byStart); background.sort(byStart);
  const nonWorking = hours?.works === false;
  const breakList = breaks.map((b) => [b.s, b.e]);
  const window = absent || nonWorking ? [] : subtract([[ws, we]], breakList);
  const busy = absent || nonWorking ? [] : merge(attended.map((x) => [Math.max(x.s, ws), Math.min(x.e, we)]));
  const busyIn = subtract(window, subtract(window, busy)); // busy ∩ working time
  const free = subtract(window, busy).filter(([s, e]) => e - s >= 5);
  return {
    attended, background, untimed, busy: busyIn, free, breaks: nonWorking ? [] : breaks, ws, we, absent, nonWorking, hours,
    busyMin: total(busyIn), freeMin: total(free),
  };
}

/**
 * What a person is doing at minute `m` (minutes from midnight).
 * { kind: 'absent'|'off'|'break'|'busy'|'free', text, until, job }
 */
export function statusAt(day, m) {
  if (day.absent) return { kind: 'absent' };
  if (day.nonWorking) return { kind: 'off', text: 'Not working today' };
  if (m < day.ws) return { kind: 'off', text: `Not started yet — starts ${fmtMin(day.ws)}` };
  if (m >= day.we) return { kind: 'off', text: 'Finished for the day' };
  const brk = day.breaks.find((b) => m >= b.s && m < b.e);
  if (brk) return { kind: 'break', label: brk.label, until: brk.e };
  const now = day.attended.filter((x) => x.s <= m && x.e > m);
  if (now.length) {
    const block = day.busy.find(([s, e]) => m >= s && m < e);
    return { kind: 'busy', job: now[0].job, until: block ? block[1] : now[0].e, more: now.length - 1 };
  }
  const gap = day.free.find(([s, e]) => m >= s && m < e);
  // free until the next job, break or the end of the day
  const next = Math.min(day.we, ...day.attended.filter((x) => x.s > m).map((x) => x.s), ...day.breaks.filter((b) => b.s > m).map((b) => b.s));
  return { kind: 'free', until: gap ? Math.min(gap[1], next) : next };
}

/** The next free slot that starts after `m` (or the current one if free now). */
export function nextFree(day, m) {
  for (const [s, e] of day.free) {
    if (e <= m) continue;
    return [Math.max(s, m), e];
  }
  return null;
}
