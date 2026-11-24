// Occupancy graph: pumps on test across the day against the area's limit.
import { h } from '../ui.js';
import { occupancyText } from '../capacity.js';

const NS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}, ...kids) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) el.setAttribute(k, v);
  for (const k of kids.flat()) if (k) el.append(k);
  return el;
};
const fmt = (m) => `${String(m >= 1440 ? 24 : Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/**
 * series: [{ t, n }] (minutes from midnight, step function); max: the limit.
 * T0..T1: visible minutes. Returns an <svg> (stretches to its box).
 */
export function occupancySvg(series, { max, T0 = 0, T1 = 24 * 60, height = 44, ticks = false, label = '' } = {}) {
  const W = 1000; const H = height;
  const peak = Math.max(max, ...series.map((x) => x.n));
  const top = 4; const bottom = ticks ? H - 12 : H - 2;
  const x = (t) => ((Math.min(T1, Math.max(T0, t)) - T0) / (T1 - T0)) * W;
  const y = (n) => bottom - (n / (peak || 1)) * (bottom - top);
  // step path
  const pts = [];
  series.forEach((p, i) => {
    const t2 = series[i + 1]?.t ?? 24 * 60;
    if (t2 <= T0 || p.t >= T1) return;
    pts.push([x(p.t), y(p.n)], [x(t2), y(p.n)]);
  });
  const area = pts.length ? `M${pts[0][0]},${bottom} ${pts.map(([a, b]) => `L${a},${b}`).join(' ')} L${pts.at(-1)[0]},${bottom} Z` : '';
  const line = pts.length ? `M${pts.map(([a, b]) => `${a},${b}`).join(' L')}` : '';
  const over = series.map((p, i) => ({ s: p.t, e: series[i + 1]?.t ?? 24 * 60, n: p.n })).filter((p) => p.n > max && p.e > T0 && p.s < T1);
  const hourTicks = [];
  if (ticks) for (let m = Math.ceil(T0 / 60) * 60; m <= T1; m += 60) hourTicks.push(m);
  return svg('svg', { class: 'occ-svg', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img',
    'aria-label': `${label}${label ? ': ' : ''}${occupancyText(series)} (limit ${max})` },
  over.map((p) => svg('rect', { class: 'occ-over', x: x(p.s), y: top - 2, width: Math.max(2, x(p.e) - x(p.s)), height: bottom - top + 2 })),
  area ? svg('path', { class: 'occ-area', d: area }) : null,
  line ? svg('path', { class: 'occ-line', d: line, 'vector-effect': 'non-scaling-stroke' }) : null,
  svg('line', { class: 'occ-limit', x1: 0, x2: W, y1: y(max), y2: y(max), 'vector-effect': 'non-scaling-stroke' }),
  hourTicks.map((m) => svg('text', { class: 'occ-tick', x: x(m), y: H - 1, 'text-anchor': 'middle' }, fmt(m))));
}

/** Free places across the day: "7 until 11:00, then 2, then 7 from 13:30" style. */
export function freeSlotsText(series, max, from = 0, to = 24 * 60) {
  const parts = [];
  series.forEach((p, i) => {
    const e = series[i + 1]?.t ?? 24 * 60;
    if (e <= from || p.t >= to) return;
    const free = Math.max(0, max - p.n);
    const last = parts.at(-1);
    if (last && last.free === free) last.e = e; else parts.push({ s: Math.max(p.t, from), e, free });
  });
  return parts.map((p) => `${fmt(p.s)}–${fmt(Math.min(p.e, to))} ${p.free} free`).join(' · ');
}

const hoursBetween = (T0, T1) => { const out = []; for (let m = Math.ceil(T0 / 60) * 60; m <= T1; m += 120) out.push(m); return out; };

/** Hover / focus popover for the capacity row: graph + text. */
export function occupancyPopover(a, { T0, T1 }) {
  return h('div', { class: 'cap-pop', role: 'tooltip' },
    h('div', { class: 'cap-pop-title' }, `${a.label} — pumps on test across the day (limit ${a.max})`),
    h('div', { class: 'cap-pop-graph' }, occupancySvg(a.series, { max: a.max, T0, T1, height: 70, label: a.label })),
    h('div', { class: 'cap-pop-scale' }, hoursBetween(T0, T1).map((m) => h('span', { style: `left:${((m - T0) / (T1 - T0)) * 100}%` }, fmt(m).replace(':00', '')))),
    h('div', { class: 'cap-pop-text' }, occupancyText(a.series)),
    h('div', { class: 'cap-pop-free' }, freeSlotsText(a.series, a.max, T0, T1)),
  );
}
