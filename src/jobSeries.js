// Jobs over several days, against the database: load a whole job, the person's
// working days ahead, save all parts in one step (apply_job_parts, migration 013),
// undo. The planning itself is in series.js (pure, unit-tested).
import { supabase } from './supabase.js';
import { makeHours } from './hours.js';
import { dayInfoFrom } from './timing.js';
import { toISO, fromISO, addDays, fmtDayShort } from './dates.js';
import { partsOf, totalOf, diffParts, planSeries, moveJob, partsText } from './series.js';
import { toast, reportError } from './ui.js';

/** Fields shared by every part of a job (applied to all parts on every save). */
export const SHARED = ['person_id', 'task_id', 'pump_model_id', 'any_pump', 'pump_mix', 'build_type_id', 'qty_target', 'notes',
  'background', 'equipment_id', 'pause_for_breaks', 'demand_id', 'todo_id'];
export const pickShared = (row) => Object.fromEntries(SHARED.filter((k) => k in row).map((k) => [k, row[k]]));

/** Is this row part of a job over several days? (needs the loaded week or part rows) */
export const isSeriesRow = (ctx, a) => Boolean(a?.part_of || [...(ctx.partRows || []), ...(ctx.assignments || [])].some((x) => x.part_of === a?.id));

/** Every row of the job `a` belongs to (part 1 + parts), sorted by date. */
export async function loadJobRows(a) {
  const key = a.part_of || a.id;
  const { data, error } = await supabase.from('assignments').select('*').or(`id.eq.${key},part_of.eq.${key}`);
  if (error) return { error };
  const rows = (data || []).sort((x, y) => (x.work_date < y.work_date ? -1 : x.work_date > y.work_date ? 1 : (x.part_of ? 1 : 0) - (y.part_of ? 1 : 0)));
  return { rows };
}

/**
 * dayInfo(iso) for a person from `from` onwards (absences and one-off hours loaded for
 * the next `days` days, so a job can continue past the week on screen).
 */
export async function dayInfoFor(ctx, personId, from, days = 60) {
  const until = toISO(addDays(fromISO(from), days));
  const [ab, dh] = await Promise.all([
    supabase.from('absences').select('person_id, start_date, end_date').eq('person_id', personId).lte('start_date', until).gte('end_date', from),
    supabase.from('person_day_hours').select('*').eq('person_id', personId).gte('work_date', from).lte('work_date', until).then((x) => (x.error ? { data: [] } : x)),
  ]);
  const absences = [...(ab.data || []), ...(ctx.absences || []).filter((x) => x.person_id === personId)];
  const hrs = makeHours({ patterns: ctx.patterns || [], patternDays: ctx.patternDays || [], personPatterns: ctx.personPatterns || [],
    dayHours: [...(ctx.dayHours || []).filter((x) => x.person_id !== personId || x.work_date < from), ...(dh.data || [])], settings: ctx.hours });
  const absentOn = (p, iso) => absences.some((x) => x.start_date <= iso && x.end_date >= iso);
  return dayInfoFrom(hrs.forDay, absentOn, personId);
}

const NEW_COLUMNS = ['work_minutes', 'part_locked'];
/**
 * Save a job's parts in one step. rows[0] is part 1; rows with an id are updated,
 * rows without are added; `remove` ids are deleted. → { headId } or { error }.
 * Before migration 013 (no apply_job_parts): one request at a time, same result.
 */
export async function saveParts({ rows, remove = [] }) {
  const { data, error } = await supabase.rpc('apply_job_parts', { p_rows: rows, p_remove: remove });
  if (!error) return { headId: data };
  if (!/apply_job_parts|PGRST202|function/i.test(`${error.code} ${error.message}`)) return { error };
  // fallback (before 013)
  const strip = (r) => Object.fromEntries(Object.entries(r).filter(([k]) => !NEW_COLUMNS.includes(k) && k !== 'id'));
  let headId = rows[0].id;
  if (headId) {
    const { error: e } = await supabase.from('assignments').update({ ...strip(rows[0]), part_of: null }).eq('id', headId);
    if (e) return { error: e };
  } else {
    const { data: one, error: e } = await supabase.from('assignments').insert({ ...strip(rows[0]), part_of: null }).select('id').single();
    if (e) return { error: e };
    headId = one.id;
  }
  for (const r of rows.slice(1)) {
    const body = { ...strip(r), part_of: headId, qty_done: null };
    const { error: e } = r.id ? await supabase.from('assignments').update(body).eq('id', r.id) : await supabase.from('assignments').insert(body);
    if (e) return { error: e };
  }
  if (remove.length) {
    const { error: e } = await supabase.from('assignments').delete().in('id', remove.filter((id) => id !== headId));
    if (e) return { error: e };
  }
  return { headId };
}

