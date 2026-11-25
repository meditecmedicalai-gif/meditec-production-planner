// Test capacity: how many pumps are on test at the same time.
//
// Which test area a job counts towards:
//  1. Booked on a STATION (equipment) linked to a test area → that area, for
//     any task, as long as it has a quantity (= pumps).
//  2. Otherwise: a "testing" task + the pump model's default test area.
// Its time span comes from the job timing rules (whole day, overnight,
// multi-day — see jobs.js), and background jobs count like any other.
// Limit groups (e.g. MediAir + Simplex 6) apply within their own area.
//
// Inside an area, tasks marked as sharing pumps (e.g. calibration + quality
// testing on Medicare / Mediflex) run on the SAME pump at the same time: for the
// same pump model they count as the largest of them, not the sum. Different
// models are different pumps and do add up.
//
// Each area's maximum is absolute for that area (Quality Check: 7). Areas are
// separate — there is no limit across areas.
//
// Capacity is the PEAK at any one moment, never a daily total: 7 in the
// morning that finish at 11:00 and 7 more from 11:00 is 7/7. Intervals are
// [start, end), so a job ending at 11:00 and one starting at 11:00 don't meet.
//
// Capacity mode per area:
//   simultaneous — pumps on test at the same moment add up (Quality Check);
//   sequential   — one pump at a time (Medicare / Mediflex bench): a job is a
//                  batch processed pump by pump, so it counts as 1 whatever its
//                  quantity; only overlapping jobs are flagged.
//
// Jobs without a start time are NOT counted in the peak (we can't know when
// they run); they are listed as "untimed" so their times can be added.
import { intervalOf } from './jobs.js';

/** Build the lookup structure from loaded rows. */
export function capacityConfig({ areas = [], limits = [], limitModels = [], sharedTasks = [], models = [], tasks = [], equipment = [] }) {
  const modelArea = new Map(models.filter((m) => m.test_area_id).map((m) => [m.id, m.test_area_id]));
  const stationArea = new Map(equipment.filter((e) => e.test_area_id).map((e) => [e.id, e.test_area_id]));
  const areaStations = new Map();
  for (const e of equipment.filter((x) => x.test_area_id && x.active !== false)) {
    if (!areaStations.has(e.test_area_id)) areaStations.set(e.test_area_id, []);
    areaStations.get(e.test_area_id).push(e.name);
  }
  const shared = new Map();
  for (const s of sharedTasks) {
    if (!shared.has(s.test_area_id)) shared.set(s.test_area_id, new Set());
    shared.get(s.test_area_id).add(s.task_id);
  }
  const limitSets = limits.filter((l) => l.active).map((l) => ({
    ...l, models: new Set(limitModels.filter((x) => x.test_limit_id === l.id).map((x) => x.pump_model_id)),
  }));
  return {
    areas: areas.filter((a) => a.active),
    areaById: new Map(areas.map((a) => [a.id, a])),
    limits: limitSets,
    shared,
    modelArea,
    stationArea,
    areaStations,
    stationName: new Map(equipment.map((e) => [e.id, e.name])),
    modelName: new Map(models.map((m) => [m.id, m.short_code || m.name])),
    testing: new Set(tasks.filter((t) => t.is_testing).map((t) => t.id)),
  };
}

/** The test area a job counts towards, or null. */
export function testAreaOf(j, cfg) {
  if ((j.qty_target || 0) <= 0) return null;
  const station = j.equipment_id && cfg.stationArea.get(j.equipment_id);
  if (station) return station;
  if (cfg.testing.has(j.task_id) && j.pump_model_id && cfg.modelArea.has(j.pump_model_id)) return cfg.modelArea.get(j.pump_model_id);
  return null;
}
export const isTestingJob = (j, cfg) => Boolean(testAreaOf(j, cfg));

/** Name shown for an area: its station(s), else the area name. */
export const areaLabel = (area, cfg) => cfg.areaStations.get(area.id)?.join(' / ') || area.name;

