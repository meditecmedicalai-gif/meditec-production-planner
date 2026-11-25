// Day timeline (planner "Day timeline" view), the busy/free bar under each
// week-grid cell, and the mini timeline in the job form.
import { h } from '../ui.js';
import { timeLabel, hm, ABSENCE_TYPES } from '../jobs.js';
import { personDay, fmtMin, fmtDur, toMin } from '../daytime.js';
import { fmtDayShort } from '../dates.js';
import { fromISO } from '../dates.js';
import { level, occupancyText } from '../capacity.js';
import { occupancySvg, freeSlotsText } from './occupancy.js';

const SLOT = 30; // minutes per column

/** Visible range: a little before the start and after the end of the working day. */
export function viewRange(...days) {
  const working = days.filter((d) => d && !d.nonWorking);
  const ws = Math.min(...(working.length ? working : days).map((d) => d.ws));
  const we = Math.max(...(working.length ? working : days).map((d) => d.we));
  const T0 = Math.max(0, Math.floor((ws - 60) / SLOT) * SLOT);
  const T1 = Math.min(24 * 60, Math.ceil((we + 60) / SLOT) * SLOT);
  return { T0, T1 };
}

/** Lanes so overlapping jobs sit under each other. */
function lanes(items) {
  const ends = [];
  for (const it of items) {
    let i = ends.findIndex((e) => e <= it.s);
    if (i < 0) { i = ends.length; ends.push(0); }
    ends[i] = it.e; it.lane = i;
  }
  return Math.max(1, ends.length);
}

/** "QPro 2000 · Quality testing ×5" */
export function jobText(ctx, a) {
  const task = ctx.taskById.get(a.task_id);
  return [ctx.pump(a), task?.name].filter(Boolean).join(' · ') + (a.qty_target != null ? ` ×${a.qty_target}` : '');
}

// ------------------------------------------------------------------ week grid: busy / free bar
/** "4h busy · 3h 15m free", "All free · 7h 15m", "Fully booked · 7h 15m". */
export function busyFreeText(day) {
  if (!day.busyMin) return `All free · ${fmtDur(day.freeMin)}`;
  if (!day.freeMin) return `Fully booked · ${fmtDur(day.busyMin)}`;
  return `${fmtDur(day.busyMin)} busy · ${fmtDur(day.freeMin)} free`;
}

export function dayBar(day) {
  if (day.absent || day.nonWorking) return null;
  const span = day.we - day.ws;
  const pct = (m) => `${((Math.min(day.we, Math.max(day.ws, m)) - day.ws) / span) * 100}%`;
  const w = (s, e) => `${((Math.min(day.we, e) - Math.max(day.ws, s)) / span) * 100}%`;
  const bgInside = day.background.filter((b) => !b.untimed && b.e > day.ws && b.s < day.we);
  const untimed = day.untimed.length;
  const text = `${busyFreeText(day)}${untimed ? ` · ${untimed} no time` : ''}`;
  return h('div', { class: 'daybar-wrap', title: `${fmtMin(day.ws)}–${fmtMin(day.we)}: ${text}${day.background.length ? ` · ${day.background.length} in the background` : ''}` },
    h('div', { class: 'daybar', role: 'img', 'aria-label': text },
      day.breaks.map((b) => h('span', { class: 'db-break', style: `left:${pct(b.s)};width:${w(b.s, b.e)}` })),
      day.busy.map(([s, e]) => h('span', { class: 'db-busy', style: `left:${pct(s)};width:${w(s, e)}` })),
      bgInside.map((b) => h('span', { class: 'db-bg', style: `left:${pct(b.s)};width:${w(b.s, b.e)}` })),
    ),
    h('div', { class: 'daybar-text' },
      !day.busyMin ? [h('b', { class: 'db-free-txt' }, 'All free'), ` · ${fmtDur(day.freeMin)}`]
        : !day.freeMin ? [h('b', {}, 'Fully booked'), ` · ${fmtDur(day.busyMin)}`]
          : [h('b', {}, fmtDur(day.busyMin)), ' busy · ', h('b', { class: 'db-free-txt' }, fmtDur(day.freeMin)), ' free'],
      untimed ? h('span', { class: 'db-untimed' }, ` · ${untimed} no time`) : null),
  );
}

