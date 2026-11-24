import { h, mount, reportError } from '../ui.js';
import { supabase } from '../supabase.js';
import { fromISO, fmtDayShort, fmtDate } from '../dates.js';
import { ABSENCE_TYPES } from './planner.js';
import { PRIORITIES, STATUSES } from './demand.js';
import { timeSummary, hm } from '../jobs.js';

// Admin-only change history, read from audit_log (written by DB triggers).

const PAGE = 50;
const TABLES = {
  assignments: 'Planner jobs',
  absences: 'Absences',
  demand_notes: 'Demand notes',
  build_types: 'Build types',
  equipment: 'Equipment',
};
const ACTIONS = { insert: 'Added', update: 'Changed', delete: 'Deleted' };
const NOUN = { assignments: 'job', absences: 'absence', demand_notes: 'demand note', build_types: 'build type', equipment: 'equipment' };
const IGNORE = new Set(['id', 'created_at', 'created_by', 'updated_at', 'updated_by']);

let tableFilter = '';
let personFilter = '';

async function loadLookups() {
  const [people, models, tasks, types, profiles, equipment] = await Promise.all([
    supabase.from('people').select('id, name'),
    supabase.from('pump_models').select('id, name'),
    supabase.from('tasks').select('id, name'),
    supabase.from('build_types').select('id, name'),
    supabase.from('profiles').select('id, full_name, email'),
    supabase.from('equipment').select('id, name'),
  ]);
  const error = [people, models, tasks, types, profiles, equipment].find((r) => r.error)?.error;
  if (error) return { error };
  const map = (rows, label = (r) => r.name) => new Map(rows.map((r) => [r.id, label(r)]));
  return {
    people: people.data.slice().sort((a, b) => a.name.localeCompare(b.name)),
    person: map(people.data), model: map(models.data), task: map(tasks.data), type: map(types.data),
    user: map(profiles.data, (p) => p.full_name || p.email),
    equipment: map(equipment.data),
  };
}

// ---- turning a row snapshot into words
const day = (iso) => (iso ? fmtDayShort(fromISO(iso)) + ' ' + iso.slice(0, 4) : '—');
function fieldLabel(table, key) {
  return ({
    person_id: 'Person', work_date: 'Date', pump_model_id: 'Pump model', task_id: 'Task',
    build_type_id: 'Build type', qty_target: 'Quantity', notes: 'Notes', quantity: 'Quantity',
    needed_by: 'Needed by', priority: 'Priority', comment: 'Comment', status: 'Status',
    start_date: 'From', end_date: 'To', absence_type: 'Type', name: 'Name', color: 'Colour',
    is_default: 'Default', active: 'Active', sort_order: 'Order',
    start_time: 'Start time', end_time: 'End time', end_date: 'Ends on', background: 'Runs', equipment_id: 'Equipment',
  })[key] || key;
}
function fieldValue(key, v, L) {
  if (key === 'background') return v == null ? 'task default' : (v ? 'background' : 'attended');
  if (v == null || v === '') return '—';
  switch (key) {
    case 'person_id': return L.person.get(v) || '(deleted person)';
    case 'pump_model_id': return L.model.get(v) || '(deleted model)';
    case 'task_id': return L.task.get(v) || '(deleted task)';
    case 'build_type_id': return L.type.get(v) || '(deleted type)';
    case 'work_date': case 'needed_by': case 'start_date': case 'end_date': return day(v);
    case 'start_time': case 'end_time': return hm(v);
    case 'equipment_id': return L.equipment.get(v) || '(deleted equipment)';
    case 'priority': return PRIORITIES[v] || v;
    case 'status': return STATUSES[v] || v;
    case 'absence_type': return ABSENCE_TYPES[v] || v;
    case 'is_default': case 'active': return v ? 'yes' : 'no';
    default: return String(v);
  }
}

function describe(table, row, L) {
  if (!row) return '';
  const v = (k) => fieldValue(k, row[k], L);
  switch (table) {
    case 'assignments':
      return [v('person_id'), v('work_date'), timeSummary(row), row.pump_model_id && v('pump_model_id'), row.build_type_id && v('build_type_id'),
        v('task_id'), row.qty_target != null && `× ${row.qty_target}`,
        row.background === true && '⏱ background', row.background === false && 'attended',
        row.equipment_id && `on ${v('equipment_id')}`].filter(Boolean).join(' · ');
    case 'equipment':
      return row.name;
    case 'absences':
      return `${v('person_id')} · ${v('absence_type')} · ${v('start_date')}${row.end_date !== row.start_date ? ` – ${v('end_date')}` : ''}`;
    case 'demand_notes':
      return [row.pump_model_id ? v('pump_model_id') : 'General note', row.build_type_id && v('build_type_id'),
        row.quantity != null && `× ${row.quantity}`, row.needed_by && `by ${v('needed_by')}`,
        row.comment && `“${row.comment.length > 60 ? row.comment.slice(0, 57) + '…' : row.comment}”`].filter(Boolean).join(' · ');
    case 'build_types':
      return row.name;
    default:
      return '';
  }
}

