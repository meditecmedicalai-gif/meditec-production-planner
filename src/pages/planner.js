import { h, mount, toast, reportError, openModal, confirmDialog, field, loading, hhmm } from '../ui.js';
import { supabase } from '../supabase.js';
import { auth } from '../auth.js';
import { demandPanel } from './demand.js';
import { loadSummaryDemand, summaryCard } from './summary.js';
import { isBackground, coversDay, endDateOf, timeLabel, clashes, hm, pumpLabel, ABSENCE_TYPES } from '../jobs.js';
import { capacityConfig, capacityForDay, level, stationMismatch, occupancyText, equipmentShared } from '../capacity.js';
import { occupancySvg, occupancyPopover } from './occupancy.js';
import { describe as describeRepeat, matches as repeatMatches } from '../recurring.js';
import { editAssignment, editTemplate, deleteTemplate, saveTemplateTimes } from './jobEditor.js';
import { editDayHours } from './hoursEditor.js';
import { openExport } from './exportDialog.js';
import { personDay, placeOn, isTimed, DEFAULT_HOURS, fmtMin, toMin } from '../daytime.js';
import { makeHours, hoursText, oneOffText, WEEKDAY_NAMES, isoDow } from '../hours.js';
import { placeJob, segmentsOf, pauses, breakMinutes } from '../timing.js';
import { dayTimeline, dayBar, viewRange, jobText } from './dayTimeline.js';
import {
  toISO, fromISO, addDays, mondayOf, today, isoWeek,
  fmtDayShort, fmtDayLong, fmtWeekday, fmtRange, fmtDate,
} from '../dates.js';

export { ABSENCE_TYPES };

let mobileDay = null;       // selected day index on narrow screens
let extendedOn = null;      // date recurring jobs were last extended (admins, once a day)
let recurringOpen = null;   // recurring panel open/closed (null = automatic)
let nowTimer = null;        // Day timeline "now" line
window.addEventListener('hashchange', () => { clearInterval(nowTimer); nowTimer = null; });

// ------------------------------------------------------------------ routing
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const hashParams = () => new URLSearchParams(location.hash.split('?')[1] || '');
function weekFromHash() {
  const q = hashParams();
  const w = q.get('day') || q.get('week');
  const d = w && ISO_RE.test(w) ? fromISO(w) : today();
  return mondayOf(d);
}
/** "week" | "day" and the chosen day (Day timeline). */
function viewFromHash(isoDays, todayISO) {
  const q = hashParams();
  const view = q.get('view') === 'day' ? 'day' : 'week';
  const d = q.get('day');
  const day = d && isoDays.includes(d) ? d : isoDays.includes(todayISO) ? todayISO : isoDays[0];
  return { view, day };
}
const planHash = ({ week, view, day }) => (view === 'day' ? `#/planner?view=day&day=${day}` : `#/planner?week=${toISO(week)}`);
const goToWeek = (monday, view = 'week', dayIdx = 0) => {
  location.hash = planHash({ week: monday, view, day: toISO(addDays(monday, dayIdx)) });
};
/** Next / previous working day (Mon–Fri). */
function stepWorkday(iso, dir) {
  let d = addDays(fromISO(iso), dir);
  while (d.getDay() === 0 || d.getDay() === 6) d = addDays(d, dir);
  return toISO(d);
}

// ------------------------------------------------------------------ data
export const JOB_COLUMNS = 'id, person_id, work_date, pump_model_id, any_pump, pump_mix, task_id, build_type_id, qty_target, notes, '
  + 'background, start_time, end_time, end_date, equipment_id, recurring_id, recurring_date, recurring_detached, created_at, updated_at';

export function loadWeek(monday) {
  return loadRange(toISO(monday), toISO(addDays(monday, 4)));
}

/** Tables added by a later migration: if it hasn't been run yet, carry on without them. */
const optional = (query) => query.then((r) => (r.error ? { data: [], error: null } : r));

/** Everything the planner needs for the days from..to (ISO dates, inclusive). */
export async function loadRange(from, to) {
  const dayBefore = toISO(addDays(fromISO(from), -1));
  const q = {
    people: supabase.from('people').select('*').order('name'),
    models: supabase.from('pump_models').select('id, name, short_code, active, sort_order, test_area_id').order('sort_order').order('name'),
    tasks: supabase.from('tasks').select('id, name, requires_pump, counts_as_output, is_background, is_testing, allows_any_pump, active, sort_order').order('sort_order').order('name'),
    types: supabase.from('build_types').select('id, name, color, is_default, active, sort_order').order('sort_order').order('name'),
    skills: supabase.from('person_skills').select('person_id, pump_model_id'),
    // Jobs starting this week, plus ones that started earlier and run into it
    // (overnight from the day before, or with an end date in this week or later).
    // pause_for_breaks / part_of come with migration 009 — fall back without them if it hasn't been run yet
    assignments: (async () => {
      const run = (cols) => supabase.from('assignments').select(cols)
        .lte('work_date', to).or(`work_date.gte.${dayBefore},end_date.gte.${from}`)
        .order('start_time', { nullsFirst: true }).order('created_at');
      const r1 = await run(`${JOB_COLUMNS}, pause_for_breaks, part_of`);
      return r1.error ? run(JOB_COLUMNS) : r1;
    })(),
    absences: supabase.from('absences').select('id, person_id, start_date, end_date, absence_type, notes').lte('start_date', to).gte('end_date', from),
    equipment: supabase.from('equipment').select('*').order('sort_order').order('name'),
    areas: supabase.from('test_areas').select('*').order('sort_order').order('name'),
    limits: supabase.from('test_limits').select('id, test_area_id, name, max_pumps, active, sort_order').order('sort_order').order('name'),
    limitModels: supabase.from('test_limit_models').select('test_limit_id, pump_model_id'),
    shared: supabase.from('test_area_shared_tasks').select('test_area_id, task_id'),
    recurring: supabase.from('recurring_jobs').select('*').eq('active', true).order('created_at'),
    hours: supabase.from('app_settings').select('work_start, work_end, break_time, break_minutes, lunch_time, lunch_minutes').eq('id', 1).maybeSingle(),
    patterns: optional(supabase.from('work_patterns').select('*').order('sort_order').order('name')),
    patternDays: optional(supabase.from('work_pattern_days').select('*')),
    personPatterns: optional(supabase.from('person_work_patterns').select('*').order('effective_from')),
    dayHours: optional(supabase.from('person_day_hours').select('*').gte('work_date', from).lte('work_date', to)),
  };
  const keys = Object.keys(q);
  const res = await Promise.all(Object.values(q));
  const err = res.find((r) => r.error)?.error;
  if (err) return { error: err };
  const r = Object.fromEntries(keys.map((k, i) => [k, res[i].data]));

  const byId = (rows) => new Map(rows.map((x) => [x.id, x]));
  // Continued jobs: also load the other parts outside this range, so "part 1 of 2" is right
  let partRows = [];
  {  // (before migration 009 these queries fail quietly → no parts)
    const ids = r.assignments.map((a) => a.id);
    const roots = [...new Set(r.assignments.map((a) => a.part_of).filter(Boolean))];
    const [kids, parents] = await Promise.all([
      ids.length ? supabase.from('assignments').select('id, part_of, work_date').in('part_of', ids) : { data: [] },
      roots.length ? supabase.from('assignments').select('id, part_of, work_date').in('id', roots) : { data: [] },
    ]);
    const parentIds = (parents.data || []).map((x) => x.id);
    const siblings = parentIds.length ? await supabase.from('assignments').select('id, part_of, work_date').in('part_of', parentIds) : { data: [] };
    partRows = [...(kids.data || []), ...(parents.data || []), ...(siblings.data || [])];
  }
  return {
    partRows,
    people: r.people,
    models: r.models, modelById: byId(r.models),
    tasks: r.tasks, taskById: byId(r.tasks),
    types: r.types, typeById: byId(r.types),
    defaultType: r.types.find((t) => t.is_default) || null,
    skills: new Set(r.skills.map((s) => `${s.person_id}|${s.pump_model_id}`)),
    // drop overnight jobs from Sunday that don't actually reach Monday
    assignments: r.assignments.filter((a) => endDateOf(a) >= from),
    absences: r.absences,
    equipment: r.equipment, equipmentById: byId(r.equipment),
    recurring: r.recurring, recurringById: byId(r.recurring),
    areas: r.areas,
    hours: r.hours || DEFAULT_HOURS,
    from, to,
    patterns: r.patterns, patternDays: r.patternDays, personPatterns: r.personPatterns, dayHours: r.dayHours,
    workHours: makeHours({ patterns: r.patterns, patternDays: r.patternDays, personPatterns: r.personPatterns, dayHours: r.dayHours, settings: r.hours }),
    capacity: capacityConfig({
      areas: r.areas, limits: r.limits, limitModels: r.limitModels, sharedTasks: r.shared,
      models: r.models, tasks: r.tasks, equipment: r.equipment,
    }),
  };
}

