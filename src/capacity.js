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

/** Pumps on test among `active` jobs that pass `keep` (shared tasks count once per area and pump model). */
function count(active, cfg, keep) {
  let total = 0;
  const sharedMax = new Map();
  for (const j of active) {
    if (!keep(j)) continue;
    const area = testAreaOf(j, cfg);
    const q = j.qty_target || 0;
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
  for (const j of jobs) {
    if (!isTestingJob(j, cfg)) continue;
    const [s, e] = intervalOf(j);
    if (e > from && s < to) tj.push({ j, s: Math.max(s, from), e: Math.min(e, to) });
  }
  const pts = [...new Set([from, ...tj.map((x) => x.s), ...tj.map((x) => x.e)])].filter((p) => p >= from && p < to).sort((a, b) => a - b);

  const areas = cfg.areas.map((a) => ({ area: a, label: areaLabel(a, cfg), peak: 0, at: null, max: a.max_pumps }));
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
    if (!active.length) continue;
    const at = hhmmOf(p);

    for (const a of areas) {
      const inArea = (j) => testAreaOf(j, cfg) === a.area.id;
      const n = count(active, cfg, inArea);
      if (n > a.peak) Object.assign(a, { peak: n, at });
      if (n > a.max) flag(active, inArea, `${a.label}: ${n}/${a.max} pumps at ${at}`);
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
  return { areas, limits, models, jobMsgs };
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
