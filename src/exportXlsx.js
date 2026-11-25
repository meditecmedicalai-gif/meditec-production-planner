// Excel writer (ExcelJS). Loaded only when someone clicks "Export to Excel".
import ExcelJS from 'exceljs';

const BRAND = 'FF7C1874';
const HEAD_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5E7F2' } };
const TOTAL_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3EEF0' } };
const KIND_FILL = {
  free: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE6F6EA' } },
  break: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1ECE8' } },
  lunch: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1ECE8' } },
  absent: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE3F0F8' } },
  off: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F5F5' } },
};

/** "2026-11-23" → a real Excel date (UTC midnight, so no timezone shift). */
const xlDate = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
/** minutes → Excel time (fraction of a day). */
const xlTime = (m) => (m == null ? null : m / 1440);
const colLetter = (n) => { let s = ''; for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };

function sheet(wb, name, columns) {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }], properties: { defaultRowHeight: 18 } });
  ws.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width || 14, style: c.style || {} }));
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: BRAND } };
  head.fill = HEAD_FILL;
  head.alignment = { vertical: 'middle', wrapText: true };
  head.height = 22;
  head.border = { bottom: { style: 'thin', color: { argb: BRAND } } };
  return ws;
}
function finish(ws, { lastDataRow, cols }) {
  if (lastDataRow >= 1) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: lastDataRow, column: cols } };
}
function totalRow(ws, values, sumCols, firstRow, lastRow) {
  const row = ws.addRow(values);
  for (const c of sumCols) {
    const L = colLetter(c);
    row.getCell(c).value = lastRow >= firstRow ? { formula: `SUM(${L}${firstRow}:${L}${lastRow})` } : 0;
  }
  row.font = { bold: true };
  row.fill = TOTAL_FILL;
  row.border = { top: { style: 'thin' } };
  return row;
}

const DATE_FMT = 'ddd dd/mm/yyyy';
const TIME_FMT = 'hh:mm';
const HOURS_FMT = '0.00';