/** Helpers bound to a loaded week. */
export function makeCtx(data) {
  const capCache = new Map();
  const dayCache = new Map();
  const absentOn = (personId, iso) => data.absences.some((a) => a.person_id === personId && a.start_date <= iso && a.end_date >= iso);
  const placeOpts = { hoursFor: (p, iso) => data.workHours.forDay(p, iso), isBg: (a) => isBackground(a, data.taskById.get(a.task_id)), absentOn };
  const capCfg = { ...data.capacity, segmentsOf: (j) => segmentsOf(j, placeOpts) };
  // order inside a day: by start time; jobs without a time last
  const startKey = (a, iso) => (isTimed(a) ? placeOn(a, iso).s : Infinity);
  return {
    ...data,
    capacityCfg: capCfg,
    absenceOn(personId, iso) {
      return data.absences.find((a) => a.person_id === personId && a.start_date <= iso && a.end_date >= iso) || null;
    },
    trained(personId, modelId) {
      return data.skills.has(`${personId}|${modelId}`);
    },
    isBg(a) {
      return isBackground(a, data.taskById.get(a.task_id));
    },
    pump(a, opts) {
      return pumpLabel(a, data.modelById, opts);
    },
    /** Jobs covering a day for a person: attended first, then background. */
    jobsOn(personId, iso) {
      const jobs = data.assignments.filter((a) => a.person_id === personId && coversDay(a, iso))
        .map((a) => [a, startKey(a, iso)]).sort((x, y) => x[1] - y[1]).map(([a]) => a);
      return { attended: jobs.filter((a) => !this.isBg(a)), background: jobs.filter((a) => this.isBg(a)) };
    },
    /** Busy / free / break time for a person on a day (cached). */
    dayOf(personId, iso) {
      const key = `${personId}|${iso}`;
      if (!dayCache.has(key)) {
        const { attended, background } = this.jobsOn(personId, iso);
        dayCache.set(key, personDay({ jobs: [...attended, ...background], iso, isBg: (a) => this.isBg(a), hours: this.hoursFor(personId, iso), absent: this.absenceOn(personId, iso), place: this.place }));
      }
      return dayCache.get(key);
    },
    /** A job continued on the next working day(s): { n, total, first } or null. */
    partInfo(a) {
      const root = a.part_of || a.id;
      const all = new Map([...(data.partRows || []), ...data.assignments].map((x) => [x.id, x]));
      const group = [...all.values()].filter((x) => x.id === root || x.part_of === root);
      if (group.length < 2) return null;
      group.sort((x, y) => (x.work_date < y.work_date ? -1 : x.work_date > y.work_date ? 1 : 0));
      return { n: group.findIndex((x) => x.id === a.id) + 1, total: group.length, first: group[0] };
    },
    /** Where a job sits on a day: attended multi-day jobs only take each day's working hours. */
    place(a, iso) {
      return placeJob(a, iso, placeOpts);
    },
    /** Work minutes of a job on a day (less breaks when it pauses for them). */
    workMinutes(a, iso) {
      const p = placeJob(a, iso, placeOpts);
      if (!p || !isTimed(a)) return null;
      const s = Math.max(0, p.s); const e = Math.min(24 * 60, p.e);
      if (!pauses(a, this.isBg(a)) || !a.person_id) return e - s;
      const day = this.dayOf(a.person_id, iso);
      return e - s - breakMinutes(s, e, day.breaks);
    },
    /** The person's own working hours on a day (pattern → overrides → one-off change). */
    hoursFor(personId, iso) {
      return data.workHours.forDay(personId, iso);
    },
    /** ⚠ for work on a non-working day, outside the person's hours or across their break / lunch. */
    hoursWarnings(a, personName, iso) {
      if (!a.person_id || this.absenceOn(a.person_id, iso)) return [];
      const first = (personName || 'This person').split(' ')[0];
      const hrs = this.hoursFor(a.person_id, iso);
      const bg = this.isBg(a);
      if (!hrs.works) {
        if (bg && iso !== a.work_date) return [];
        if (hrs.oneOff) return [`${first} is not working on ${fmtDayShort(fromISO(iso))} (one-off day off).`];
        return [`${first} doesn’t work on ${WEEKDAY_NAMES[isoDow(iso) - 1]}s${hrs.pattern ? ` (${hrs.pattern.name})` : ''}.`];
      }
      if (bg || !isTimed(a)) return [];
      const p = placeJob(a, iso, placeOpts);
      if (!p) return [];
      const s0 = Math.max(p.s, 0); const e0 = Math.min(p.e, 24 * 60);
      const day = personDay({ jobs: [], iso, isBg: () => false, hours: hrs });
      return s0 < day.ws || e0 > day.we ? [`Outside ${first}’s hours (${hoursText(hrs)}).`] : [];
    },
    /** ⏰ notes (no confirmation needed): an attended job set to work THROUGH the person's break or lunch. */
    breakNotes(a, personName, iso) {
      if (a.pause_for_breaks !== false) return []; // pausing for breaks is the normal case
      if (!a.person_id || !isTimed(a) || this.isBg(a) || this.absenceOn(a.person_id, iso)) return [];
      const hrs = this.hoursFor(a.person_id, iso);
      if (!hrs.works) return [];
      const first = (personName || 'This person').split(' ')[0];
      const p = placeOn(a, iso);
      const s0 = Math.max(p.s, 0); const e0 = Math.min(p.e, 24 * 60);
      const day = personDay({ jobs: [], iso, isBg: () => false, hours: hrs });
      return day.breaks.filter((b) => s0 < b.e && b.s < e0)
        .map((b) => `Works through ${first}’s ${b.label.toLowerCase()} (${fmtMin(b.s)}–${fmtMin(b.e)}) — not pausing for it.`);
    },
    /** Test capacity for a day (cached). */
    capDay(iso) {
      if (!capCache.has(iso)) capCache.set(iso, capacityForDay(data.assignments, capCfg, iso));
      return capCache.get(iso);
    },
    /** Can several jobs use this equipment at once? (shared test area / "Can be shared") */
    equipmentShared(id) {
      return equipmentShared(data.equipmentById.get(id), data.capacity);
    },
    /** "Quality Check (shared — up to 7 pumps)", "Medicare / Mediflex test bench (one at a time)", "Test rig 1". */
    equipmentLabel(id) {
      const eq = data.equipmentById.get(id);
      if (!eq) return null;
      const area = eq.test_area_id && data.capacity.areaById.get(eq.test_area_id);
      if (area) return `${eq.name} (${area.capacity_mode === 'sequential' ? 'one at a time' : `shared — up to ${area.max_pumps} pumps`})`;
      return eq.shareable ? `${eq.name} (can be shared)` : eq.name;
    },
    /** Equipment / person time clashes against the loaded week, as messages. */
    clashWarnings(a, personById) {
      const c = clashes(a, data.assignments, data.taskById, { isShared: (id) => this.equipmentShared(id) });
      const out = [];
      for (const o of c.equipment) {
        out.push(`${data.equipmentById.get(a.equipment_id)?.name || 'Equipment'} is also booked for ${personById.get(o.person_id)?.name || 'someone'} (${fmtDayShort(fromISO(o.work_date))}${o.start_time ? ' ' + hm(o.start_time) : ''}).`);
      }
      for (const o of c.person) {
        out.push(`Overlaps another job at ${hm(o.start_time)} (${data.taskById.get(o.task_id)?.name || 'job'}).`);
      }
      return out;
    },
    /** Untrained (skill warnings skip "Any / mixed pump"). */
    warningsFor(a, personName) {
      const out = [];
      const task = data.taskById.get(a.task_id);
      const model = data.modelById.get(a.pump_model_id);
      if (task?.requires_pump && !a.any_pump && model && !data.skills.has(`${a.person_id}|${a.pump_model_id}`)) {
        out.push(`${personName} is not trained on ${model.name}.`);
      }
      const wrongStation = stationMismatch(a, data.capacity);
      if (wrongStation) out.push(wrongStation);
      return out;
    },
  };
}


