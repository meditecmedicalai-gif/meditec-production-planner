// Mixed pumps on one job (tasks with "Allows mixed pumps", e.g. Rework). Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pumpQtys, pumpLabel, pumpModelsOf, untrainedModels } from '../../src/jobs.js';
import { computeSummary, ANY_ID } from '../../src/summaryModel.js';
import { capacityConfig, capacityForDay, isTestingJob, perModel } from '../../src/capacity.js';
import { demandState, coverableNotes, qtyForNote } from '../../src/demandModel.js';

const models = [
  { id: 'qpro', name: 'QPro 2000', short_code: 'QPro', active: true, test_area_id: 'qc' },
  { id: 'air', name: 'MediAir', short_code: 'MediAir', active: true, test_area_id: 'qc' },
  { id: 'flex', name: 'Mediflex', short_code: 'Mediflex', active: true, test_area_id: 'bench' },
];
const modelById = new Map(models.map((m) => [m.id, m]));
const rework = { id: 'rw', name: 'Rework', requires_pump: true, allows_any_pump: true, counts_as_output: false };
const qt = { id: 'qt', name: 'Quality testing', requires_pump: true, is_testing: true, allows_any_pump: true };
const fa = { id: 'fa', name: 'Final assembly', requires_pump: true, counts_as_output: true };
const job = (o) => ({ id: 'j1', person_id: 'pA', work_date: '2026-11-24', task_id: 'rw', any_pump: true, qty_target: 6, part_of: null, build_type_id: 'prod',
  pump_mix: [{ pump_model_id: 'qpro', qty: 3 }, { pump_model_id: 'air', qty: 2 }, { pump_model_id: 'flex', qty: 1 }], ...o });

test('per-model quantities; the rest of the quantity is "Any / unknown"', () => {
  assert.deepEqual(pumpQtys(job()), [{ pump_model_id: 'qpro', qty: 3 }, { pump_model_id: 'air', qty: 2 }, { pump_model_id: 'flex', qty: 1 }]);
  assert.deepEqual(pumpQtys(job({ qty_target: 8, pump_mix: [{ pump_model_id: 'qpro', qty: 3 }, { pump_model_id: null, qty: 2 }] })),
    [{ pump_model_id: 'qpro', qty: 3 }, { pump_model_id: null, qty: 5 }]);
  assert.deepEqual(pumpQtys(job({ qty_target: 4, pump_mix: null })), [{ pump_model_id: null, qty: 4 }]);
  assert.deepEqual(pumpQtys({ pump_model_id: 'qpro', qty_target: 5, any_pump: false }), [{ pump_model_id: 'qpro', qty: 5 }]);
  assert.deepEqual(pumpModelsOf(job()), ['qpro', 'air', 'flex']);
});

test('label: "QPro ×3, MediAir ×2, Mediflex ×1" (+ Any / unknown)', () => {
  assert.equal(pumpLabel(job(), modelById), 'QPro ×3, MediAir ×2, Mediflex ×1');
  assert.equal(pumpLabel(job({ qty_target: 7 }), modelById), 'QPro ×3, MediAir ×2, Mediflex ×1, Any / unknown ×1');
  assert.equal(pumpLabel(job({ pump_mix: null }), modelById), 'Any / unknown pump');
  assert.equal(pumpLabel({ pump_model_id: 'qpro', any_pump: false }, modelById), 'QPro 2000');
});

test('skill check covers each model listed (not "Any / unknown")', () => {
  const skills = new Set(['pA|qpro']);
  assert.deepEqual(untrainedModels(job({ qty_target: 9, pump_mix: [...job().pump_mix, { pump_model_id: null, qty: 3 }] }), skills), ['air', 'flex']);
  assert.deepEqual(untrainedModels({ person_id: 'pA', pump_model_id: 'qpro', qty_target: 1 }, skills), []);
});