/** Warning when a pump is booked on a station belonging to another test area. */
export function stationMismatch(j, cfg) {
  const station = j.equipment_id && cfg.stationArea.get(j.equipment_id);
  const home = j.pump_model_id && cfg.modelArea.get(j.pump_model_id);
  if (!station || !home || station === home) return null;
  const model = cfg.modelName.get(j.pump_model_id) || 'This pump';
  const homeArea = cfg.areaById.get(home);
  return `${model} belongs on ${homeArea ? `the ${areaLabel(homeArea, cfg)}` : 'another test area'}, but is booked on the ${cfg.stationName.get(j.equipment_id)} station.`;
}

export const isSequential = (area) => area?.capacity_mode === 'sequential';

/**
 * Can several jobs use this station / equipment at the same time?
 *  - linked to a test area: yes when the area is "Simultaneous" (e.g. Quality Check, up to 7 pumps —
 *    only the area / per-model limits warn); no when it is "One at a time" (Medicare / Mediflex bench);
 *  - not linked: its own "Can be shared" setting (default no).
 */
export function equipmentShared(eq, cfg) {
  if (!eq) return false;
  const area = eq.test_area_id && cfg?.areaById?.get(eq.test_area_id);
  if (area) return !isSequential(area);
  return Boolean(eq.shareable);
}

/** Pumps on test among `active` jobs that pass `keep` (shared tasks count once per area and pump model). */
function count(active, cfg, keep) {
  let total = 0;
  const sharedMax = new Map();
  for (const j of active) {
    if (!keep(j)) continue;
    const area = testAreaOf(j, cfg);
    const q = isSequential(cfg.areaById.get(area)) ? 1 : (j.qty_target || 0);
    const key = `${area}|${j.pump_model_id}`;
    if (cfg.shared.get(area)?.has(j.task_id)) sharedMax.set(key, Math.max(sharedMax.get(key) || 0, q));
    else total += q;
  }
  for (const v of sharedMax.values()) total += v;
  return total;
}