// ------------------------------------------------------------------ page
export async function renderPlanner(main) {
  const monday = weekFromHash();
  const days = [0, 1, 2, 3, 4].map((i) => addDays(monday, i));
  const isoDays = days.map(toISO);
  const todayISO = toISO(today());
  if (mobileDay == null || mobileDay > 4) {
    const i = isoDays.indexOf(todayISO);
    mobileDay = i >= 0 ? i : 0;
  }
  const admin = auth.isAdmin;

  loading(main);
  // Recurring jobs: admins keep them generated 12 weeks ahead (once a day).
  if (admin && extendedOn !== todayISO) {
    const { error } = await supabase.rpc('extend_recurring_jobs');
    if (!error) extendedOn = todayISO;
  }
  const [data, panel, summaryDemand] = await Promise.all([
    loadWeek(monday),
    demandPanel(monday, () => renderPlanner(main)),
    loadSummaryDemand(),
  ]);
  if (reportError(data.error || summaryDemand.error, 'Loading the planner')) return;
  const hours = data.hours;
  const { view, day: viewDay } = viewFromHash(isoDays, todayISO);
  const dayIdx = isoDays.indexOf(viewDay);
  const ctx = makeCtx(data);
  const reload = () => renderPlanner(main);

  // Rows: active people, plus inactive people who still have work/absence this week.
  const busy = new Set([...data.assignments.map((a) => a.person_id), ...data.absences.map((a) => a.person_id)]);
  const rows = data.people.filter((p) => p.active || busy.has(p.id));
  const personById = new Map(data.people.map((p) => [p.id, p]));
  const edit = (opts) => editAssignment({ ctx, isoDays, personById, onSaved: reload, ...opts });
  const openJob = (a, person) => (admin ? edit({ person, iso: a.work_date, assignment: a }) : showAssignment(ctx, a, person, warningsOf(a, person, a.work_date)));

  /** All warnings for a job on a day (chips and the Day timeline). */
  const warningsOf = (a, person, iso) => {
    const absence = ctx.absenceOn(person.id, iso);
    const warnings = [...ctx.warningsFor(a, person.name), ...ctx.hoursWarnings(a, person.name, iso)];
    // Absence: attended work is flagged on every absent day; a background job
    // only on the day it starts (someone has to set it up).
    if (absence && (!ctx.isBg(a) || iso === a.work_date)) warnings.push(`${person.name} is marked ${ABSENCE_TYPES[absence.absence_type] || 'absent'} this day.`);
    warnings.push(...ctx.clashWarnings(a, personById));
    warnings.push(...(ctx.capDay(iso).jobMsgs.get(a.id) || []).map((m) => `Test capacity — ${m}`));
    return warnings;
  };

  // ---- recurring occurrences skipped because the person is absent
  const skippedOn = (person, iso) => data.recurring
    .filter((r) => r.person_id === person.id && repeatMatches(r, iso))
    .filter((r) => !data.assignments.some((a) => a.recurring_id === r.id && a.recurring_date === iso));

  // ---- one cell (person × day) — used by both the grid and the phone view
  const cell = (person, iso) => {
    const absence = ctx.absenceOn(person.id, iso);
    const { attended, background } = ctx.jobsOn(person.id, iso);
    const hrs = ctx.hoursFor(person.id, iso);
    const skipped = absence || !hrs.works ? skippedOn(person, iso) : [];
    return h('div', { class: 'cell-inner' },
      absence ? absenceBanner(absence, person) : hoursBanner(person, iso, hrs),
      skipped.map((r) => h('div', { class: 'skipped', title: `This recurring job was not added because the person is ${absence ? 'absent' : 'not working'}` },
        '🔁 ', h('s', {}, r.title || data.taskById.get(r.task_id)?.name || 'Recurring job'), ` — skipped (${absence ? 'absent' : 'not working'})`)),
      attended.map((a) => chip(a, person, absence, iso)),
      background.length ? h('div', { class: 'bg-group' },
        h('span', { class: 'bg-group-label' }, h('span', { 'aria-hidden': 'true' }, '⏱'), ' Running in the background'),
        background.map((a) => chip(a, person, absence, iso)),
      ) : null,
      !admin && !absence && !attended.length && !background.length ? h('span', { class: 'muted small cell-empty' }, 'Nothing planned') : null,
      dayBar(ctx.dayOf(person.id, iso)),
      admin ? h('div', { class: 'cell-actions' },
        h('button', {
          class: 'btn btn-xs btn-ghost',
          title: `Add work for ${person.name}`,
          'aria-label': `Add work for ${person.name} on ${fmtDayLong(fromISO(iso))}`,
          onclick: () => edit({ person, iso }),
        }, '+ Add'),
        absence ? null : h('button', { class: 'btn btn-xs btn-ghost', title: `Mark ${person.name} absent`, onclick: () => editAbsence({ ctx, person, iso, onSaved: reload }) }, 'Absent'),
        absence ? null : h('button', { class: 'btn btn-xs btn-ghost', title: `Change ${person.name}’s hours for this day only`, onclick: () => editHours(person, iso) }, 'Hours'),
      ) : null,
    );
  };
  const editHours = (person, iso) => editDayHours({
    person, iso, base: data.workHours.baseFor(person.id, iso), existing: data.workHours.oneOff(person.id, iso), onSaved: reload,
  });

  /** Non-working day, a one-off change, or hours different from the default pattern. */
  const hoursBanner = (person, iso, hrs) => {
    const usual = data.workHours.defaultFor(iso);
    const click = admin ? { type: 'button', onclick: () => editHours(person, iso) } : {};
    const tag = admin ? 'button' : 'div';
    if (!hrs.works) {
      const why = hrs.oneOff ? 'one-off' : hrs.pattern?.name;
      return h(tag, { class: 'nonwork', title: `${person.name} is not working on ${fmtDayLong(fromISO(iso))}${why ? ` (${why})` : ''}${hrs.oneOff?.notes ? ` — ${hrs.oneOff.notes}` : ''}`, ...click },
        'Not working', why ? h('span', { class: 'absence-note' }, why) : null);
    }
    if (hrs.oneOff) {
      return h(tag, { class: 'hours-tag hours-oneoff', title: `${hoursText(hrs)} today${hrs.oneOff.notes ? ` — ${hrs.oneOff.notes}` : ''}`, ...click },
        '⏰ ', oneOffText(hrs.oneOff), hrs.oneOff.notes ? h('span', { class: 'absence-note' }, hrs.oneOff.notes) : null);
    }
    if (hoursText(hrs) !== hoursText(usual) || hrs.override || (hrs.pattern && hrs.pattern.id !== usual.pattern?.id)) {
      return h('div', { class: 'hours-tag', title: `${person.name}: ${hoursText(hrs)}${hrs.pattern ? ` (${hrs.pattern.name}${hrs.override ? ', own hours' : ''})` : ''}` }, '⏰ ', hoursText(hrs));
    }
    return null;
  };

  const absenceBanner = (absence, person) => {
    const label = ABSENCE_TYPES[absence.absence_type] || absence.absence_type;
    const range = absence.start_date === absence.end_date
      ? fmtDate(fromISO(absence.start_date))
      : `${fmtDate(fromISO(absence.start_date))} – ${fmtDate(fromISO(absence.end_date))}`;
    return h(admin ? 'button' : 'div', {
      class: `absence absence-${absence.absence_type}`,
      title: `${person.name}: ${label} (${range})${absence.notes ? ` — ${absence.notes}` : ''}`,
      type: admin ? 'button' : false,
      onclick: admin ? () => editAbsence({ ctx, person, absence, onSaved: reload }) : false,
    }, label, absence.notes ? h('span', { class: 'absence-note' }, absence.notes) : null);
  };

  const chip = (a, person, absence, iso) => {
    const pump = ctx.pump(a);
    const task = data.taskById.get(a.task_id);
    const type = data.typeById.get(a.build_type_id);
    const equip = data.equipmentById.get(a.equipment_id);
    const bg = ctx.isBg(a);
    const time = timeLabel(a, iso);
    const continuing = iso !== a.work_date;
    const warnings = warningsOf(a, person, iso);
    const notes = ctx.breakNotes(a, person.name, iso);
    const part = ctx.partInfo(a);
    const label = [pump, type?.name, task?.name, a.qty_target != null ? a.qty_target : null].filter((x) => x != null).join(' · ');
    return h('button', {
      type: 'button',
      class: `chip ${bg ? 'chip-bg' : 'chip-att'} ${continuing ? 'chip-cont' : ''} ${warnings.length ? 'chip-warn' : ''} ${notes.length ? 'chip-note' : ''} ${a.any_pump ? 'chip-any' : ''}`,
      style: type ? `--type-color:${type.color}` : false,
      title: [label, bg ? 'Runs in the background (unattended)' : 'Attended — the person works on this', time,
        equip ? `Equipment: ${ctx.equipmentLabel(equip.id)}` : null, a.recurring_id ? 'Recurring job' : null, a.notes,
        ...warnings.map((w) => `⚠ ${w}`), ...notes.map((w) => `⏰ ${w}`)].filter(Boolean).join('\n'),
      onclick: () => openJob(a, person),
    },
      bg ? h('span', { class: 'bg-badge' }, h('span', { 'aria-hidden': 'true' }, '⏱'), ' Background') : null,
      time ? h('b', { class: 'chip-time chip-when' }, time) : null,
      h('span', { class: 'chip-line' },
        warnings.length ? h('span', { class: 'chip-warn-icon', 'aria-label': 'Warning' }, '!') : null,
        notes.length ? h('span', { class: 'chip-note-icon', 'aria-label': 'Runs across a break', title: notes.join(' ') }, '⏰') : null,
        a.recurring_id ? h('span', { class: 'chip-repeat', 'aria-label': 'Recurring job', title: 'Recurring job' }, '🔁') : null,
        pump ? h('span', { class: 'chip-model' }, pump) : null,
        type ? typeTag(type) : null,
        h('span', { class: 'chip-task' }, task?.name ?? '?'),
        a.qty_target != null && !continuing && !(part && part.n > 1) ? h('span', { class: 'chip-qty' }, `× ${a.qty_target}`) : null,
      ),
      equip || part ? h('span', { class: 'chip-meta' }, part ? h('span', { class: 'part-tag', title: `Continued job: part ${part.n} of ${part.total}` }, `↪ part ${part.n} of ${part.total}`) : null,
        equip ? h('span', { class: 'equip-tag' }, equip.name) : null) : null,
      a.notes && !continuing && !(part && part.n > 1) ? h('span', { class: 'chip-notes' }, a.notes) : null,
    );
  };

  // ---- test capacity per day
  const capPills = (iso, { graph = true } = {}) => {
    const c = ctx.capDay(iso);
    const usual = personDay({ jobs: [], iso, isBg: () => false, hours: data.workHours.defaultFor(iso) });
    const win = viewRange(usual);
    const span = (x) => `${fmtMin(x[0])}–${fmtMin(x[1])}`;
    const pills = c.areas.filter((a, i) => i === 0 || a.peak > 0 || a.untimed.length).map((a) => {
      if (a.sequential) {
        // one at a time: a short "Bench busy / 13:30–17:00"; pumps and minutes per pump go in the popover
        const over = a.peak > 1;
        const name = a.label.replace(/ test bench$/i, '').replace(/^Medicare \/ Mediflex$/i, 'Bench') || 'Bench';
        const short = name === 'Bench' ? 'Bench' : `${name} bench`;
        const lines = a.batches.map((b) => `${fmtMin(b.s)}–${fmtMin(b.e)} · ${ctx.pump(b.job) || 'Pumps'}${b.pumps ? ` · ${b.pumps} pumps` : ''}${b.perPump ? ` · ~${b.perPump} min each` : ''}`);
        const tip = `${a.label} — one pump at a time.\n${lines.join('\n') || 'Free all day'}${over ? `\n⚠ ${a.peak} jobs overlap at ${a.at}` : ''}`;
        const pill = h('span', {
          class: `cap-pill cap-seq ${over ? 'cap-over' : a.busy.length ? 'cap-busy' : 'cap-ok'}`,
          title: graph ? false : tip,
          'aria-label': tip.replace(/\n/g, '. '),
        },
          h('span', { class: 'cap-pill-l' }, a.busy.length ? `${short} busy` : `${short} free`), ' ',
          a.busy.length ? h('span', { class: 'cap-pill-t' }, a.busy.map(span).join(', ')) : null,
          over ? ' ' : null, over ? h('span', { class: 'cap-pill-t cap-pill-warn' }, `⚠ ${a.peak} overlap ${a.at}`) : null);
        if (!graph) return pill;
        return h('span', { class: 'cap-wrap', tabindex: 0 }, pill,
          h('div', { class: 'cap-pop', role: 'tooltip' },
            h('div', { class: 'cap-pop-title' }, `${a.label} — one pump at a time`),
            lines.length ? h('ul', { class: 'cap-pop-list' }, lines.map((l) => h('li', {}, l))) : h('div', { class: 'cap-pop-text' }, 'Free all day'),
            over ? h('div', { class: 'cap-pop-text cap-pop-warn' }, `⚠ ${a.peak} jobs overlap at ${a.at}`) : null));
      }
      const lv = level(a.peak, a.max);
      const wrap = h('span', { class: 'cap-wrap', tabindex: graph ? 0 : false },
        h('span', {
          class: `cap-pill cap-${lv}`,
          title: graph ? false : `${a.label} (${a.area.name}): peak ${a.peak} of ${a.max}${a.at && a.peak ? ` at ${a.at}` : ''}\n${occupancyText(a.series)}`,
        }, h('span', { class: 'cap-pill-l' }, `${a.label} ${a.peak}/${a.max}`), a.peak ? ' ' : null, a.peak ? h('span', { class: 'cap-pill-t' }, a.at) : null),
        graph && a.peak ? h('span', { class: 'cap-spark', 'aria-hidden': 'true' }, occupancySvg(a.series, { max: a.max, ...win, height: 16 })) : null,
        graph ? occupancyPopover(a, win) : null);
      return wrap;
    });
    for (const l of c.limits.filter((x) => x.peak > x.max)) {
      pills.push(h('span', { class: 'cap-pill cap-over', title: `${l.limit.name}: ${l.peak} of ${l.max} at ${l.at}` }, h('span', { class: 'cap-pill-l' }, `${l.limit.name} ${l.peak}/${l.max}`), ' ', h('span', { class: 'cap-pill-t' }, l.at)));
    }
    if (c.untimed.length) {
      pills.push(h('span', {
        class: 'cap-pill cap-near cap-untimed',
        title: `Not counted — no times set:\n${c.untimed.map((u) => `• ${jobText(ctx, u.job)} (${personById.get(u.job.person_id)?.name || '—'})`).join('\n')}\nAdd start and end times so they count in the peak.`,
      }, h('span', { class: 'cap-pill-l' }, `⚠ ${c.untimed.length} untimed`), ' ', h('span', { class: 'cap-pill-t' }, 'add times')));
    }
    const detail = [...c.limits.map((l) => `${l.limit.name}: peak ${l.peak}/${l.max}${l.peak ? ` at ${l.at}` : ''}`),
      ...[...c.models.values()].map((m) => `${m.name}: ${m.peak} at ${m.at}`)].join('\n');
    return h('div', { class: 'cap-cell', title: graph ? false : detail }, pills.length ? pills : h('span', { class: 'muted small' }, '—'));
  };
  const hasAreas = data.capacity.areas.length > 0;

  // ---- toolbar
  const weekLabel = `Week ${isoWeek(monday)} · ${fmtRange(days[0], days[4])}`;
  const isThisWeek = toISO(mondayOf(today())) === toISO(monday);
  const toolbar = h('div', { class: 'planner-toolbar' },
    h('div', { class: 'week-nav' },
      h('button', { class: 'btn btn-sm', 'aria-label': 'Previous week', onclick: () => goToWeek(addDays(monday, -7), view, dayIdx) }, '‹ Prev'),
      h('button', { class: 'btn btn-sm', disabled: isThisWeek, onclick: () => (view === 'day' ? (location.hash = planHash({ view, day: today().getDay() % 6 ? todayISO : toISO(mondayOf(today())) })) : goToWeek(mondayOf(today()))) }, 'This week'),
      h('button', { class: 'btn btn-sm', 'aria-label': 'Next week', onclick: () => goToWeek(addDays(monday, 7), view, dayIdx) }, 'Next ›'),
      h('h2', { class: 'week-label' }, weekLabel),
    ),
    h('div', { class: 'seg view-toggle', role: 'group', 'aria-label': 'View' },
      h('a', { class: `seg-btn ${view === 'week' ? 'active' : ''}`, href: planHash({ week: monday, view: 'week' }), 'aria-current': view === 'week' ? 'true' : false }, 'Week'),
      h('a', { class: `seg-btn ${view === 'day' ? 'active' : ''}`, href: planHash({ view: 'day', day: viewDay }), 'aria-current': view === 'day' ? 'true' : false }, 'Day timeline'),
    ),
    h('div', { class: 'planner-actions' },
      view === 'week' ? h('button', { class: 'btn btn-sm', onclick: () => document.getElementById('weekly-summary')?.scrollIntoView({ behavior: 'smooth' }) }, 'Summary ↓') : null,
      h('button', { class: 'btn btn-sm', title: `Print this ${view === 'day' ? 'day' : 'week'} on A4 landscape`, onclick: () => window.print() }, 'Print'),
      h('button', { class: 'btn btn-sm', title: 'Download a spreadsheet: timesheet, absences, summaries, test capacity', onclick: () => openExport({ weekMonday: monday }) }, 'Export to Excel'),
      admin && view === 'week' ? h('button', { class: 'btn btn-sm', onclick: () => copyLastWeek({ ctx, monday, rows, onDone: reload }) }, 'Copy last week') : null,
    ),
  );

  const printHeader = h('div', { class: 'print-only print-header' },
    h('div', {},
      h('div', { class: 'print-title' }, view === 'day' ? `Pump Room Day Plan — ${fmtDayLong(fromISO(viewDay))}` : `Pump Room Plan — ${weekLabel}`),
      hours ? h('div', { class: 'print-sub' },
        `Hours ${hhmm(hours.work_start)}–${hhmm(hours.work_end)} · Break ${hhmm(hours.break_time)} · Lunch ${hhmm(hours.lunch_time)}${view === 'day' ? ' · green = free time' : ''}`) : null,
    ),
    h('div', { class: 'print-sub print-right' }, 'Meditec Medical Ltd', h('br'),
      `Printed ${fmtDate(new Date())} by ${auth.profile?.full_name || auth.profile?.email || ''}`),
  );

  const legend = h('div', { class: 'legend' },
    h('span', { class: 'muted small' }, 'Build types:'),
    data.types.filter((t) => t.active).map(typeTag),
    h('span', { class: 'legend-sep', 'aria-hidden': 'true' }),
    h('span', { class: 'legend-att' }, 'Attended job'),
    h('span', { class: 'legend-bg' }, h('span', { 'aria-hidden': 'true' }, '⏱'), ' Background · unattended'),
    h('span', { class: 'legend-sep', 'aria-hidden': 'true' }),
    h('span', { class: 'muted small' }, h('b', { class: 'chip-warn-icon' }, '!'), ' warning · 🔁 recurring'),
  );

  // ---- desktop grid
  const grid = rows.length
    ? h('div', { class: 'table-scroll planner-grid' },
        h('table', { class: 'planner' },
          h('thead', {}, h('tr', {},
            h('th', { class: 'sticky-col', scope: 'col' }, 'Person'),
            days.map((d, i) => h('th', { scope: 'col', class: isoDays[i] === todayISO ? 'is-today' : '' }, fmtDayShort(d))),
          )),
          h('tbody', {},
            hasAreas ? h('tr', { class: 'cap-row' },
              h('th', { class: 'sticky-col', scope: 'row' }, 'Test capacity', h('div', { class: 'muted small' }, 'peak pumps on test')),
              isoDays.map((iso) => h('td', { class: `day-cell ${iso === todayISO ? 'is-today' : ''}` }, capPills(iso)))) : null,
            rows.map((p) => h('tr', { class: p.active ? '' : 'inactive', 'data-person': p.id },
              h('th', { class: 'sticky-col person-cell', scope: 'row' },
                h('div', { class: 'person-name' }, p.name, p.active ? null : h('span', { class: 'tag tag-muted' }, 'inactive')),
                p.job_title ? h('div', { class: 'muted small' }, p.job_title) : null,
              ),
              isoDays.map((iso) => h('td', { class: `day-cell ${iso === todayISO ? 'is-today' : ''} ${ctx.hoursFor(p.id, iso).works ? '' : 'is-offday'}` }, cell(p, iso))),
            ))),
        ))
    : h('div', { class: 'empty' }, admin ? 'Add team members on the People page to start planning.' : 'No team members yet.');

  // ---- phone view: one day at a time
  const dayTabs = h('div', { class: 'day-tabs', role: 'tablist' }, days.map((d, i) =>
    h('button', {
      role: 'tab', 'aria-selected': String(i === mobileDay),
      class: `day-tab ${i === mobileDay ? 'active' : ''} ${isoDays[i] === todayISO ? 'is-today' : ''}`,
      onclick: () => { mobileDay = i; reload(); },
    }, h('span', {}, fmtWeekday(d)), h('span', { class: 'day-num' }, d.getDate())),
  ));
  const phone = h('div', { class: 'planner-phone' },
    dayTabs,
    h('h3', { class: 'phone-day-title' }, fmtDayLong(days[mobileDay])),
    hasAreas ? h('div', { class: 'phone-cap' }, h('span', { class: 'muted small' }, 'Test capacity: '), capPills(isoDays[mobileDay])) : null,
    rows.length
      ? rows.map((p) => h('div', { class: 'phone-person card' },
          h('div', { class: 'person-name' }, p.name, p.job_title ? h('span', { class: 'muted small' }, ` · ${p.job_title}`) : null),
          cell(p, isoDays[mobileDay]),
        ))
      : h('div', { class: 'empty' }, 'No team members yet.'),
  );

  if (view === 'day') {
    mount(main,
      printHeader,
      h('div', { class: 'page-head no-print' }, h('h1', { class: 'page-title' }, 'Day timeline')),
      toolbar,
      panel,
      recurringPanel(ctx, personById, reload),
      dayView({ ctx, rows, iso: viewDay, isoDays, days, todayISO, admin, hasAreas, capPills, openJob, warningsOf, edit }),
    );
    return;
  }
  mount(main,
    printHeader,
    h('div', { class: 'page-head no-print' }, h('h1', { class: 'page-title' }, 'Week planner')),
    toolbar,
    panel,
    recurringPanel(ctx, personById, reload),
    legend,
    h('section', { class: 'card card-flush planner-desktop' }, grid),
    phone,
    summaryCard({ monday, data: ctx, notes: summaryDemand.notes, weekLabel }),
  );
}