// ------------------------------------------------------------------ the Day timeline
/**
 * rows: people; ctx: planner ctx (with dayOf); iso: the day.
 * handlers: onJob(job, person), onFree(person, s, e), warningsOf(job, person) → [msgs]
 * Returns { el, placeNow(minutes) }.
 */
export function dayTimeline({ ctx, rows, iso, isToday, admin, onJob, onFree, warningsOf, notesOf = () => [], capacity }) {
  const sample = ctx.dayOf(rows[0]?.id, iso);
  const { T0, T1 } = viewRange(...rows.map((p) => ctx.dayOf(p.id, iso)));
  const cols = (T1 - T0) / SLOT;
  const pos = (m) => ((Math.min(T1, Math.max(T0, m)) - T0) / (T1 - T0)) * 100;
  const width = (s, e) => Math.max(pos(e) - pos(s), 0);
  const slotTimes = []; for (let m = T0; m < T1; m += SLOT) slotTimes.push(m);
  const nowLines = [];

  // each person's own break / lunch and working window
  const breakCols = (day) => day.breaks.map((b) => h('div', { class: 'dt-break', style: `left:${pos(b.s)}%;width:${width(b.s, b.e)}%`, title: `${b.label} ${fmtMin(b.s)}–${fmtMin(b.e)}` },
    width(b.s, b.e) > 2.2 ? h('span', { class: 'dt-break-tag' }, b.label) : null));
  const offHours = (day) => (day.nonWorking
    ? [h('div', { class: 'dt-off dt-off-day', style: 'left:0;right:0' })]
    : [
        day.ws > T0 ? h('div', { class: 'dt-off', style: `left:0;width:${pos(day.ws)}%`, title: `Before ${fmtMin(day.ws)} — outside working hours` }) : null,
        day.we < T1 ? h('div', { class: 'dt-off', style: `left:${pos(day.we)}%;right:0`, title: `After ${fmtMin(day.we)} — outside working hours` }) : null,
      ]);
  const nowLine = () => {
    if (!isToday) return null;
    const el = h('div', { class: 'dt-now', 'aria-hidden': 'true' });
    nowLines.push(el);
    return el;
  };

  const header = h('div', { class: 'dt-row dt-head' },
    h('div', { class: 'dt-name' }, 'Person'),
    h('div', { class: 'dt-track dt-scale' },
      slotTimes.map((m) => h('span', { class: `dt-tick ${m % 60 === 0 ? 'hour' : ''}`, style: `left:${pos(m)}%` }, fmtMin(m))),
      nowLine()),
    h('div', { class: 'dt-untimed dt-untimed-head' }, 'No time set'),
  );

  // Test capacity across the day, aligned with the timeline
  const capRows = (capacity?.areas || []).filter((a, i) => i === 0 || a.peak > 0 || a.untimed.length).map((a) => {
    if (a.sequential) {
      return h('div', { class: 'dt-row dt-cap-row', 'data-area': a.area.id },
        h('div', { class: 'dt-name' }, h('b', {}, a.label), h('small', {}, a.busy.length ? 'one pump at a time' : 'free all day')),
        h('div', { class: 'dt-track dt-occ' },
          a.batches.map((b) => h('div', {
            class: `dt-bench ${a.peak > 1 ? 'dt-bench-over' : ''}`, style: `left:${pos(b.s)}%;width:${Math.max(width(b.s, b.e), 0.8)}%`,
            title: `${jobText(ctx, b.job)} · ${fmtMin(b.s)}–${fmtMin(b.e)}${b.pumps ? ` · ${b.pumps} pumps` : ''}${b.perPump ? ` · ~${b.perPump} min each` : ''}`,
          }, h('span', {}, `Bench busy ${fmtMin(b.s)}–${fmtMin(b.e)}`))),
          nowLine()),
        h('div', { class: 'dt-untimed' }, a.untimed.length ? h('span', { class: 'dt-ut-cta' }, `${a.untimed.length} untimed — add times`) : null));
    }
    return h('div', { class: 'dt-row dt-cap-row', 'data-area': a.area.id },
      h('div', { class: 'dt-name' }, h('b', {}, `${a.label}`), h('small', { class: `cap-${level(a.peak, a.max)}-txt` }, `peak ${a.peak}/${a.max}${a.peak ? ` at ${a.at}` : ''}`)),
      h('div', { class: 'dt-track dt-occ', title: `${occupancyText(a.series)}\n${freeSlotsText(a.series, a.max, T0, T1)}` },
        occupancySvg(a.series, { max: a.max, T0, T1, height: 46, label: a.label }),
        h('span', { class: 'dt-occ-max' }, `limit ${a.max}`),
        nowLine()),
      h('div', { class: 'dt-untimed' }, a.untimed.length
        ? h('span', { class: 'dt-ut-cta', title: a.untimed.map((j) => jobText(ctx, j)).join('\n') }, `⚠ ${a.untimed.length} untimed — not counted, add times`)
        : h('span', { class: 'muted small' }, freeSlotsText(a.series, a.max, Math.max(T0, sample.ws), Math.min(T1, sample.we)).split(' · ').slice(0, 3).join(' · '))));
  });

  const rowEls = rows.map((p) => {
    const day = ctx.dayOf(p.id, iso);
    const absence = day.absent;
    const att = day.attended.map((x) => ({ ...x }));
    const nLanes = lanes(att);
    const bgs = day.background;
    const track = h('div', {
      class: 'dt-track', style: `--lanes:${nLanes};--bgs:${bgs.length}`,
    }, offHours(day), breakCols(day));

    // free gaps
    for (const [s, e] of day.free) {
      const label = `Free ${fmtMin(s)}–${fmtMin(e)}`;
      const attrs = {
        class: 'dt-free', style: `left:${pos(s)}%;width:${width(s, e)}%`, title: admin ? `${label} — click to add a job for ${p.name}` : label,
        'aria-label': `${p.name}: ${label}`,
      };
      const content = [h('span', { class: 'dt-free-l' }, e - s >= 45 ? label : 'Free')];
      track.append(admin
        ? h('button', { ...attrs, type: 'button', onclick: () => onFree(p, s, e) }, content)
        : h('div', attrs, content));
    }

    // attended jobs
    for (const x of att) {
      const a = x.job;
      const type = ctx.typeById.get(a.build_type_id);
      const warns = warningsOf(a, p);
      const notes = notesOf(a, p);
      const cutL = x.s < T0; const cutR = x.e > T1;
      const tl = timeLabel(a, iso) || `${fmtMin(x.s)}–${fmtMin(x.e)}`;
      const pausing = a.pause_for_breaks !== false;
      const inner = pausing ? day.breaks.filter((b) => b.s < x.e && x.s < b.e) : [];
      const pausedMin = inner.reduce((t, b) => t + Math.min(x.e, b.e) - Math.max(x.s, b.s), 0);
      const part = ctx.partInfo ? ctx.partInfo(a) : null;
      track.append(h('button', {
        type: 'button',
        class: `dt-job ${warns.length ? 'dt-warn' : ''} ${cutL ? 'cut-l' : ''} ${cutR ? 'cut-r' : ''}`,
        style: `left:${pos(x.s)}%;width:${width(x.s, x.e)}%;--lane:${x.lane};${type ? `--type-color:${type.color}` : ''}`,
        title: [jobText(ctx, a), type?.name, tl, a.equipment_id ? `Equipment: ${ctx.equipmentLabel ? ctx.equipmentLabel(a.equipment_id) : ctx.equipmentById.get(a.equipment_id)?.name}` : null,
          pausedMin ? `Pauses for ${day.breaks.filter((b) => b.s < x.e && x.s < b.e).map((b) => b.label.toLowerCase()).join(' and ')} (${pausedMin} min)` : null,
          part ? `Continued job: part ${part.n} of ${part.total}` : null,
          a.recurring_id ? 'Recurring job' : null, a.notes, ...warns.map((w) => `⚠ ${w}`), ...notes.map((w) => `⏰ ${w}`)].filter(Boolean).join('\n'),
        onclick: () => onJob(a, p),
      },
        inner.map((b) => h('span', { class: 'dt-job-brk', 'aria-hidden': 'true', title: `${b.label} — job paused`,
          style: `left:${((Math.max(x.s, b.s) - x.s) / (x.e - x.s)) * 100}%;width:${((Math.min(x.e, b.e) - Math.max(x.s, b.s)) / (x.e - x.s)) * 100}%` })),
        h('span', { class: 'dt-job-l' }, warns.length ? h('b', { class: 'chip-warn-icon' }, '!') : null, notes.length ? '⏰ ' : null, part ? `↪ ${part.n}/${part.total} ` : null, a.recurring_id ? '🔁 ' : null, jobText(ctx, a)),
        h('span', { class: 'dt-job-t' }, cutL ? `‹ ${tl}` : cutR ? `${tl} ›` : `${hm(a.start_time) && x.s >= 0 ? fmtMin(x.s) : '…'}–${x.e <= 1440 ? fmtMin(x.e) : `${fmtMin(x.e)} +1`}`,
          pausedMin ? ` (incl. ${pausedMin} min break)` : ''),
      ));
    }

    // background: thin striped bands under the row
    bgs.forEach((x, i) => {
      const a = x.job;
      const type = ctx.typeById.get(a.build_type_id);
      const s = x.untimed ? T0 : x.s; const e = x.untimed ? T1 : x.e;
      track.append(h('button', {
        type: 'button', class: 'dt-bg', style: `left:${pos(s)}%;width:${Math.max(width(s, e), 1.5)}%;--bgi:${i};${type ? `--type-color:${type.color}` : ''}`,
        title: `⏱ Background (doesn’t keep ${p.name} busy)\n${jobText(ctx, a)}\n${timeLabel(a, iso) || 'all day'}`,
        onclick: () => onJob(a, p),
      }, h('span', {}, '⏱ ', jobText(ctx, a), s < T0 || e > T1 ? ` · ${timeLabel(a, iso) || ''}` : '')));
    });

    if (absence) {
      track.append(h('div', { class: `dt-absent absence-${absence.absence_type}` }, ABSENCE_TYPES[absence.absence_type] || 'Absent',
        absence.end_date > iso ? ` until ${fmtDayShort(fromISO(absence.end_date))}` : ''));
    } else if (day.nonWorking) {
      track.append(h('div', { class: 'dt-nonwork' }, 'Not working today', day.hours?.oneOff ? ' (one-off)' : day.hours?.pattern ? ` · ${day.hours.pattern.name}` : ''));
    }
    track.append(nowLine());

    const untimedCell = h('div', { class: 'dt-untimed' },
      day.untimed.map((a) => {
        const type = ctx.typeById.get(a.build_type_id);
        return h('button', {
          type: 'button', class: 'dt-ut-job', style: type ? `--type-color:${type.color}` : false,
          title: admin ? 'No start time — click to add times' : 'No start time set', onclick: () => onJob(a, p),
        }, h('span', {}, jobText(ctx, a)), admin ? h('span', { class: 'dt-ut-cta' }, '+ Add times') : h('span', { class: 'dt-ut-cta' }, 'Times not set'));
      }));

    const hrs = day.hours;
    return h('div', { class: `dt-row ${absence ? 'is-absent' : ''} ${day.nonWorking ? 'is-offday' : ''}`, 'data-person': p.id },
      h('div', { class: 'dt-name' }, h('b', {}, p.name),
        h('small', { class: 'dt-hours' }, absence ? (ABSENCE_TYPES[absence.absence_type] || 'Absent') : day.nonWorking ? 'Not working' : `${fmtMin(day.ws)}–${fmtMin(day.we)}${hrs?.oneOff ? ' (today only)' : ''}`),
        absence || day.nonWorking ? null : h('small', {}, busyFreeText(day))),
      track, untimedCell);
  });

  const el = h('div', { class: 'dt-scroll', style: `--cols:${cols}` }, h('div', { class: 'dt-grid' }, header, capRows, rowEls));
  return {
    el,
    /** Scroll so minute `m` sits just right of the names (narrow screens). */
    scrollTo(m) {
      const track = el.querySelector('.dt-row:not(.dt-head) .dt-track');
      if (track && el.scrollWidth > el.clientWidth) el.scrollLeft = Math.max(0, (track.offsetWidth * pos(m)) / 100 - 20);
    },
    placeNow(m) {
      const inside = isToday && m >= T0 && m <= T1;
      for (const n of nowLines) { n.style.display = inside ? 'block' : 'none'; n.style.left = `${pos(m)}%`; }
      if (nowLines[0]) nowLines[0].dataset.t = fmtMin(m);
    },
  };
}