test('weekly summary: each model its own row; untyped "Any / unknown" stays its own row', () => {
  const r = computeSummary({ monday: new Date(2026, 10, 23), assignments: [job({ task_id: 'fa', qty_target: 8, pump_mix: [{ pump_model_id: 'qpro', qty: 3 }, { pump_model_id: 'air', qty: 2 }, { pump_model_id: null, qty: 3 }] })],
    notes: [], tasks: [fa, rework], models, types: [{ id: 'prod', name: 'Production' }], allTasks: false, typeFilter: '' });
  const row = (id) => r.groups.find((g) => g.model.id === id)?.total.planned;
  assert.equal(row('qpro'), 3); assert.equal(row('air'), 2); assert.equal(row(ANY_ID), 3);
  assert.equal(r.groups.find((g) => g.model.id === ANY_ID).model.name, 'Any / unknown');
  assert.equal(r.grand.planned, 8);
});

test('test capacity: each model towards its own area and limits; the bench counts the job once', () => {
  const cfg = capacityConfig({
    areas: [{ id: 'qc', name: 'Quality Check', max_pumps: 4, capacity_mode: 'simultaneous', active: true }, { id: 'bench', name: 'Bench', max_pumps: 1, capacity_mode: 'sequential', active: true }],
    limits: [{ id: 'L1', test_area_id: 'qc', name: 'QPro', max_pumps: 2, active: true }], limitModels: [{ test_limit_id: 'L1', pump_model_id: 'qpro' }],
    sharedTasks: [], models, tasks: [qt], equipment: [],
  });
  const j = job({ task_id: 'qt', start_time: '09:00:00', end_time: '11:00:00' });
  assert.equal(isTestingJob(j, cfg), true);
  assert.equal(perModel(j).length, 3);
  const c = capacityForDay([j], cfg, '2026-11-24');
  const area = (id) => c.areas.find((a) => a.area.id === id);
  assert.equal(area('qc').peak, 5, 'QPro 3 + MediAir 2 on Quality Check');
  assert.equal(area('bench').peak, 1, 'Mediflex 1 on the bench');
  assert.equal(c.limits[0].peak, 3, 'QPro limit group counts only the QPro pumps');
  assert.ok((c.jobMsgs.get('j1') || []).some((m) => /QPro: 3\/2/.test(m)), 'warning lands on the real job');
  // two models of one job on a one-at-a-time bench: still one job, no overlap
  const two = job({ id: 'j2', task_id: 'qt', start_time: '09:00:00', end_time: '10:00:00', qty_target: 3, pump_mix: [{ pump_model_id: 'flex', qty: 2 }, { pump_model_id: null, qty: 1 }] });
  assert.equal(capacityForDay([two], cfg, '2026-11-24').areas.find((a) => a.area.id === 'bench').peak, 1);
});

test('demand: a mixed job counts only the note’s model; "Any / mixed pump" notes count all', () => {
  const taskById = new Map([[fa.id, fa]]);
  const j = job({ task_id: 'fa', demand_id: 'nQ', qty_done: 5 });
  const nQ = { id: 'nQ', pump_model_id: 'qpro', quantity: 3 };
  assert.equal(qtyForNote(j, nQ), 3);
  const s = demandState(nQ, [j], { taskById, todayISO: '2026-11-25' });
  assert.equal(s.planned, 3); assert.equal(s.completed, 3, 'units done capped at that model’s quantity');
  assert.equal(s.status, 'done');
  const nAny = { id: 'nA', any_pump: true, quantity: 10 };
  assert.equal(demandState(nAny, [{ ...j, demand_id: 'nA' }], { taskById, todayISO: '2026-11-25' }).planned, 6);
  // the job can cover notes for any model it lists, or Any / mixed notes
  const items = [nQ, nAny, { id: 'nF', pump_model_id: 'flex' }, { id: 'nX', pump_model_id: 'other' }].map((note) => ({ note, state: { status: 'open' } }));
  assert.deepEqual(coverableNotes(items, { anyPump: true, models: pumpModelsOf(j) }).map((x) => x.note.id), ['nQ', 'nA', 'nF']);
  assert.deepEqual(coverableNotes(items, { pumpModelId: 'qpro', anyPump: false }).map((x) => x.note.id), ['nQ']);
});