// ------------------------------------------------------------------ Day timeline view
function dayView({ ctx, rows, iso, isoDays, days, todayISO, admin, hasAreas, capPills, openJob, warningsOf, edit }) {
  const isToday = iso === todayISO;
  const go = (d) => { location.hash = planHash({ view: 'day', day: d }); };
  const nav = h('div', { class: 'day-nav' },
    h('button', { class: 'btn btn-sm', 'aria-label': 'Previous day', onclick: () => go(stepWorkday(iso, -1)) }, '‹'),
    h('div', { class: 'day-tabs day-tabs-inline', role: 'tablist' }, days.map((d, i) => h('button', {
      role: 'tab', 'aria-selected': String(isoDays[i] === iso),
      class: `day-tab ${isoDays[i] === iso ? 'active' : ''} ${isoDays[i] === todayISO ? 'is-today' : ''}`,
      onclick: () => go(isoDays[i]),
    }, h('span', {}, fmtWeekday(d)), h('span', { class: 'day-num' }, d.getDate())))),
    h('button', { class: 'btn btn-sm', 'aria-label': 'Next day', onclick: () => go(stepWorkday(iso, 1)) }, '›'),
    h('h2', { class: 'week-label' }, fmtDayLong(fromISO(iso))),
    isoDays.includes(todayISO) && !isToday ? h('button', { class: 'btn btn-sm btn-ghost', onclick: () => go(todayISO) }, 'Today') : null,
  );
  const legend = h('div', { class: 'legend dt-legend' },
    h('span', { class: 'lg lg-job' }, 'Attended job'),
    h('span', { class: 'lg lg-bg' }, '⏱ Background (person not busy)'),
    h('span', { class: 'lg lg-free' }, 'Free time'),
    h('span', { class: 'lg lg-break' }, 'Break / lunch'),
    admin ? h('span', { class: 'muted small no-print' }, 'Click a green gap to add a job at that time.') : null,
  );
  if (!rows.length) return h('section', { class: 'card' }, nav, h('div', { class: 'empty' }, 'No team members yet.'));
  const tl = dayTimeline({
    ctx, rows, iso, isToday, admin, capacity: ctx.capDay(iso),
    onJob: openJob,
    onFree: (person, s, e) => edit({ person, iso, times: { start: fmtMin(s), end: fmtMin(e) } }),
    warningsOf: (a, p) => warningsOf(a, p, iso),
    notesOf: (a, p) => ctx.breakNotes(a, p.name, iso),
  });
  const card = h('section', { class: 'card card-flush day-timeline' },
    h('div', { class: 'dt-top no-print' }, nav),
    hasAreas ? h('div', { class: 'dt-cap' }, h('span', { class: 'muted small' }, 'Test capacity: '), capPills(iso, { graph: false })) : null,
    legend,
    tl.el);
  requestAnimationFrame(() => {
    const d = new Date(); const m = d.getHours() * 60 + d.getMinutes();
    const day = ctx.dayOf(rows[0].id, iso);
    tl.scrollTo(isToday && m > day.ws && m < day.we ? m - 60 : day.ws - 30);
  });
  if (isToday) {
    const tick = () => { const d = new Date(); tl.placeNow(d.getHours() * 60 + d.getMinutes()); };
    requestAnimationFrame(tick);
    clearInterval(nowTimer);
    nowTimer = setInterval(() => { if (!card.isConnected) { clearInterval(nowTimer); return; } tick(); }, 30000);
  }
  return card;
}

