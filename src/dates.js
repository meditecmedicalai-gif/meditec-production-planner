// Date helpers. Dates are handled as local calendar days ("YYYY-MM-DD"),
// never as UTC timestamps, so nothing shifts around midnight / BST.

export function toISO(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function fromISO(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(d, n) {
  const r = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  r.setDate(r.getDate() + n);
  return r;
}

/** Monday of the week containing d. */
export function mondayOf(d) {
  const day = (d.getDay() + 6) % 7; // Mon=0 … Sun=6
  return addDays(d, -day);
}

export function today() {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate());
}

/** ISO-8601 week number. */
export function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
}

const fmt = (opts) => new Intl.DateTimeFormat('en-GB', opts);
export const fmtDayShort = (d) => fmt({ weekday: 'short', day: 'numeric', month: 'short' }).format(d); // Mon 23 Nov
export const fmtDayLong = (d) => fmt({ weekday: 'long', day: 'numeric', month: 'long' }).format(d);   // Monday 23 November
export const fmtWeekday = (d) => fmt({ weekday: 'short' }).format(d);                                  // Mon
export const fmtDate = (d) => fmt({ day: 'numeric', month: 'short', year: 'numeric' }).format(d);      // 23 Nov 2026

/** "23–27 Nov 2026" or "30 Nov – 4 Dec 2026". */
export function fmtRange(a, b) {
  if (a.getMonth() === b.getMonth()) return `${a.getDate()}–${fmtDate(b)}`;
  return `${fmt({ day: 'numeric', month: 'short' }).format(a)} – ${fmtDate(b)}`;
}
