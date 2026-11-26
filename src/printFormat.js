// Text for printed pages (pure: no DOM) — see tests/unit/printFormat.test.mjs.
import { fmtMin } from './daytime.js';
import { fromISO, addDays, fmtDayShort } from './dates.js';

/**
 * Short time label, as unbreakable pieces (it may wrap between them, never inside one):
 *   same day            ["09:00–11:00"]
 *   ends the next day   ["13:30 →", "11:00 +1"]
 *   ends later          ["13:30 →", "Wed 11:00"]
 *   continued from before ["cont. →", "11:00"]  (or "11:00 +1" / "Wed 11:00" when it runs on)
 * `pl` is { s, e } in minutes from midnight of `iso` (negative / past 24:00 for other days).
 */
export function timePieces(pl, iso) {
  const day = 24 * 60;
  const over = pl.e > day ? Math.floor((pl.e - 1) / day) : 0;     // whole days after `iso` it ends on
  const endMin = pl.e - over * day;
  const end = over === 0 ? (pl.e >= day ? '24:00' : fmtMin(pl.e))
    : over === 1 ? `${fmtMin(endMin)} +1`
      : `${fmtDayShort(addDays(fromISO(iso), over)).split(' ')[0]} ${fmtMin(endMin)}`;
  if (pl.s < 0) return ['cont. →', end];
  return over === 0 ? [`${fmtMin(pl.s)}–${end}`] : [`${fmtMin(pl.s)} →`, end];
}