export function typeTag(type) {
  return h('span', { class: 'type-tag', style: `--type-color:${type.color}` }, type.name);
}

// ------------------------------------------------------------------ recurring panel
function recurringPanel(ctx, personById, reload) {
  const list = ctx.recurring;
  if (!list.length && !auth.isAdmin) return null;
  const unassigned = list.filter((r) => !r.person_id);
  const open = recurringOpen ?? unassigned.length > 0;
  const body = h('div', { class: 'panel-body', hidden: !open },
    list.length
      ? h('ul', { class: 'demand-rows recurring-rows' }, list.map((r) => {
          const task = ctx.taskById.get(r.task_id);
          const person = personById.get(r.person_id);
          const type = ctx.typeById.get(r.build_type_id);
          const name = r.title || task?.name || 'Recurring job';
          const hasJobs = Boolean(r.person_id);
          let times;
          if (auth.isAdmin) {
            const st = h('input', { type: 'time', step: 300, value: hm(r.start_time) ?? '', 'aria-label': `Start time for ${name}` });
            const et = h('input', { type: 'time', step: 300, value: hm(r.end_time) ?? '', 'aria-label': `End time for ${name}` });
            const save = h('button', { class: 'btn btn-sm btn-primary', hidden: true,
              onclick: () => saveTemplateTimes({ template: r, start: st.value, end: et.value, hasJobs, onSaved: reload }) }, 'Save times');
            const changed = () => { save.hidden = st.value === (hm(r.start_time) ?? '') && et.value === (hm(r.end_time) ?? ''); };
            st.addEventListener('input', changed); et.addEventListener('input', changed);
            times = h('div', { class: 'recurring-times' },
              h('span', { class: 'rt-label' }, 'Time'), st, h('span', { 'aria-hidden': 'true' }, '→'), et, save,
              !r.start_time ? h('span', { class: 'rt-hint' }, 'not set — all day') : null);
          } else {
            times = h('span', { class: 'muted small' }, r.start_time ? `${hm(r.start_time)}–${hm(r.end_time) || '…'}` : 'All day');
          }
          return h('li', {}, h('div', { class: 'recurring-row' },
            h('div', { class: 'demand-row-main' },
              h('span', { 'aria-hidden': 'true' }, '🔁'),
              h('b', {}, name),
              h('span', {}, ctx.pump(r) || ''),
              type ? typeTag(type) : null,
              h('span', { class: 'muted small' }, describeRepeat(r)),
            ),
            times,
            h('div', { class: 'demand-badges' },
              person ? h('span', { class: 'status status-planned' }, person.name) : h('span', { class: 'status status-unassigned' }, 'Not assigned yet'),
              auth.isAdmin ? h('button', { class: `btn btn-sm ${person ? '' : 'btn-primary'}`, onclick: () => editTemplate({ ctx, template: r, personById, onSaved: reload }) }, person ? 'Edit' : 'Assign…') : null,
              auth.isAdmin ? h('button', { class: 'btn btn-sm btn-ghost', onclick: () => deleteTemplate({ template: r, onDone: reload }) }, 'Stop') : null,
            )));
        }))
      : h('p', { class: 'muted small panel-empty' }, 'No recurring jobs yet. Use "Repeat" when adding work.'),
    auth.isAdmin ? h('div', { class: 'panel-foot' },
      h('button', { class: 'btn btn-sm', onclick: () => editTemplate({ ctx, template: null, personById, onSaved: reload }) }, '+ New recurring job'),
      h('span', { class: 'muted small' }, 'Jobs are created up to 12 weeks ahead and kept topped up automatically.'),
    ) : null,
  );
  const toggle = h('button', {
    class: 'panel-toggle', 'aria-expanded': String(open),
    onclick: () => { recurringOpen = body.hidden; body.hidden = !body.hidden; toggle.setAttribute('aria-expanded', String(!body.hidden)); },
  },
    h('span', { class: 'panel-caret', 'aria-hidden': 'true' }, '▸'),
    h('span', { class: 'panel-title' }, `🔁 Recurring jobs (${list.length})`),
    unassigned.length ? h('span', { class: 'due due-soon' }, `${unassigned.length} waiting for a person`) : null,
  );
  return h('section', { class: 'card demand-panel recurring-panel no-print' }, toggle, body);
}

