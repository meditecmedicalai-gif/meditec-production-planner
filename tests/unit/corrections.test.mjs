// Completed units: corrections (edit, delete, negative, adjust, undo), never below 0,
// status recalculated. Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demandState, logCheck, adjustEntry, editCheck, deleteCheck, stageOfLog } from '../../src/demandModel.js';

const taskById = new Map([
  ['sub', { id: 'sub', name: 'Sub-assembly' }], ['fa', { id: 'fa', name: 'Final assembly', counts_as_output: true }],
  ['qt', { id: 'qt', name: 'Quality testing' }],
]);
const stagesByModel = new Map([['qpro', ['sub', 'fa', 'qt']]]);
const note = { id: 'n1', pump_model_id: 'qpro', quantity: 10, needed_by: '2026-11-30' };
const job = (o) => ({ id: `j${Math.random()}`, demand_id: 'n1', work_date: '2026-11-24', part_of: null, qty_target: 10, ...o });
const state = (logs, links = [job({ task_id: 'qt' })], manual = []) => demandState(note, links, { taskById, todayISO: '2026-11-25', stagesByModel, logs, manual });
const log = (qty, o = {}) => ({ id: `l${Math.random()}`, demand_id: 'n1', task_id: 'qt', qty, work_date: '2026-11-24', ...o });

test('log, then status recalculates: 10 done at the last stage → Done', () => {
  assert.equal(state([log(4)]).status, 'planned');
  const s = state([log(4), log(6)]);
  assert.equal(s.completed, 10); assert.equal(s.status, 'done');
});

test('negative correction ("−3, counted twice") lowers completed and Done goes back', () => {
  const s0 = state([log(10)]);
  assert.equal(s0.status, 'done');
  assert.equal(logCheck(s0, 'qt', -3), null);
  const s1 = state([log(10), log(-3, { note: 'counted twice' })]);
  assert.equal(s1.completed, 7); assert.equal(s1.toDo, 3); assert.equal(s1.status, 'planned');
});

test('completed can’t go below 0', () => {
  const s = state([log(2)]);
  assert.match(logCheck(s, 'qt', -3), /below 0 — Quality testing has 2 done/);
  assert.equal(logCheck(s, 'qt', 0), 'Enter a whole number, not 0 (negative to correct).');
  // display is floored at 0 even if old data went negative
  assert.equal(state([log(2), log(-5)]).completed, 0);
});

test('adjust sets a stage’s total directly, recorded as the difference', () => {
  const s = state([log(9)], [job({ task_id: 'qt', qty_done: 3 })]);
  assert.equal(s.completed, 12);
  const a = adjustEntry(s, 'qt', 10);
  assert.deepEqual(a, { delta: -2, note: 'Adjusted from 12 to 10' });
  assert.equal(state([log(9), log(a.delta)], [job({ task_id: 'qt', qty_done: 3 })]).completed, 10);
  assert.ok(adjustEntry(s, 'qt', 12).error);
  assert.ok(adjustEntry(s, 'qt', -1).error);
  // another stage
  assert.deepEqual(adjustEntry(s, 'sub', 5), { delta: 5, note: 'Adjusted from 0 to 5' });
});

test('edit an entry: quantity and stage', () => {
  const a = log(5); const b = log(2, { task_id: 'sub' });
  const s = state([a, b]);
  assert.equal(editCheck(s, a, 3, 'qt'), null);
  assert.equal(state([{ ...a, qty: 3 }, b]).completed, 3);
  // moving the sub-assembly entry to another stage is fine; making it −3 there is not
  assert.equal(editCheck(s, b, 2, 'fa'), null);
  assert.match(editCheck(s, b, -3, 'sub'), /below 0/);
});

test('delete an entry (and undo = delete the entry just logged)', () => {
  const a = log(5); const corr = log(-5);
  const s = state([a, corr]);
  assert.match(deleteCheck(s, a), /below 0/, 'deleting the +5 would leave −5');
  assert.equal(deleteCheck(s, corr), null);
  // undo right after logging +4: back to where it was
  const before = state([a]);
  const added = log(4);
  assert.equal(state([a, added]).completed, 9);
  assert.equal(deleteCheck(state([a, added]), added), null);
  assert.equal(state([a]).completed, before.completed);
});

test('units done on jobs can be lowered or cleared; counted once per job (not per part)', () => {
  const head = job({ id: 'h', task_id: 'qt', qty_done: 6 });
  const part2 = job({ id: 'p2', part_of: 'h', task_id: 'qt', qty_done: 6, work_date: '2026-11-25' }); // old data copied it
  assert.equal(state([], [head, part2]).completed, 6);
  assert.equal(state([], [{ ...head, qty_done: 2 }, part2]).completed, 2);
  assert.equal(state([], [{ ...head, qty_done: null }]).completed, 0);
});

test('entries without a stage count at the last stage', () => {
  const s = state([log(3, { task_id: null })]);
  assert.equal(stageOfLog(s, { task_id: null }), 'qt');
  assert.equal(s.completed, 3);
});