export async function buildWorkbook(data, { from, to, title }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Meditec Production Room Planning';
  wb.created = new Date();
  wb.title = title;

  // a) Timesheet
  const ts = sheet(wb, 'Timesheet', [
    { header: 'Date', key: 'date', width: 15, style: { numFmt: DATE_FMT } },
    { header: 'Person', key: 'person', width: 18 },
    { header: 'Start', key: 'start', width: 8, style: { numFmt: TIME_FMT } },
    { header: 'End', key: 'end', width: 8, style: { numFmt: TIME_FMT } },
    { header: 'Duration (hours)', key: 'hours', width: 10, style: { numFmt: HOURS_FMT } },
    { header: 'Category', key: 'category', width: 11 },
    { header: 'Task', key: 'task', width: 26 },
    { header: 'Pump model', key: 'pump', width: 24 },
    { header: 'Quantity', key: 'qty', width: 9 },
    { header: 'Units done', key: 'qtyDone', width: 9 },
    { header: 'Build type', key: 'type', width: 12 },
    { header: 'Station', key: 'station', width: 22 },
    { header: 'Attended / Background', key: 'mode', width: 13 },
    { header: 'Recurring', key: 'recurring', width: 10 },
    { header: 'Notes', key: 'notes', width: 40 },
  ]);
  for (const r of data.timesheet) {
    const row = ts.addRow({
      date: xlDate(r.date), person: r.person, start: xlTime(r.start), end: xlTime(r.end === 1440 ? 1439.99 : r.end),
      hours: r.minutes != null ? Math.round((r.minutes / 60) * 100) / 100 : null,
      category: r.category || '', task: r.task, pump: r.pump || '', qty: r.qty ?? null, qtyDone: r.qtyDone ?? null, type: r.type || '', station: r.station || '',
      mode: r.mode || '', recurring: r.recurring || '', notes: r.notes || '',
    });
    if (KIND_FILL[r.kind]) row.fill = KIND_FILL[r.kind];
    if (r.kind === 'free') row.getCell('task').font = { bold: true, color: { argb: 'FF15803D' } };
    if (r.category === 'Office') row.getCell('category').font = { color: { argb: 'FF5B6B82' }, bold: true };
  }
  const tsLast = ts.rowCount;
  finish(ts, { lastDataRow: tsLast, cols: 15 });
  const tsTotal = totalRow(ts, { date: null, person: 'Total (filtered rows)' }, [], 2, tsLast);
  if (tsLast >= 2) tsTotal.getCell(5).value = { formula: `SUBTOTAL(109,E2:E${tsLast})` };
  tsTotal.getCell(5).numFmt = HOURS_FMT;

  // b) Absences
  const ab = sheet(wb, 'Absences', [
    { header: 'Date', key: 'date', width: 15, style: { numFmt: DATE_FMT } },
    { header: 'Person', key: 'person', width: 18 },
    { header: 'Type', key: 'type', width: 12 },
    { header: 'Hours', key: 'hours', width: 9, style: { numFmt: HOURS_FMT } },
    { header: 'Notes', key: 'notes', width: 40 },
  ]);
  for (const r of data.absences) ab.addRow({ ...r, date: xlDate(r.date), hours: Math.round(r.hours * 100) / 100 });
  const abLast = ab.rowCount;
  finish(ab, { lastDataRow: abLast, cols: 5 });
  totalRow(ab, { person: 'Total' }, [4], 2, abLast).getCell(4).numFmt = HOURS_FMT;

  // c) Summary by person
  const tcols = data.byPerson.tasks;
  const sp = sheet(wb, 'Summary by person', [
    { header: 'Person', key: 'person', width: 20 },
    ...tcols.map((t, i) => ({ header: `${t} (h)`, key: `t${i}`, width: 13, style: { numFmt: HOURS_FMT } })),
    { header: 'Production (h)', key: 'production', width: 12, style: { numFmt: HOURS_FMT } },
    { header: 'Office / non-production (h)', key: 'office', width: 14, style: { numFmt: HOURS_FMT } },
    { header: 'Total busy (h)', key: 'busy', width: 12, style: { numFmt: HOURS_FMT } },
    { header: 'Free (h)', key: 'free', width: 10, style: { numFmt: HOURS_FMT } },
    { header: 'Break & lunch (h)', key: 'brk', width: 12, style: { numFmt: HOURS_FMT } },
    { header: 'Absent (h)', key: 'absent', width: 10, style: { numFmt: HOURS_FMT } },
    { header: 'Jobs with no time', key: 'untimed', width: 11 },
  ]);
  const r2 = (v) => Math.round(v * 100) / 100;
  for (const r of data.byPerson.rows) {
    sp.addRow({ person: r.person, ...Object.fromEntries(r.tasks.map((v, i) => [`t${i}`, r2(v)])), production: r2(r.production || 0), office: r2(r.office || 0), busy: r2(r.busy), free: r2(r.free), brk: r2(r.brk), absent: r2(r.absent), untimed: r.untimed });
  }
  const spLast = sp.rowCount; const spCols = tcols.length + 8;
  finish(sp, { lastDataRow: spLast, cols: spCols });
  const spTot = totalRow(sp, { person: 'Total' }, [...Array(spCols - 1)].map((_, i) => i + 2), 2, spLast);
  for (let c = 2; c < spCols; c++) spTot.getCell(c).numFmt = HOURS_FMT;
  for (const c of [tcols.length + 2, tcols.length + 3, tcols.length + 4]) sp.getRow(1).getCell(c).font = { bold: true, color: { argb: BRAND } };

  // d) Summary by pump
  const pu = sheet(wb, 'Summary by pump', [
    { header: 'Pump model', key: 'model', width: 26 },
    { header: 'Build type', key: 'type', width: 14 },
    { header: 'Units built (output tasks)', key: 'built', width: 14 },
    { header: 'Pumps tested', key: 'tested', width: 12 },
    { header: 'Other units (repair, rework…)', key: 'other', width: 16 },
    { header: 'Built for demand notes (linked)', key: 'linked', width: 15 },
    { header: 'Units done on jobs', key: 'unitsDone', width: 12 },
    { header: 'Jobs', key: 'jobs', width: 8 },
    { header: 'Demand due', key: 'demand', width: 10 },
    { header: 'Completed (last stage)', key: 'completed', width: 12 },
    { header: 'Still to do', key: 'toDo', width: 10 },
  ]);
  for (const r of data.byPump) pu.addRow(r);
  const puLast = pu.rowCount;
  finish(pu, { lastDataRow: puLast, cols: 11 });
  totalRow(pu, { model: 'Total' }, [3, 4, 5, 6, 7, 8, 9, 10, 11], 2, puLast);

  // Demand — notes and the jobs planned for them
  const dm = sheet(wb, 'Demand', [
    { header: 'Pump model', key: 'model', width: 24 },
    { header: 'Build type', key: 'type', width: 12 },
    { header: 'Needed', key: 'needed', width: 9 },
    { header: 'Needed by', key: 'neededBy', width: 15, style: { numFmt: DATE_FMT } },
    { header: 'Planned (jobs + manual)', key: 'planned', width: 12 },
    { header: 'of which manual', key: 'plannedManual', width: 10 },
    { header: 'Still to plan', key: 'toPlan', width: 10 },
    { header: 'Completed', key: 'completed', width: 10 },
    { header: 'Still to do', key: 'toDo', width: 10 },
    { header: 'Status', key: 'status', width: 22 },
    { header: 'Stages (planned / done)', key: 'stages', width: 60 },
    { header: 'Planned too late (finishes)', key: 'tooLate', width: 15, style: { numFmt: DATE_FMT } },
    { header: 'Linked jobs', key: 'jobs', width: 50 },
    { header: 'Priority', key: 'priority', width: 9 },
    { header: 'Asked by', key: 'askedBy', width: 16 },
    { header: 'Comment', key: 'comment', width: 40 },
  ]);
  for (const r of data.demand || []) {
    const row = dm.addRow({ ...r, neededBy: r.neededBy ? xlDate(r.neededBy) : null, tooLate: r.tooLate ? xlDate(r.tooLate) : null });
    if (r.tooLate) row.getCell('tooLate').font = { bold: true, color: { argb: 'FFB93A26' } };
  }
  const dmLast = dm.rowCount;
  finish(dm, { lastDataRow: dmLast, cols: 16 });
  totalRow(dm, { model: 'Total' }, [3, 5, 6, 7, 8, 9], 2, dmLast);

  // To-dos
  const td = sheet(wb, 'To-dos', [
    { header: 'To-do', key: 'title', width: 34 },
    { header: 'For', key: 'owner', width: 16 },
    { header: 'Due', key: 'due', width: 15, style: { numFmt: DATE_FMT } },
    { header: 'Priority', key: 'priority', width: 9 },
    { header: 'Status', key: 'status', width: 12 },
    { header: 'Overdue', key: 'overdue', width: 9 },
    { header: 'Checklist', key: 'checklist', width: 10 },
    { header: 'Scheduled time blocks', key: 'scheduled', width: 40 },
    { header: 'Scheduled (h)', key: 'hours', width: 10, style: { numFmt: HOURS_FMT } },
    { header: 'Added by', key: 'addedBy', width: 16 },
    { header: 'Details', key: 'details', width: 40 },
  ]);
  for (const r of data.todos || []) {
    const row = td.addRow({ ...r, due: r.due ? xlDate(r.due) : null, hours: Math.round(r.hours * 100) / 100 });
    if (r.overdue === 'Y') row.getCell('overdue').font = { bold: true, color: { argb: 'FFB93A26' } };
  }
  finish(td, { lastDataRow: td.rowCount, cols: 11 });

  // e) Test capacity
  const capCols = [{ header: 'Date', key: 'date', width: 15, style: { numFmt: DATE_FMT } }];
  data.capacity.areas.forEach((a, i) => {
    if (a.sequential) {
      capCols.push({ header: `${a.name}: busy hours`, key: `a${i}h`, width: 14, style: { numFmt: HOURS_FMT } },
        { header: `${a.name}: busy times`, key: `a${i}t`, width: 22 },
        { header: `${a.name}: jobs overlap`, key: `a${i}o`, width: 12 });
    } else {
      capCols.push({ header: `${a.name}: peak pumps (max ${a.max})`, key: `a${i}p`, width: 14 },
        { header: `${a.name}: time of peak`, key: `a${i}t`, width: 12 },
        { header: `${a.name}: over limit`, key: `a${i}o`, width: 10 });
    }
  });
  capCols.push({ header: 'Test jobs with no time (not counted)', key: 'untimed', width: 14 }, { header: 'Untimed jobs', key: 'untimedJobs', width: 40 });
  const cp = sheet(wb, 'Test capacity', capCols);
  for (const r of data.capacity.rows) {
    const v = { date: xlDate(r.date), untimed: r.untimed, untimedJobs: r.untimedJobs };
    r.areas.forEach((a, i) => {
      if (data.capacity.areas[i].sequential) Object.assign(v, { [`a${i}h`]: Math.round(a.busyHours * 100) / 100, [`a${i}t`]: a.busy, [`a${i}o`]: a.overlap });
      else Object.assign(v, { [`a${i}p`]: a.peak, [`a${i}t`]: a.at, [`a${i}o`]: a.over });
    });
    const row = cp.addRow(v);
    r.areas.forEach((a, i) => {
      if ((a.over || a.overlap) === 'Y') row.getCell(`a${i}o`).font = { bold: true, color: { argb: 'FFB93A26' } };
    });
  }
  finish(cp, { lastDataRow: cp.rowCount, cols: capCols.length });

  for (const ws of wb.worksheets) {
    ws.pageSetup = { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: '1:1' };
    ws.headerFooter = { oddHeader: `&L${title}&RMeditec Medical Ltd`, oddFooter: '&LPrinted &D&RPage &P of &N' };
  }
  return wb;
}

export async function downloadWorkbook(wb, filename) {
  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