// ------------------------------------------------------------------ view (viewer)
function showAssignment(ctx, a, person, warnings) {
  const task = ctx.taskById.get(a.task_id);
  const type = ctx.typeById.get(a.build_type_id);
  const r = a.recurring_id ? ctx.recurringById.get(a.recurring_id) : null;
  openModal({
    title: `${person.name} · ${fmtDayLong(fromISO(a.work_date))}`,
    body: h('div', { class: 'stack' },
      h('dl', { class: 'details' },
        h('dt', {}, 'Task'), h('dd', {}, task?.name ?? '—'),
        h('dt', {}, 'Pump'), h('dd', {}, ctx.pump(a) ?? '—'),
        h('dt', {}, 'Build type'), h('dd', {}, type ? typeTag(type) : '—'),
        h('dt', {}, 'Quantity'), h('dd', {}, a.qty_target ?? '—'),
        h('dt', {}, 'Time'), h('dd', {}, timeLabel(a, a.work_date) || 'All day'),
        h('dt', {}, 'Runs'), h('dd', {}, ctx.isBg(a) ? '⏱ In the background (unattended)' : 'Attended'),
        h('dt', {}, 'Equipment'), h('dd', {}, ctx.equipmentById.get(a.equipment_id)?.name ?? '—'),
        a.recurring_id ? [h('dt', {}, 'Repeats'), h('dd', {}, `🔁 ${r ? describeRepeat(r) : 'Recurring job'}`)] : null,
        h('dt', {}, 'Notes'), h('dd', { class: 'pre' }, a.notes || '—'),
      ),
      warnings.map((w) => h('p', { class: 'warn-box' }, `⚠ ${w}`)),
    ),
    actions: [{ label: 'Close' }],
  });
}

