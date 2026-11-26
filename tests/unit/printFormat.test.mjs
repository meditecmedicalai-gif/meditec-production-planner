// Time labels on printed pages. Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timePieces } from '../../src/printFormat.js';

const H = (t) => { const [a, b] = t.split(':').map(Number); return a * 60 + b; };
const DAY = 24 * 60;
const MON = '2026-11-30';

test('same day: one piece "09:00–10:00"', () => {
  assert.deepEqual(timePieces({ s: H('09:00'), e: H('10:00') }, MON), ['09:00–10:00']);
  assert.deepEqual(timePieces({ s: H('16:00'), e: DAY }, MON), ['16:00–24:00'], 'ends at midnight');
});

test('ends the next day: "13:30 →" "11:00 +1"', () => {
  assert.deepEqual(timePieces({ s: H('13:30'), e: DAY + H('11:00') }, MON), ['13:30 →', '11:00 +1']);
  assert.deepEqual(timePieces({ s: H('09:00'), e: DAY + H('10:00') }, MON), ['09:00 →', '10:00 +1']);
});

test('ends later: "13:30 →" "Wed 11:00"', () => {
  assert.deepEqual(timePieces({ s: H('13:30'), e: 2 * DAY + H('11:00') }, MON), ['13:30 →', 'Wed 11:00']);
});

test('continued from an earlier day: "cont. →" "11:00" (or +1 / weekday when it runs on)', () => {
  assert.deepEqual(timePieces({ s: -H('10:30'), e: H('11:00') }, MON), ['cont. →', '11:00']);
  assert.deepEqual(timePieces({ s: -H('10:30'), e: DAY + H('11:00') }, MON), ['cont. →', '11:00 +1']);
  assert.deepEqual(timePieces({ s: -DAY, e: 3 * DAY + H('08:00') }, MON), ['cont. →', 'Thu 08:00']);
});

test('pieces are short enough for the time column (no piece over 9 characters)', () => {
  for (const pl of [{ s: H('13:30'), e: DAY + H('11:00') }, { s: H('13:30'), e: 4 * DAY + H('11:00') }, { s: -60, e: 2 * DAY }]) {
    for (const p of timePieces(pl, MON)) assert.ok(p.length <= 9, p);
  }
});