const hhmmOf = (minutesSinceEpoch) => {
  const d = new Date(minutesSinceEpoch * 60000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/**
 * Peaks within [from, to) (minutes since epoch, as from intervalOf).
 * Returns { areas[], limits[], models: Map, jobMsgs: Map(jobId -> [messages]) }.
 */
export function capacityInWindow(jobs, cfg, from, to) {
  const tj = [];
  const untimed = [];
  for (const j of jobs) {
    if (!isTestingJob(j, cfg)) continue;
    const [s, e] = intervalOf(j);
    if (!(e > from && s < to)) continue;
    if (!j.start_time) { untimed.push({ job: j, area: testAreaOf(j, cfg) }); continue; }
    // attended multi-day jobs: only the working hours of each day (cfg.segmentsOf, set by the planner)
    for (const [ss, se] of cfg.segmentsOf ? cfg.segmentsOf(j) : [[s, e]]) {
      if (se > from && ss < to) tj.push({ j, s: Math.max(ss, from), e: Math.min(se, to) });
    }
  }
  const pts = [...new Set([from, ...tj.map((x) => x.s), ...tj.map((x) => x.e)])].filter((p) => p >= from && p < to).sort((a, b) => a - b);

  const areas = cfg.areas.map((a) => {
    const seq = isSequential(a);
    const mine = tj.filter((x) => testAreaOf(x.j, cfg) === a.id);
    // sequential: when the bench is in use, and the batches on it
    const busy = [];
    for (const x of [...mine].sort((p, q) => p.s - q.s)) {
      const last = busy.at(-1);
      if (last && x.s <= last[1]) last[1] = Math.max(last[1], x.e); else busy.push([x.s, x.e]);
    }
    return {
      area: a, label: areaLabel(a, cfg), peak: 0, at: null, max: seq ? 1 : a.max_pumps, sequential: seq,
      series: [], busy: busy.map(([s, e]) => [s - from, e - from]),
      batches: mine.map((x) => ({ job: x.j, s: x.s - from, e: x.e - from, pumps: x.j.qty_target || 0,
        perPump: x.j.qty_target > 0 ? Math.round((x.e - x.s) / x.j.qty_target) : null })),
      untimed: untimed.filter((u) => u.area === a.id).map((u) => u.job),
    };
  });
  const limits = cfg.limits.map((l) => ({ limit: l, area: cfg.areaById.get(l.test_area_id), peak: 0, at: null, max: l.max_pumps }));
  const models = new Map();
  const jobMsgs = new Map();
  const flag = (active, keep, msg) => {
    for (const j of active) {
      if (!keep(j)) continue;
      const key = j.id ?? j;
      if (!jobMsgs.has(key)) jobMsgs.set(key, []);
      if (!jobMsgs.get(key).includes(msg)) jobMsgs.get(key).push(msg);
    }
  };

  for (const p of pts) {
    const active = tj.filter((x) => x.s <= p && x.e > p).map((x) => x.j);
    const at = hhmmOf(p);
    if (!active.length) {
      for (const a of areas) if (a.series.length && a.series.at(-1).n !== 0) a.series.push({ t: p - from, n: 0 });
      continue;
    }

    for (const a of areas) {
      const inArea = (j) => testAreaOf(j, cfg) === a.area.id;
      const n = count(active, cfg, inArea);
      if (n > a.peak) Object.assign(a, { peak: n, at });
      if (a.series.at(-1)?.n !== n) a.series.push({ t: p - from, n });
      if (n > a.max) flag(active, inArea, a.sequential ? `${a.label}: ${n} jobs overlap at ${at} — one pump at a time` : `${a.label}: ${n}/${a.max} pumps at ${at}`);
    }
    for (const l of limits) {
      // limit groups apply within their own area
      const inLimit = (j) => l.limit.models.has(j.pump_model_id) && testAreaOf(j, cfg) === l.limit.test_area_id;
      const n = count(active, cfg, inLimit);
      if (n > l.peak) Object.assign(l, { peak: n, at });
      if (n > l.max) flag(active, inLimit, `${l.limit.name}: ${n}/${l.max} on test at ${at}`);
    }
    for (const m of new Set(active.map((j) => j.pump_model_id).filter(Boolean))) {
      const n = count(active, cfg, (j) => j.pump_model_id === m);
      const cur = models.get(m);
      if (!cur || n > cur.peak) models.set(m, { peak: n, at, name: cfg.modelName.get(m) });
    }
  }
  for (const a of areas) if (!a.series.length || a.series[0].t > 0) a.series.unshift({ t: 0, n: 0 });
  return { areas, limits, models, jobMsgs, untimed };
}

/** Capacity for one calendar day ("YYYY-MM-DD"). */
export function capacityForDay(jobs, cfg, iso) {
  const [from] = intervalOf({ work_date: iso });
  return capacityInWindow(jobs, cfg, from, from + 24 * 60);
}

/** Pumps on test at one moment (minutes since epoch). */
export function capacityAt(jobs, cfg, minute) {
  return capacityInWindow(jobs, cfg, minute, minute + 1);
}

/** "ok" | "near" | "over" for colouring. */
export const level = (peak, max) => (peak > max ? 'over' : peak >= max ? 'near' : 'ok');

/** Step series → "08:30–11:00: 7 · 11:00–13:30: 2 · 13:30–16:00: 7" (only times with pumps on test). */
export function occupancyText(series, end = 24 * 60) {
  const fmt = (m) => `${String(m >= 1440 ? 24 : Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const parts = [];
  series.forEach((x, i) => {
    if (!x.n) return;
    const until = series[i + 1]?.t ?? end;
    parts.push(`${fmt(x.t)}–${fmt(until)}: ${x.n}`);
  });
  return parts.join(' · ') || 'Nothing on test';
}