function changes(table, oldRow, newRow, L) {
  if (!oldRow || !newRow) return [];
  return Object.keys(newRow)
    .filter((k) => !IGNORE.has(k) && JSON.stringify(oldRow[k]) !== JSON.stringify(newRow[k]))
    .map((k) => ({ label: fieldLabel(table, k), from: fieldValue(k, oldRow[k], L), to: fieldValue(k, newRow[k], L) }));
}

// ---- page
export async function renderHistory(main) {
  mount(main, h('h1', { class: 'page-title' }, 'History'), h('p', { class: 'muted' }, 'Loading…'));
  const L = await loadLookups();
  if (reportError(L.error, 'Loading history')) return;

  const list = h('div', { class: 'history-list' });
  const more = h('button', { class: 'btn', hidden: true }, 'Load older changes');
  const status = h('p', { class: 'muted small' });
  let offset = 0;

  const loadPage = async () => {
    more.disabled = true;
    let q = supabase.from('audit_log')
      .select('id, table_name, record_id, action, old_data, new_data, changed_by, changed_at')
      .order('changed_at', { ascending: false }).order('id', { ascending: false })
      .range(offset, offset + PAGE - 1);
    if (tableFilter) q = q.eq('table_name', tableFilter);
    if (personFilter) {
      q = q.or(`new_data->>person_id.eq.${personFilter},old_data->>person_id.eq.${personFilter}`);
    }
    const { data, error } = await q;
    more.disabled = false;
    if (reportError(error, 'Loading history')) return;
    offset += data.length;
    let lastDay = list.lastElementChild?.dataset?.day;
    for (const e of data) {
      const when = new Date(e.changed_at);
      const dayKey = when.toDateString();
      if (dayKey !== lastDay) {
        list.append(h('h3', { class: 'history-day', dataset: { day: dayKey } }, fmtDate(when)));
        lastDay = dayKey;
      }
      list.append(entry(e, L, when));
    }
    if (!offset) list.append(h('p', { class: 'card empty' }, 'No changes recorded yet.'));
    more.hidden = data.length < PAGE;
    status.textContent = offset ? `Showing ${offset} change${offset === 1 ? '' : 's'}${more.hidden ? '' : ' (newest first)'}` : '';
  };
  more.addEventListener('click', loadPage);

  const restart = () => { offset = 0; list.replaceChildren(); loadPage(); };
  const tableSel = h('select', { onchange: (e) => { tableFilter = e.target.value; restart(); } },
    [['', 'Everything'], ...Object.entries(TABLES)].map(([v, l]) => {
      const o = h('option', { value: v }, l);
      if (v === tableFilter) o.selected = true;
      return o;
    }));
  const personSel = h('select', { onchange: (e) => { personFilter = e.target.value; restart(); } },
    [['', 'Anyone'], ...L.people.map((p) => [p.id, p.name])].map(([v, l]) => {
      const o = h('option', { value: v }, l);
      if (v === personFilter) o.selected = true;
      return o;
    }));

  mount(main,
    h('div', { class: 'page-head' }, h('h1', { class: 'page-title' }, 'History')),
    h('p', { class: 'muted small' }, 'Every change to planner jobs, absences, demand notes, build types and equipment, recorded automatically by the database. Only admins can see this page, and entries cannot be edited.'),
    h('div', { class: 'filter-bar card' },
      h('div', { class: 'field' }, h('label', {}, 'Show', tableSel)),
      h('div', { class: 'field' }, h('label', {}, 'Team member (jobs & absences)', personSel)),
    ),
    status,
    list,
    h('div', { class: 'history-more' }, more),
  );
  await loadPage();
}

function entry(e, L, when) {
  const row = e.new_data || e.old_data;
  const diffs = e.action === 'update' ? changes(e.table_name, e.old_data, e.new_data, L) : [];
  return h('article', { class: `history-entry action-${e.action}` },
    h('div', { class: 'history-meta' },
      h('span', { class: 'history-time' }, when.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })),
      h('span', { class: `history-action` }, ACTIONS[e.action]),
      h('span', { class: 'muted small' }, NOUN[e.table_name] || e.table_name),
      h('span', { class: 'history-user' }, `by ${e.changed_by ? (L.user.get(e.changed_by) || 'unknown user') : 'system'}`),
    ),
    h('div', { class: 'history-what' }, describe(e.table_name, row, L)),
    diffs.length
      ? h('ul', { class: 'history-diffs' }, diffs.map((d) => h('li', {},
          h('span', { class: 'diff-label' }, `${d.label}: `),
          h('span', { class: 'diff-from' }, d.from), ' → ', h('span', { class: 'diff-to' }, d.to))))
      : (e.action === 'update' ? h('p', { class: 'muted small history-nochange' }, 'No visible field changed.') : null),
  );
}
