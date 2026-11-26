// Job timing rules, shared by the planner, summary, print and history.
//
//   no start/end time          → the whole day
//   end time <= start time     → finishes the NEXT day (overnight)
//   end date set               → runs until that date (multi-day)
//
// A job is "background" (unattended) when its own `background` flag says so,
// or, if that is empty, when its task is marked background.

import { toISO, fromISO, addDays, fmtDayShort, fmtWeekday } from './dates.js';

export const hm = (t) => (t ? String(t).slice(0, 5) : null);

export function isBackground(job, task) {
  return job.background ?? Boolean(task?.is_background);
}

/** Last calendar day the job covers ("YYYY-MM-DD"). */
export function endDateOf(job) {
  if (job.end_date) return job.end_date;
  if (job.start_time && job.end_time && hm(job.end_time) <= hm(job.start_time)) {
    return toISO(addDays(fromISO(job.work_date), 1));
  }
  return job.work_date;
}

export const coversDay = (job, iso) => job.work_date <= iso && iso <= endDateOf(job);
export const spansDays = (job) => endDateOf(job) !== job.work_date;

const toMinutes = (iso, time) => {
  const d = fromISO(iso);
  const [hh, mm] = (hm(time) || '00:00').split(':').map(Number);
  return Math.round(d.getTime() / 60000) + hh * 60 + mm;
};

/** [start, end) in minutes since the epoch (local time). */
export function intervalOf(job) {
  const start = toMinutes(job.work_date, job.start_time);
  const endIso = endDateOf(job);
  const end = job.end_time
    ? toMinutes(endIso, job.end_time)
    : toMinutes(toISO(addDays(fromISO(endIso), 1)), null); // to the end of the last day
  return [start, Math.max(end, start + 1)];
}

export function overlaps(a, b) {
  const [as, ae] = intervalOf(a);
  const [bs, be] = intervalOf(b);
  return as < be && bs < ae;
}

/**
 * Time text for a job on a given day, or null for a plain one-day job.
 *   start day:        "16:00 → 08:00 next day", "09:00 → 12:30", "from 14:00"
 *   continuation day: "cont. from Mon 16:00 · ends 08:00"
 */
export function timeLabel(job, iso) {
  const s = hm(job.start_time);
  const e = hm(job.end_time);
  const endIso = endDateOf(job);
  if (iso === job.work_date) {
    if (!s && endIso === job.work_date) return null;
    let endText = e || '';
    if (endIso !== job.work_date) {
      const next = toISO(addDays(fromISO(job.work_date), 1));
      endText = `${e ? e + ' ' : ''}${endIso === next ? 'next day' : fmtDayShort(fromISO(endIso))}`;
    }
    if (s && endText) return `${s} → ${endText}`;
    if (s) return `from ${s}`;
    return `until ${endText}`;
  }
  const from = `cont. from ${fmtWeekday(fromISO(job.work_date))}${s ? ' ' + s : ''}`;
  if (iso === endIso) return e ? `${from} · ends ${e}` : `${from} · last day`;
  return `${from} · continues`;
}

/** Plain-text time summary used by History. */
export function timeSummary(job) {
  const s = hm(job.start_time);
  const e = hm(job.end_time);
  const endIso = endDateOf(job);
  if (!s && endIso === job.work_date) return '';
  const endTxt = endIso === job.work_date ? (e || '') : `${e ? e + ' ' : ''}${fmtDayShort(fromISO(endIso))}`;
  return `${s || 'all day'}${endTxt ? ' → ' + endTxt : ''}`;
}

/**
 * Other jobs that clash with `job`:
 *  - equipment: same equipment at overlapping times (any person, any kind) —
 *               except equipment that can be shared (opts.isShared), e.g. the
 *               Quality Check area, where several jobs at once are normal
 *  - person:    same person, both attended (not background), both with a
 *               start time, overlapping times
 */
export function clashes(job, others, taskById, { isShared = () => false } = {}) {
  const eq = [];
  const shared = job.equipment_id && isShared(job.equipment_id);
  const person = [];
  const bg = isBackground(job, taskById.get(job.task_id));
  for (const o of others) {
    if (o.id && o.id === job.id) continue;
    if (job.equipment_id && !shared && o.equipment_id === job.equipment_id && overlaps(job, o)) eq.push(o);
    if (!bg && o.person_id === job.person_id && job.start_time && o.start_time
        && !isBackground(o, taskById.get(o.task_id)) && overlaps(job, o)) person.push(o);
  }
  return { equipment: eq, person };
}

/**
 * The pumps on a job, per model: [{ pump_model_id | null, qty }]. A job for one model is one entry.
 * A job with mixed pumps (tasks with "Allows mixed pumps", e.g. Rework) lists each model with its
 * quantity; pumps not identified yet are { pump_model_id: null } ("Any / unknown"). Anything in the
 * quantity not covered by the list also counts as "Any / unknown".
 */
export function pumpQtys(job) {
  const total = job.qty_target || 0;
  if (!job.any_pump) return job.pump_model_id ? [{ pump_model_id: job.pump_model_id, qty: total }] : [];
  const list = (job.pump_mix || []).filter((x) => x && x.qty > 0).map((x) => ({ pump_model_id: x.pump_model_id || null, qty: x.qty }));
  const listed = list.reduce((t, x) => t + x.qty, 0);
  if (total > listed) {
    const unknown = list.find((x) => !x.pump_model_id);
    if (unknown) unknown.qty += total - listed; else list.push({ pump_model_id: null, qty: total - listed });
  }
  return list;
}
/** Pump models named on a job (no "Any / unknown"). */
export const pumpModelsOf = (job) => [...new Set(pumpQtys(job).map((x) => x.pump_model_id).filter(Boolean))];
export const UNKNOWN_PUMP = 'Any / unknown';
/** Pump models on the job the person isn't trained on. skills: Set of "personId|modelId". */
export const untrainedModels = (job, skills) => pumpModelsOf(job).filter((id) => !skills.has(`${job.person_id}|${id}`));

/** "QPro 2000", or for mixed pumps "QPro ×3, MediAir ×2, Mediflex ×1, Any / unknown ×1" ("Any / unknown pump" if none named). */
export function pumpLabel(job, modelById, { short = false } = {}) {
  if (job.any_pump) {
    const list = pumpQtys(job);
    if (!list.some((x) => x.pump_model_id)) return `${UNKNOWN_PUMP} pump`;
    const name = (id) => { const m = modelById.get(id); return m ? (m.short_code || m.name) : '?'; };
    return list.map((x) => `${x.pump_model_id ? name(x.pump_model_id) : UNKNOWN_PUMP} ×${x.qty}`).join(', ');
  }
  const m = modelById.get(job.pump_model_id);
  return m ? (short && m.short_code ? m.short_code : m.name) : null;
}

export const ABSENCE_TYPES = { holiday: 'Holiday', sick: 'Sick', training: 'Training', off_site: 'Off-site' };