// ------------------------------------------------------------------ absences
function editAbsence({ person, iso, absence, onSaved }) {
  const typeSel = h('select', {}, Object.entries(ABSENCE_TYPES).map(([k, v]) => {
    const o = h('option', { value: k }, v);
    if (k === (absence?.absence_type ?? 'holiday')) o.selected = true;
    return o;
  }));
  const start = h('input', { type: 'date', value: absence?.start_date ?? iso, required: true });
  const end = h('input', { type: 'date', value: absence?.end_date ?? iso, required: true });
  start.addEventListener('change', () => { if (end.value < start.value) end.value = start.value; });
  const notes = h('input', { type: 'text', maxlength: 200, value: absence?.notes ?? '', placeholder: 'e.g. booked holiday, first-aid course' });
  const error = h('p', { class: 'form-error', role: 'alert' });

  const actions = [];
  if (absence) {
    actions.push({
      label: 'Delete',
      variant: 'danger',
      onClick: async () => {
        if (!(await confirmDialog('Remove absence?', `Remove this absence for ${person.name}?`, 'Remove'))) return false;
        const { error: err } = await supabase.from('absences').delete().eq('id', absence.id);
        if (reportError(err, 'Removing')) return false;
        // Recurring jobs skipped for this absence come back on the next refresh.
        extendedOn = null;
        toast('Absence removed.', 'success');
        onSaved();
        return true;
      },
    });
  }
  actions.push({ label: 'Cancel' }, {
    label: 'Save',
    variant: 'primary',
    onClick: async () => {
      if (!start.value || !end.value) { error.textContent = 'Please choose the dates.'; return false; }
      if (end.value < start.value) { error.textContent = 'The end date is before the start date.'; return false; }
      const values = { person_id: person.id, absence_type: typeSel.value, start_date: start.value, end_date: end.value, notes: notes.value.trim() || null };
      const { count } = await supabase.from('assignments').select('id', { count: 'exact', head: true })
        .eq('person_id', person.id).gte('work_date', start.value).lte('work_date', end.value);
      if (count) {
        const ok = await confirmDialog('Work already planned',
          `${person.name} has ${count} job${count === 1 ? '' : 's'} planned in this period. They will be flagged with ⚠ so you can move them. Save the absence?`,
          'Save absence', 'primary');
        if (!ok) return false;
      }
      const { error: err } = absence
        ? await supabase.from('absences').update(values).eq('id', absence.id)
        : await supabase.from('absences').insert(values);
      if (reportError(err, 'Saving absence')) return false;
      toast('Absence saved.', 'success');
      onSaved();
      return true;
    },
  });

  openModal({
    title: `${absence ? 'Edit' : 'Mark'} absence · ${person.name}`,
    body: h('div', { class: 'stack' },
      field('Type', typeSel),
      h('div', { class: 'form-grid form-grid-2' }, field('From', start), field('To (inclusive)', end)),
      field('Notes', notes),
      error,
    ),
    actions,
  });
}