// ------------------------------------------------------------------ mini timeline (job form)
/**
 * The person's day with the job being edited shown on top.
 * jobs: the person's other jobs that day; proposed: { s, e, bg } or null.
 */
export function miniDay({ ctx, jobs, iso, hours, absent, proposed, onPick }) {
  const day = personDay({ jobs, iso, isBg: ctx.isBg, hours, absent });
  const { T0, T1 } = viewRange(day);
  const pos = (m) => ((Math.min(T1, Math.max(T0, m)) - T0) / (T1 - T0)) * 100;
  const width = (s, e) => Math.max(pos(e) - pos(s), 0.8);
  const ticks = []; for (let m = Math.ceil(T0 / 60) * 60; m <= T1; m += 60) ticks.push(m);
  const clash = proposed && !proposed.bg && day.attended.some((x) => x.s < proposed.e && proposed.s < x.e);
  const freeTxt = day.free.map(([s, e]) => `${fmtMin(s)}–${fmtMin(e)}`).join(', ');
  return h('div', { class: 'mini-day' },
    h('div', { class: 'mini-track' },
      day.ws > T0 ? h('span', { class: 'dt-off', style: `left:0;width:${pos(day.ws)}%` }) : null,
      day.we < T1 ? h('span', { class: 'dt-off', style: `left:${pos(day.we)}%;right:0` }) : null,
      day.breaks.map((b) => h('span', { class: 'dt-break', style: `left:${pos(b.s)}%;width:${width(b.s, b.e)}%` })),
      day.free.map(([s, e]) => h(onPick ? 'button' : 'span', {
        type: onPick ? 'button' : false, class: 'mini-free', style: `left:${pos(s)}%;width:${width(s, e)}%`,
        title: `Free ${fmtMin(s)}–${fmtMin(e)}${onPick ? ' — click to use this time' : ''}`,
        onclick: onPick ? () => onPick(s, e) : false,
      })),
      day.attended.map((x) => {
        const type = ctx.typeById.get(x.job.build_type_id);
        return h('span', { class: 'mini-job', style: `left:${pos(x.s)}%;width:${width(x.s, x.e)}%;${type ? `--type-color:${type.color}` : ''}`, title: `${jobText(ctx, x.job)} ${fmtMin(x.s)}–${fmtMin(x.e)}` });
      }),
      day.background.filter((x) => !x.untimed).map((x) => h('span', { class: 'mini-bg', style: `left:${pos(x.s)}%;width:${width(x.s, x.e)}%`, title: `⏱ ${jobText(ctx, x.job)}` })),
      proposed ? h('span', { class: `mini-this ${clash ? 'clash' : ''} ${proposed.bg ? 'bg' : ''}`, style: `left:${pos(proposed.s)}%;width:${width(proposed.s, proposed.e)}%`, title: 'This job' }) : null,
      absent ? h('span', { class: 'mini-absent' }, ABSENCE_TYPES[absent.absence_type] || 'Absent') : null,
      !absent && day.nonWorking ? h('span', { class: 'mini-absent' }, 'Not working') : null,
    ),
    h('div', { class: 'mini-scale' }, ticks.map((m) => h('span', { style: `left:${pos(m)}%` }, fmtMin(m).replace(/:00$/, '')))),
    h('p', { class: `mini-cap ${clash ? 'clash' : ''}` },
      absent ? 'Absent this day.'
        : day.nonWorking ? 'Not a working day for this person.'
        : clash ? '⚠ Overlaps another attended job — see the red block.'
          : day.free.length ? `Free: ${freeTxt}${onPick ? ' · click a green gap to use it' : ''}` : 'No free time left in the working day.',
      day.untimed.length ? ` · ${day.untimed.length} other job${day.untimed.length === 1 ? '' : 's'} with no time set` : ''),
  );
}

export { toMin };
