// Re-flow of jobs over several days. Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planSeries, editJob, moveJob, adjustPart, removePart, diffParts, partsOf, totalOf, checkParts,
  runsPastFinish, overtimePart, sumWork, fmt,
} from '../../src/series.js';

// Mon–Fri 08:30–16:30, break 10:30–10:45, lunch 12:30–13:00 (2026-11-23 is a Monday)
const H = (m) => { const [a, b] = m.split(':').map(Number); return a * 60 + b; };
const STD = { ws: H('08:30'), we: H('16:30'), breaks: [{ s: H('10:30'), e: H('10:45') }, { s: H('12:30'), e: H('13:00') }] };
const weekday = (iso) => { const d = new Date(`${iso}T12:00:00`).getDay(); return d !== 0 && d !== 6; };
const hours = ({ off = [], person = 'p1', late = {} } = {}) => (iso) => {
  if (!weekday(iso) || off.includes(iso)) return null;
  return late[iso] ? { ...STD, ws: H(late[iso]) } : STD;
};
const di = hours();
const show = (parts) => parts.map((p) => `${p.date} ${fmt(p.start)}-${fmt(p.end)}`);
/** The invariants every result must keep. */
function sound(parts, { dayInfo = di, total } = {}) {
  assert.deepEqual(checkParts(parts, { dayInfo, total }), [], show(parts).join(', '));
}
/** Saved rows for parts (as the database would hold them), with ids. */
let n = 0;
const rowsFor = (parts, extra = {}) => parts.map((p, i) => ({ id: `r${++n}`, part_of: i ? 'HEAD' : null, work_date: p.date,
  start_time: fmt(p.start), end_time: fmt(p.end), part_locked: Boolean(p.locked), work_minutes: i === 0 ? extra.total ?? null : null }))
  .map((r, i, all) => (i ? { ...r, part_of: all[0].id } : r));

test('create with work time: Tue 15:00 + 3h → Tue 15:00–16:30 · Wed 08:30–10:00', () => {
  const parts = planSeries({ date: '2026-11-24', start: H('15:00'), total: 180, dayInfo: di });
  assert.deepEqual(show(parts), ['2026-11-24 15:00-16:30', '2026-11-25 08:30-10:00']);
  sound(parts, { total: 180 });
});

test('create with an end time past the finish: same as its work time, breaks paused', () => {
  // 14:00 → 18:15 with no break in between = 4h15 of work → 2h30 today, 1h45 tomorrow (08:30–10:15)
  const total = 255;
  assert.equal(runsPastFinish({ date: '2026-11-24', start: H('14:00'), total, dayInfo: di }), true);
  const parts = planSeries({ date: '2026-11-24', start: H('14:00'), total, dayInfo: di });
  assert.deepEqual(show(parts), ['2026-11-24 14:00-16:30', '2026-11-25 08:30-10:15']);
  assert.equal(sumWork(parts, di), total);
  sound(parts, { total });
});

test('long job over three days', () => {
  const parts = planSeries({ date: '2026-11-24', start: H('09:00'), total: 15 * 60, dayInfo: di });
  assert.equal(parts.length, 3);
  assert.equal(sumWork(parts, di), 900);
  sound(parts, { total: 900 });
});

test('fits in the day → one part (no split)', () => {
  const parts = planSeries({ date: '2026-11-24', start: H('09:00'), total: 120, dayInfo: di });
  assert.equal(parts.length, 1);
  assert.equal(runsPastFinish({ date: '2026-11-24', start: H('09:00'), total: 120, dayInfo: di }), false);
});

test('allow overtime keeps one part past the finish', () => {
  const parts = overtimePart({ date: '2026-11-24', start: H('15:00'), total: 180, dayInfo: di });
  assert.deepEqual(show(parts), ['2026-11-24 15:00-18:00']);
});