// ------------------------------------------------------------------ copy last week
async function copyLastWeek({ ctx, monday, rows, onDone }) {
  const prevFrom = toISO(addDays(monday, -7));
  const prevTo = toISO(addDays(monday, -3));
  const { data: prev, error } = await supabase.from('assignments')
    .select('person_id, work_date, pump_model_id, any_pump, pump_mix, task_id, build_type_id, qty_target, notes, background, start_time, end_time, end_date, equipment_id, recurring_id')
    .gte('work_date', prevFrom).lte('work_date', prevTo).order('created_at');
  if (reportError(error, 'Loading last week')) return;
  if (!prev.length) { toast('Last week has nothing planned to copy.'); return; }

  const activePerson = new Set(rows.filter((p) => p.active).map((p) => p.id));
  const isActive = (map, id) => !id || map.get(id)?.active;
  const copies = [];
  let skippedAbsent = 0;
  let skippedInactive = 0;
  let skippedRecurring = 0;
  for (const a of prev) {
    if (a.recurring_id) { skippedRecurring++; continue; } // recurring jobs repeat by themselves
    const date = toISO(addDays(fromISO(a.work_date), 7));
    if (!activePerson.has(a.person_id) || !isActive(ctx.modelById, a.pump_model_id)
        || !isActive(ctx.taskById, a.task_id) || !isActive(ctx.typeById, a.build_type_id)
        || !isActive(ctx.equipmentById, a.equipment_id)) { skippedInactive++; continue; }
    if (ctx.absenceOn(a.person_id, date)) { skippedAbsent++; continue; }
    const { recurring_id: _r, ...rest } = a;
    copies.push({ ...rest, work_date: date, end_date: a.end_date ? toISO(addDays(fromISO(a.end_date), 7)) : null });
  }

  const existing = ctx.assignments.filter((a) => a.work_date >= toISO(monday) && !a.recurring_id).length;
  const parts = [`Copy ${copies.length} job${copies.length === 1 ? '' : 's'} from last week into this week (same people, days and quantities).`];
  if (existing) parts.push(`This week already has ${existing} job${existing === 1 ? '' : 's'}; the copies are added alongside them.`);
  if (skippedRecurring) parts.push(`${skippedRecurring} recurring job${skippedRecurring === 1 ? ' is' : 's are'} not copied — they repeat by themselves.`);
  if (skippedAbsent) parts.push(`${skippedAbsent} skipped because the person is absent.`);
  if (skippedInactive) parts.push(`${skippedInactive} skipped because a person, pump model, task, build type or equipment is inactive.`);
  if (!copies.length) { toast(parts.slice(1).join(' ') || 'Nothing to copy.'); return; }

  if (!(await confirmDialog('Copy last week?', parts.join(' '), 'Copy', 'primary'))) return;
  const { error: err } = await supabase.from('assignments').insert(copies);
  if (reportError(err, 'Copying')) return;
  toast(`Copied ${copies.length} job${copies.length === 1 ? '' : 's'}.`, 'success');
  onDone();
}