/** Put a job back exactly as it was (`before` = its rows before the change; [] = it didn't exist). */
export async function restoreJob(before, headId) {
  const { rows: now = [] } = headId ? await loadJobRows({ id: headId }) : { rows: [] };
  if (!before.length) {
    const ids = now.map((r) => r.id);
    if (!ids.length) return true;
    const { error } = await supabase.from('assignments').delete().in('id', ids);
    return !reportError(error, 'Undo');
  }
  const still = new Set(now.map((r) => r.id));
  const sorted = [...before].sort((x, y) => (x.part_of ? 1 : 0) - (y.part_of ? 1 : 0) || (x.work_date < y.work_date ? -1 : 1));
  const rows = sorted.map((r) => {
    const { created_at: _c, updated_at: _u, created_by: _b, updated_by: _ub, part_of: _p, ...rest } = r;
    if (!still.has(r.id)) delete rest.id;   // deleted by the change: added back
    return rest;
  });
  const remove = now.filter((r) => !before.some((b) => b.id === r.id)).map((r) => r.id);
  const { error } = await saveParts({ rows, remove });
  return !reportError(error, 'Undo');
}

/** "Split into 2 parts: Tue 15:30–16:30 → Wed 08:30–09:45" */
export const splitText = (parts) => `Split into ${parts.length} parts: ${partsText(parts, (iso) => fmtDayShort(fromISO(iso)).split(' ')[0])}`;

/** A toast with actions (Undo · Edit …). */
export function actionToast(message, actions, type = 'success') {
  toast(message, type, actions);
}

/**
 * Move a whole job so that the dragged part `a` lands on `toDate` (optionally for another
 * person). All parts shift together and re-flow from the new start. → { ok, before, headId, parts }
 */
export async function moveWholeJob(ctx, a, { toDate, personId, mode = 'continue' }) {
  const { rows, error } = await loadJobRows(a);
  if (reportError(error, 'Moving')) return { ok: false };
  const head = rows.find((r) => !r.part_of) || rows[0];
  const pid = personId || head.person_id;
  const current = partsOf(rows);
  const index = Math.max(0, current.findIndex((p) => p.id === a.id));
  const values = { ...pickShared(head), person_id: pid, qty_done: head.qty_done ?? null };
  let parts;
  let total = null;
  const delta = Math.round((fromISO(toDate) - fromISO(current[index].date)) / 86400000);
  const newStart = toISO(addDays(fromISO(current[0].date), delta));
  const overtimeOne = mode === 'overtime' && rows.length === 1;
  if (head.start_time && head.end_time && !head.end_date && !ctx.isBg?.(head) && !overtimeOne) {
    const dayInfo = await dayInfoFor(ctx, pid, newStart < current[0].date ? newStart : current[0].date);
    const pause = head.pause_for_breaks !== false;
    total = totalOf(rows, dayInfo, pause);
    if (total > 0) parts = moveJob({ current, index, toDate, total, pause, dayInfo });
  }
  if (!parts) {
    // untimed, background, "Ends on" or overtime job: shift its dates, nothing to re-flow
    const body = { person_id: pid, work_date: newStart, end_date: head.end_date ? toISO(addDays(fromISO(head.end_date), delta)) : null };
    const { error: e } = await supabase.from('assignments').update(body).eq('id', head.id);
    if (reportError(e, 'Moving')) return { ok: false };
    return { ok: true, before: rows, headId: head.id, parts: null };
  }
  const { rows: out, remove } = diffParts(rows, parts, values, { total });
  const res = await saveParts({ rows: out, remove });
  if (reportError(res.error, 'Moving')) return { ok: false };
  return { ok: true, before: rows, headId: res.headId, parts };
}

/** A copy of a whole job starting `days` later (Copy last week), re-flowed with the person's hours. */
export async function copyWholeJob(ctx, rows, days) {
  const head = rows.find((r) => !r.part_of) || rows[0];
  const current = partsOf(rows);
  const toDate = toISO(addDays(fromISO(current[0].date), days));
  const values = { ...pickShared(head), qty_done: null };
  const dayInfo = await dayInfoFor(ctx, head.person_id, toDate);
  const pause = head.pause_for_breaks !== false;
  const total = totalOf(rows, dayInfo, pause);
  const parts = planSeries({ date: toDate, start: current[0].start, total, pause, dayInfo });
  if (!parts.length) return { skipped: true };
  const { rows: out } = diffParts([], parts, values, { total });
  return saveParts({ rows: out });
}
