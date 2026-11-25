// Rows for the Excel export (no DOM, no Excel library — see exportXlsx.js).
// Times are minutes from midnight; dates are "YYYY-MM-DD".
import { toISO, fromISO, addDays } from './dates.js';
import { isTimed, placeOn, fmtMin } from './daytime.js';
import { endDateOf, ABSENCE_TYPES } from './jobs.js';

/** "QPro 2000 · Quality testing ×5" */
const jobTextPlain = (ctx, a) => [ctx.pump(a), ctx.taskById.get(a.task_id)?.name].filter(Boolean).join(' · ') + (a.qty_target != null ? ` ×${a.qty_target}` : '');

export const SLICE = { job: 'Job', free: 'Free', break: 'Break', lunch: 'Lunch', absent: 'Absent', off: 'Not working' };

export function daysBetween(from, to) {
  const out = [];
  for (let d = fromISO(from); toISO(d) <= to; d = addDays(d, 1)) out.push(toISO(d));
  return out;
}

/**
 * ctx: a planner ctx (makeCtx(loadRange(...))); range from..to; personIds: [] = everyone.
 * Returns { timesheet, absences, byPerson, byPump, capacity }.
 */
export function exportRows(ctx, { from, to, personIds = [], demand = null, todos = null }) {
  const days = daysBetween(from, to);
  const people = ctx.people.filter((p) => (personIds.length ? personIds.includes(p.id) : p.active
    || ctx.assignments.some((a) => a.person_id === p.id)));
  const taskName = (id) => ctx.taskById.get(id)?.name || '—';
  const timesheet = [];
  const absences = [];
  const per = new Map(); // person → { tasks: Map(task → minutes), busy, free, brk, absent, untimed }
  const taskCols = new Set();

  for (const p of people) {
    const sum = { tasks: new Map(), busy: 0, free: 0, brk: 0, absent: 0, untimed: 0, working: 0, prod: 0, office: 0 };
    per.set(p.id, sum);
    for (const iso of days) {
      const hrs = ctx.hoursFor(p.id, iso);
      const day = ctx.dayOf(p.id, iso);
      const absence = ctx.absenceOn(p.id, iso);
      const { attended, background } = ctx.jobsOn(p.id, iso);
      const jobs = [...attended, ...background];
      if (!hrs.works && !jobs.length && !absence) continue;
      const items = [];
      const base = { date: iso, person: p.name };
      const workMin = hrs.works ? Math.max(0, day.we - day.ws - day.breaks.reduce((t, b) => t + (b.e - b.s), 0)) : 0;
      if (absence) {
        const type = ABSENCE_TYPES[absence.absence_type] || absence.absence_type;
        if (hrs.works) {
          items.push({ ...base, kind: 'absent', start: day.ws, end: day.we, minutes: workMin, task: `Absent — ${type}`, notes: absence.notes || '' });
          absences.push({ date: iso, person: p.name, type, hours: workMin / 60, notes: absence.notes || '' });
          sum.absent += workMin;
        }
      } else if (!hrs.works) {
        items.push({ ...base, kind: 'off', task: 'Not a working day', notes: hrs.oneOff?.notes || '' });
      } else {
        sum.working += workMin;
        for (const b of day.breaks) {
          items.push({ ...base, kind: b.label === 'Lunch' ? 'lunch' : 'break', start: b.s, end: b.e, minutes: b.e - b.s, task: b.label });
          sum.brk += b.e - b.s;
        }
        for (const [s, e] of day.free) items.push({ ...base, kind: 'free', start: s, end: e, minutes: e - s, task: 'Free' });
        sum.busy += day.busyMin;
        sum.free += day.freeMin;
      }
      for (const a of jobs) {
        const bg = ctx.isBg(a);
        const continuing = iso !== a.work_date;
        const office = ctx.taskById.get(a.task_id)?.category === 'office';
        const row = {
          ...base, kind: 'job', task: taskName(a.task_id), pump: office ? '' : ctx.pump(a) || '',
          category: office ? 'Office' : 'Production', qtyDone: office || continuing || a.part_of ? null : a.qty_done ?? null,
          qty: continuing || a.part_of ? null : a.qty_target, type: ctx.typeById.get(a.build_type_id)?.name || '',
          station: ctx.equipmentById.get(a.equipment_id)?.name || '', mode: bg ? 'Background' : 'Attended',
          recurring: a.recurring_id ? 'Y' : 'N',
          notes: [continuing ? `continues from ${a.work_date}` : null, endDateOf(a) > iso ? 'continues next day' : null, a.notes].filter(Boolean).join(' · '),
        };
        if (isTimed(a)) {
          const pl = ctx.place ? ctx.place(a, iso) : placeOn(a, iso);
          if (!pl) continue; // multi-day job: not this day (non-working / absent)
          row.start = Math.max(0, pl.s); row.end = Math.min(24 * 60, pl.e);
          // duration = work time (breaks it pauses for are listed as their own rows)
          row.minutes = ctx.workMinutes ? ctx.workMinutes(a, iso) ?? row.end - row.start : row.end - row.start;
          const paused = row.end - row.start - row.minutes;
          if (paused > 0) row.notes = [`incl. ${paused} min break`, row.notes].filter(Boolean).join(' · ');
          if (!bg) {
            taskCols.add(row.task);
            sum.tasks.set(row.task, (sum.tasks.get(row.task) || 0) + row.minutes);
            if (office) sum.office += row.minutes; else sum.prod += row.minutes;
          }
        } else {
          row.notes = ['No time set', row.notes].filter(Boolean).join(' · ');
          if (!bg) sum.untimed++;
        }
        items.push(row);
      }
      items.sort((x, y) => (x.start ?? 1e9) - (y.start ?? 1e9) || (x.kind === 'job' ? 1 : 0) - (y.kind === 'job' ? 1 : 0));
      timesheet.push(...items);
    }
  }

  const tasks = [...taskCols].sort((a, b) => {
    const ia = ctx.tasks.findIndex((t) => t.name === a); const ib = ctx.tasks.findIndex((t) => t.name === b);
    return ia - ib;
  });
  const byPerson = {
    tasks,
    rows: people.map((p) => {
      const x = per.get(p.id);
      return { person: p.name, tasks: tasks.map((t) => (x.tasks.get(t) || 0) / 60), production: x.prod / 60, office: x.office / 60, busy: x.busy / 60, free: x.free / 60, brk: x.brk / 60, absent: x.absent / 60, untimed: x.untimed };
    }),
  };

  // Units per pump model and build type (jobs starting in the range; quantities counted once)
  const pumpMap = new Map();
  const pumpRow = (model, type) => {
    const key = `${model}|${type}`;
    if (!pumpMap.has(key)) pumpMap.set(key, { model, type, built: 0, tested: 0, other: 0, linked: 0, unitsDone: 0, jobs: 0, demand: 0, completed: 0, toDo: 0 });
    return pumpMap.get(key);
  };
  const add = (model, type, task, qty, linked, done = 0) => {
    const r = pumpRow(model, type);
    r.jobs += 1;
    r.unitsDone += done;
    if (linked && task?.counts_as_output) r.linked += qty;
    if (task?.counts_as_output) r.built += qty; else if (task?.is_testing) r.tested += qty; else r.other += qty;
  };
  const inRange = ctx.assignments.filter((a) => !a.part_of && a.work_date >= from && a.work_date <= to
    && (!personIds.length || personIds.includes(a.person_id)) && (a.pump_model_id || a.any_pump));
  for (const a of inRange) {
    const task = ctx.taskById.get(a.task_id);
    const type = ctx.typeById.get(a.build_type_id)?.name || 'Not specified';
    const qty = a.qty_target || 0;
    const mix = (a.pump_mix || []).filter((x) => x.qty > 0 && ctx.modelById.get(x.pump_model_id));
    const linked = Boolean(a.demand_id);
    if (task?.category === 'office') continue;
    if (a.any_pump && mix.length) mix.forEach((m, i) => add(ctx.modelById.get(m.pump_model_id).name, type, task, m.qty, linked, i === 0 ? a.qty_done || 0 : 0));
    else add(a.any_pump ? 'Any / mixed pump' : ctx.modelById.get(a.pump_model_id)?.name || '—', type, task, qty, linked, a.qty_done || 0);
  }
  // Demand due in the range (or overdue and not done): needed, completed at the last stage, still to do
  for (const { note: n, state: s } of dueDemand(demand, from, to)) {
    if (!n.pump_model_id && !n.any_pump) continue;
    const r = pumpRow(n.any_pump ? 'Any / mixed pump' : demand.modelById.get(n.pump_model_id)?.name || '—', demand.typeById.get(n.build_type_id)?.name || 'Not specified');
    r.demand += n.quantity || 0;
    r.completed += Math.min(s.completed || 0, n.quantity || 0);
    r.toDo += s.toDo || 0;
  }
  const order = new Map(ctx.models.map((m, i) => [m.name, i]));
  const byPump = [...pumpMap.values()].sort((a, b) => (order.get(a.model) ?? 99) - (order.get(b.model) ?? 99) || a.type.localeCompare(b.type));

  // Test capacity per day
  const areas = ctx.capacity.areas;
  const capacity = {
    areas: areas.map((a) => ({ name: a.name, sequential: a.capacity_mode === 'sequential', max: a.max_pumps })),
    rows: days.map((iso) => {
      const c = ctx.capDay(iso);
      return {
        date: iso,
        areas: c.areas.map((a) => (a.sequential
          ? { busyHours: a.busy.reduce((t, [s, e]) => t + (e - s), 0) / 60, busy: a.busy.map(([s, e]) => `${fmtMin(s)}–${fmtMin(e)}`).join(', '), overlap: a.peak > 1 ? 'Y' : 'N', label: a.label }
          : { peak: a.peak, at: a.peak ? a.at : '', over: a.peak > a.max ? 'Y' : 'N', label: a.label })),
        untimed: c.untimed.length,
        untimedJobs: c.untimed.map((u) => jobTextPlain(ctx, u.job)).join('; '),
      };
    }),
  };

  // Demand notes due in the range (or overdue and not done), with the jobs linked to them
  const demandRows = dueDemand(demand, from, to)
    .map(({ note: n, state: s }) => ({
      model: n.any_pump ? 'Any / mixed pump' : demand.modelById.get(n.pump_model_id)?.name || 'General note',
      type: demand.typeById.get(n.build_type_id)?.name || '',
      needed: n.quantity, neededBy: n.needed_by, planned: s.planned, plannedManual: s.plannedManual || 0, toPlan: s.remaining,
      completed: s.completed || 0, toDo: s.toDo, lastStage: s.lastStageName || '',
      stages: (s.stages || []).map((st) => `${st.name} ${st.planned}/${n.quantity ?? '?'} planned, ${st.done} done`).join(' → '),
      status: { open: 'Needs planning', partly: 'Partly planned', planned: 'Fully planned', done: 'Done' }[s.status] + (s.overridden ? ' (set by hand)' : ''),
      tooLate: s.tooLate ? s.lastFinish : null,
      jobs: s.jobs.map((a) => `${a.work_date} ${(demand.personById.get(a.person_id)?.name || '—').split(' ')[0]} ${demand.taskById.get(a.task_id)?.name || ''} ×${a.qty_target ?? '?'}${a.qty_done != null ? ` (${a.qty_done} done)` : ''}`).join('; '),
      priority: n.priority, askedBy: demand.nameOf(n.created_by), comment: n.comment || '',
    }));

  // To-dos: open ones, plus those done whose due date is in the range
  const TS = { todo: 'To do', in_progress: 'In progress', done: 'Done' };
  const todoRows = !todos?.items ? [] : todos.items
    .filter(({ todo: t }) => t.status !== 'done' || (t.due_date && t.due_date >= from && t.due_date <= to))
    .map(({ todo: t, state: st }) => ({
      title: t.title, owner: t.owner_id ? todos.nameOf(t.owner_id) : '', due: t.due_date || null, priority: t.priority,
      status: TS[t.status] || t.status, overdue: st.overdue ? 'Y' : 'N',
      checklist: st.checkTotal ? `${st.checkDone} / ${st.checkTotal}` : '',
      scheduled: st.jobs.map((a) => `${a.work_date}${a.start_time ? ' ' + String(a.start_time).slice(0, 5) : ''} ${(todos.personById.get(a.person_id)?.name || '—').split(' ')[0]}`).join('; '),
      hours: st.jobs.reduce((m, a) => m + (a.start_time && a.end_time && (!a.end_date || a.end_date === a.work_date)
        ? (toMinutes(a.end_time) - toMinutes(a.start_time)) : 0), 0) / 60,
      addedBy: todos.nameOf(t.created_by), details: t.details || '',
    }));

  return { timesheet, absences, byPerson, byPump, capacity, demand: demandRows, todos: todoRows, people: people.map((p) => p.name) };
}

const toMinutes = (t) => { const [hh, mm] = String(t).split(':').map(Number); return hh * 60 + (mm || 0); };

/** Demand notes due in the range, or overdue / undated and not done. */
function dueDemand(demand, from, to) {
  return !demand?.items ? [] : demand.items
    .filter((x) => (x.note.needed_by && x.note.needed_by >= from && x.note.needed_by <= to) || (x.state.status !== 'done' && (!x.note.needed_by || x.note.needed_by < from)));
}