test('edit part 1 (new start time): re-flows, same number of rows re-used, nothing added', () => {
  const cur = planSeries({ date: '2026-11-24', start: H('15:00'), total: 180, dayInfo: di });
  const saved = rowsFor(cur, { total: 180 });
  const parts = editJob({ current: partsOf(saved), date: '2026-11-24', start: H('14:00'), total: 180, dayInfo: di });
  assert.deepEqual(show(parts), ['2026-11-24 14:00-16:30', '2026-11-25 08:30-09:00']);
  const { rows, remove } = diffParts(saved, parts, {}, { total: 180 });
  assert.deepEqual(rows.map((r) => r.id), saved.map((r) => r.id));
  assert.deepEqual(remove, []);
  sound(parts, { total: 180 });
});

test('BUG C — editing part 2 in work-time mode never re-applies the full 3h to part 2', () => {
  const cur = planSeries({ date: '2026-11-24', start: H('15:00'), total: 180, dayInfo: di });
  const saved = rowsFor(cur, { total: 180 });
  // the form opened from part 2 edits the WHOLE job: its first start and its total (3h)
  const rows = partsOf(saved);
  const total = totalOf(saved, di);
  assert.equal(total, 180);
  const parts = editJob({ current: rows, date: rows[0].date, start: rows[0].start, total, dayInfo: di });
  assert.equal(parts.length, 2, show(parts).join(', '));
  const d = diffParts(saved, parts, {}, { total });
  assert.equal(d.rows.filter((r) => !r.id).length, 0, 'no new rows');
  assert.equal(d.remove.length, 0);
  // the old bug: 3h from part 2's start would give 08:30–11:45 on Wed — must not happen
  assert.notEqual(show(parts)[1], '2026-11-25 08:30-11:45');
});

test('change the total work time: more → a third day is added once; less → surplus parts removed', () => {
  const cur = planSeries({ date: '2026-11-24', start: H('15:00'), total: 180, dayInfo: di });
  const saved = rowsFor(cur, { total: 180 });
  const longer = editJob({ current: partsOf(saved), date: '2026-11-24', start: H('15:00'), total: 180 + 8 * 60, dayInfo: di });
  assert.equal(longer.length, 3);
  let d = diffParts(saved, longer, {}, { total: 660 });
  assert.equal(d.rows.filter((r) => !r.id).length, 1);
  sound(longer, { total: 660 });
  const shorter = editJob({ current: partsOf(saved), date: '2026-11-24', start: H('15:00'), total: 60, dayInfo: di });
  assert.equal(shorter.length, 1);
  d = diffParts(saved, shorter, {}, { total: 60 });
  assert.deepEqual(d.remove, [saved[1].id]);
});

test('change the date of part 1 (Tue → Thu): both parts move, Fri gets part 2', () => {
  const cur = partsOf(rowsFor(planSeries({ date: '2026-11-24', start: H('15:00'), total: 180, dayInfo: di })));
  const parts = moveJob({ current: cur, index: 0, toDate: '2026-11-26', total: 180, dayInfo: di });
  assert.deepEqual(show(parts), ['2026-11-26 15:00-16:30', '2026-11-27 08:30-10:00']);
  sound(parts, { total: 180 });
});

test('change the date of part 2 (Wed → Thu): the whole job shifts one day', () => {
  const cur = partsOf(rowsFor(planSeries({ date: '2026-11-24', start: H('15:00'), total: 180, dayInfo: di })));
  const parts = moveJob({ current: cur, index: 1, toDate: '2026-11-26', total: 180, dayInfo: di });
  assert.deepEqual(show(parts), ['2026-11-25 15:00-16:30', '2026-11-26 08:30-10:00']);
  sound(parts, { total: 180 });
});

test('drag part 1 to Friday: part 2 skips the weekend to Monday', () => {
  const saved = rowsFor(planSeries({ date: '2026-11-24', start: H('15:00'), total: 180, dayInfo: di }));
  const parts = moveJob({ current: partsOf(saved), index: 0, toDate: '2026-11-27', total: 180, dayInfo: di });
  assert.deepEqual(show(parts), ['2026-11-27 15:00-16:30', '2026-11-30 08:30-10:00']);
  const d = diffParts(saved, parts, {}, { total: 180 });
  assert.equal(d.rows.length, 2); assert.equal(d.remove.length, 0);
  assert.ok(d.rows.every((r) => r.id), 'the same two rows are moved, none added');
});

test('move to another person (later start 10:00): re-flows with their hours', () => {
  const cur = partsOf(rowsFor(planSeries({ date: '2026-11-24', start: H('15:00'), total: 180, dayInfo: di })));
  const theirs = hours({ late: { '2026-11-25': '10:00' } });
  // 1h30 from 10:00 pauses for the 10:30–10:45 break → 11:45
  const parts = editJob({ current: cur, date: '2026-11-24', start: H('15:00'), total: 180, dayInfo: theirs });
  assert.deepEqual(show(parts), ['2026-11-24 15:00-16:30', '2026-11-25 10:00-11:45']);
  sound(parts, { dayInfo: theirs, total: 180 });
});

test('copy a split job to next week: fresh rows only, same shape', () => {
  const cur = partsOf(rowsFor(planSeries({ date: '2026-11-24', start: H('15:00'), total: 180, dayInfo: di })));
  const parts = moveJob({ current: cur, index: 0, toDate: '2026-12-01', total: 180, dayInfo: di });
  assert.deepEqual(show(parts), ['2026-12-01 15:00-16:30', '2026-12-02 08:30-10:00']);
  const d = diffParts([], parts, {}, { total: 180 });
  assert.equal(d.rows.length, 2); assert.ok(d.rows.every((r) => !r.id));
  assert.equal(d.rows[0].work_minutes, 180); assert.equal(d.rows[1].work_minutes, null);
});

test('absence or day off on the next day: part 2 goes to the next working day', () => {
  const off = hours({ off: ['2026-11-25'] });
  const parts = planSeries({ date: '2026-11-24', start: H('15:00'), total: 180, dayInfo: off });
  assert.deepEqual(show(parts), ['2026-11-24 15:00-16:30', '2026-11-26 08:30-10:00']);
  sound(parts, { dayInfo: off, total: 180 });
  // an absence added later on Thu: re-flow moves part 2 on to Fri (no part left behind on Thu)
  const off2 = hours({ off: ['2026-11-25', '2026-11-26'] });
  const again = editJob({ current: parts, date: '2026-11-24', start: H('15:00'), total: 180, dayInfo: off2 });
  assert.deepEqual(show(again), ['2026-11-24 15:00-16:30', '2026-11-27 08:30-10:00']);
});

test('start on a non-working day: starts at the next working day’s start', () => {
  const parts = planSeries({ date: '2026-11-28', start: H('15:00'), total: 180, dayInfo: di });
  assert.deepEqual(show(parts), ['2026-11-30 08:30-11:45']);
});

test('undo after auto-split: restoring the old one-day job removes part 2 and keeps part 1', () => {
  const before = [{ date: '2026-11-24', start: H('09:00'), end: H('11:00') }];
  const saved0 = rowsFor(before);
  const split = planSeries({ date: '2026-11-24', start: H('15:00'), total: 180, dayInfo: di });
  const after = diffParts(saved0, split, {}, { total: 180 });
  assert.equal(after.rows[0].id, saved0[0].id);
  const savedNow = after.rows.map((r, i) => ({ ...r, id: r.id || `new${i}`, part_of: i ? saved0[0].id : null }));
  const undo = diffParts(savedNow, before, {});
  assert.equal(undo.rows.length, 1); assert.equal(undo.rows[0].id, saved0[0].id);
  assert.deepEqual(undo.remove, [savedNow[1].id]);
  assert.equal(undo.rows[0].start_time, '09:00'); assert.equal(undo.rows[0].end_time, '11:00');
  // undo of a NEW split job removes every part
  assert.deepEqual(diffParts(savedNow, [], {}).remove, savedNow.map((r) => r.id));
});

test('adjust this part only — following parts re-flow to keep the total', () => {
  const cur = planSeries({ date: '2026-11-24', start: H('09:00'), total: 15 * 60, dayInfo: di });   // Tue, Wed, Thu
  // part 2 (Wed) shortened to 08:30–12:30 (3h45 work): Thu takes the rest
  const { parts, total } = adjustPart({ current: cur, index: 1, start: H('08:30'), end: H('12:30'), mode: 'reflow', total: 900, dayInfo: di });
  assert.equal(total, 900);
  assert.equal(sumWork(parts, di), 900);
  assert.equal(parts[1].locked, true); assert.equal(parts[0].locked, false);
  assert.deepEqual(show(parts).slice(0, 2), ['2026-11-24 09:00-16:30', '2026-11-25 08:30-12:30']);
  sound(parts, { total: 900 });
});

test('adjust this part only — lock the following parts (total becomes the new sum)', () => {
  const cur = planSeries({ date: '2026-11-24', start: H('09:00'), total: 15 * 60, dayInfo: di });
  const { parts, total } = adjustPart({ current: cur, index: 1, start: H('08:30'), end: H('12:30'), mode: 'lock', total: 900, dayInfo: di });
  assert.equal(parts.length, 3);
  assert.deepEqual(show(parts)[2], show(cur)[2]);
  assert.equal(total, sumWork(parts, di));
  assert.ok(total < 900);
});

test('adjust part 1 longer: surplus later parts are removed, never more parts than needed', () => {
  const cur = planSeries({ date: '2026-11-24', start: H('15:00'), total: 180, dayInfo: di });
  const { parts } = adjustPart({ current: cur, index: 0, start: H('13:00'), end: H('16:30'), mode: 'reflow', total: 180, dayInfo: di });
  assert.equal(parts.length, 1);
});

test('locked part kept when the total changes; work flows around it', () => {
  const cur = planSeries({ date: '2026-11-24', start: H('09:00'), total: 15 * 60, dayInfo: di });
  const { parts: adj } = adjustPart({ current: cur, index: 1, start: H('13:00'), end: H('16:30'), mode: 'reflow', total: 900, dayInfo: di });
  const longer = editJob({ current: adj, date: '2026-11-24', start: H('09:00'), total: 1000, dayInfo: di });
  assert.deepEqual(show(longer)[1], '2026-11-25 13:00-16:30');
  assert.equal(sumWork(longer, di), 1000);
  sound(longer, { total: 1000 });
  // moving the job clears the locks: a clean re-flow on the new days
  const moved = moveJob({ current: adj, index: 0, toDate: '2026-12-01', total: 900, dayInfo: di });
  assert.ok(moved.every((p) => !p.locked));
});

test('delete this part only: the others stay, the total shrinks', () => {
  const cur = planSeries({ date: '2026-11-24', start: H('09:00'), total: 15 * 60, dayInfo: di });
  const { parts, total } = removePart({ current: cur, index: 2, dayInfo: di });
  assert.equal(parts.length, 2); assert.equal(total, sumWork(cur.slice(0, 2), di));
});

test('no scenario ever gives two parts on one day or a part on a non-working day', () => {
  const offs = [[], ['2026-11-25'], ['2026-11-25', '2026-11-26'], ['2026-11-27']];
  for (const off of offs) {
    const dayInfo = hours({ off });
    for (const start of [H('08:30'), H('10:40'), H('15:00'), H('16:20')]) {
      for (const total of [30, 180, 480, 1000, 2000]) {
        for (const date of ['2026-11-23', '2026-11-24', '2026-11-27', '2026-11-28']) {
          const parts = planSeries({ date, start, total, dayInfo });
          assert.deepEqual(checkParts(parts, { dayInfo, total }), [], `${date} ${fmt(start)} ${total} off ${off}: ${show(parts)}`);
          assert.equal(sumWork(parts, dayInfo), total);
          const moved = moveJob({ current: parts, index: parts.length - 1, toDate: '2026-12-03', total, dayInfo });
          assert.deepEqual(checkParts(moved, { dayInfo, total }), []);
        }
      }
    }
  }
});
