import { h, mount, toast, reportError, openModal, confirmDialog, field, checkbox } from '../ui.js';
import { supabase } from '../supabase.js';
import { auth } from '../auth.js';
import { toISO, fromISO, today, addDays, fmtDayShort, fmtDate } from '../dates.js';

export const PRIORITIES = { urgent: 'Urgent', high: 'High', normal: 'Normal', low: 'Low' };
const PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, low: 3 };
export const STATUSES = { open: 'Open', planned: 'Planned', done: 'Done' };

// ------------------------------------------------------------------ data
/** Loads demand notes plus the lookups needed to display them. */
export async function loadDemand({ onlyActive = false } = {}) {
  let q = supabase.from('demand_notes')
    .select('id, pump_model_id, build_type_id, quantity, needed_by, priority, comment, status, created_by, created_at, updated_by, updated_at');
  if (onlyActive) q = q.in('status', ['open', 'planned']);
  const [notes, models, types, profiles] = await Promise.all([
    q,
    supabase.from('pump_models').select('id, name, short_code, active, sort_order').order('sort_order').order('name'),
    supabase.from('build_types').select('id, name, color, is_default, active, sort_order').order('sort_order').order('name'),
    supabase.from('profiles').select('id, full_name, email'),
  ]);
  const error = [notes, models, types, profiles].find((r) => r.error)?.error;
  if (error) return { error };
  return {
    notes: sortNotes(notes.data),
    models: models.data, modelById: new Map(models.data.map((m) => [m.id, m])),
    types: types.data, typeById: new Map(types.data.map((t) => [t.id, t])),
    nameOf: (id) => {
      const p = profiles.data.find((x) => x.id === id);
      return p ? (p.full_name || p.email) : 'someone';
    },
  };
}

/** Not-done first; then by needed-by date (no date last); then priority. */
export function sortNotes(notes) {
  return notes.slice().sort((a, b) =>
    (a.status === 'done') - (b.status === 'done')
    || (a.needed_by ?? '9999').localeCompare(b.needed_by ?? '9999')
    || PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
    || b.created_at.localeCompare(a.created_at));
}

export const canEdit = (note) => auth.isAdmin || note.created_by === auth.session?.user.id;

// ------------------------------------------------------------------ display pieces
export function typeTag(type) {
  return h('span', { class: 'type-tag', style: `--type-color:${type.color}` }, type.name);
}

/** "Overdue 2 days" / "Due today" / "Due Fri 27 Nov" badge. */
export function dueBadge(note) {
  if (!note.needed_by) return h('span', { class: 'due due-none' }, 'No date');
  const d = fromISO(note.needed_by);
  const days = Math.round((d - today()) / 86400000);
  if (note.status === 'done') return h('span', { class: 'due due-done' }, `By ${fmtDayShort(d)}`);
  if (days < 0) return h('span', { class: 'due due-overdue' }, `Overdue · ${fmtDayShort(d)}`);
  if (days === 0) return h('span', { class: 'due due-soon' }, 'Due today');
  if (days <= 7) return h('span', { class: 'due due-soon' }, `By ${fmtDayShort(d)}`);
  return h('span', { class: 'due' }, `By ${fmtDayShort(d)}`);
}

export const priorityBadge = (p) => h('span', { class: `prio prio-${p}` }, PRIORITIES[p] || p);
export const statusBadge = (s) => h('span', { class: `status status-${s}` }, STATUSES[s] || s);

/** One-line headline: "QPro 2000 [Trial] × 10" or "General note". */
export function headline(note, ctx) {
  const model = ctx.modelById.get(note.pump_model_id);
  const type = ctx.typeById.get(note.build_type_id);
  return h('span', { class: 'demand-headline' },
    h('span', { class: 'demand-model' }, model ? model.name : 'General note'),
    type ? typeTag(type) : null,
    note.quantity != null ? h('span', { class: 'demand-qty' }, `× ${note.quantity}`) : null,
  );
}

// ------------------------------------------------------------------ actions
export async function setStatus(note, status, onSaved) {
  const { error } = await supabase.from('demand_notes').update({ status }).eq('id', note.id);
  if (reportError(error, 'Updating status')) return;
  toast(`Marked ${STATUSES[status].toLowerCase()}.`, 'success');
  onSaved();
}

export async function deleteNote(note, onSaved) {
  if (!(await confirmDialog('Delete note?', 'Delete this demand note permanently? (The change history keeps a record.) To close it instead, mark it Done.'))) return false;
  const { error } = await supabase.from('demand_notes').delete().eq('id', note.id);
  if (reportError(error, 'Deleting')) return false;
  toast('Note deleted.', 'success');
  onSaved();
  return true;
}

function options(rows, selectedId, blank) {
  const list = rows.filter((r) => r.active || r.id === selectedId);
  return [
    h('option', { value: '' }, blank),
    ...list.map((r) => {
      const o = h('option', { value: r.id }, r.name + (r.active ? '' : ' (inactive)'));
      if (r.id === selectedId) o.selected = true;
      return o;
    }),
  ];
}

function enumOptions(map, selected) {
  return Object.entries(map).map(([k, v]) => {
    const o = h('option', { value: k }, v);
    if (k === selected) o.selected = true;
    return o;
  });
}

/** Add / edit a demand note. Viewers can only open their own notes here. */
export function editDemand(ctx, note, onSaved) {
  const isNew = !note;
  const model = h('select', {}, options(ctx.models, note?.pump_model_id, '— General / not model-specific —'));
  const defaultType = ctx.types.find((t) => t.is_default);
  const type = h('select', {}, options(ctx.types, isNew ? defaultType?.id : note.build_type_id, '— Not specified —'));
  const qty = h('input', { type: 'number', min: 0, step: 1, inputmode: 'numeric', value: note?.quantity ?? '' });
  const neededBy = h('input', { type: 'date', value: note?.needed_by ?? '' });
  const priority = h('select', {}, enumOptions(PRIORITIES, note?.priority ?? 'normal'));
  const status = h('select', {}, enumOptions(STATUSES, note?.status ?? 'open'));
  const comment = h('textarea', { rows: 3, maxlength: 1000, placeholder: 'e.g. Need 10 more for the NHS order by Friday; trial units for the new valve' }, note?.comment ?? '');
  const error = h('p', { class: 'form-error', role: 'alert' });

  const actions = [];
  if (!isNew && auth.isAdmin) actions.push({ label: 'Delete', variant: 'danger', onClick: () => deleteNote(note, onSaved) });
  actions.push({ label: 'Cancel' }, {
    label: isNew ? 'Post note' : 'Save',
    variant: 'primary',
    onClick: async () => {
      error.textContent = '';
      const values = {
        pump_model_id: model.value || null,
        build_type_id: type.value || null,
        quantity: qty.value === '' ? null : Number(qty.value),
        needed_by: neededBy.value || null,
        priority: priority.value,
        status: status.value,
        comment: comment.value.trim() || null,
      };
      if (!values.pump_model_id && !values.comment) { error.textContent = 'Choose a pump model or write a comment.'; return false; }
      if (values.quantity != null && (!Number.isInteger(values.quantity) || values.quantity < 0)) {
        error.textContent = 'Quantity must be a whole number (0 or more).'; return false;
      }
      const { error: err } = isNew
        ? await supabase.from('demand_notes').insert(values)
        : await supabase.from('demand_notes').update(values).eq('id', note.id);
      if (reportError(err, 'Saving note')) return false;
      toast(isNew ? 'Note posted.' : 'Note saved.', 'success');
      onSaved();
      return true;
    },
  });

  openModal({
    title: isNew ? 'New demand note' : 'Edit demand note',
    body: h('div', { class: 'stack' },
      h('div', { class: 'form-grid form-grid-2' }, field('Pump model', model), field('Build type', type)),
      h('div', { class: 'form-grid form-grid-3' },
        field('Quantity', qty), field('Needed by', neededBy), field('Priority', priority)),
      field('Comment', comment),
      field('Status', status, 'Open = not yet planned · Planned = in the schedule · Done = delivered / no longer needed'),
      note ? h('p', { class: 'muted small' }, attribution(note, ctx)) : null,
      error,
    ),
    actions,
  });
  (isNew ? model : comment).focus();
}

export function attribution(note, ctx) {
  const posted = `Posted by ${ctx.nameOf(note.created_by)} on ${fmtDate(new Date(note.created_at))}`;
  const edited = note.updated_by && (note.updated_by !== note.created_by || note.updated_at.slice(0, 16) !== note.created_at.slice(0, 16))
    ? ` · last edited by ${ctx.nameOf(note.updated_by)} on ${fmtDate(new Date(note.updated_at))}` : '';
  return posted + edited;
}

/** Status buttons offered on a note the current user may edit. */
function statusButtons(note, onSaved) {
  if (!canEdit(note)) return [];
  const b = (label, s, variant) => h('button', { class: `btn btn-sm ${variant || ''}`, onclick: () => setStatus(note, s, onSaved) }, label);
  if (note.status === 'open') return [b('Mark planned', 'planned'), b('Mark done', 'done')];
  if (note.status === 'planned') return [b('Mark done', 'done'), b('Back to open', 'open', 'btn-ghost')];
  return [b('Reopen', 'open', 'btn-ghost')];
}

// ------------------------------------------------------------------ page
const FILTER_KEY = 'demandFilters';
const defaultFilters = { status: 'active', model: '', type: '', priority: '', mine: false };
let filters = (() => {
  try { return { ...defaultFilters, ...JSON.parse(localStorage.getItem(FILTER_KEY) || '{}') }; } catch { return { ...defaultFilters }; }
})();
const saveFilters = () => { try { localStorage.setItem(FILTER_KEY, JSON.stringify(filters)); } catch { /* ignore */ } };

export async function renderDemand(main) {
  const ctx = await loadDemand();
  if (reportError(ctx.error, 'Loading demand notes')) return;
  const reload = () => renderDemand(main);
  const me = auth.session.user.id;

  const matches = (n) =>
    (filters.status === 'all' || (filters.status === 'active' ? n.status !== 'done' : n.status === filters.status))
    && (!filters.model || n.pump_model_id === filters.model)
    && (!filters.type || (filters.type === 'none' ? !n.build_type_id : n.build_type_id === filters.type))
    && (!filters.priority || n.priority === filters.priority)
    && (!filters.mine || n.created_by === me);
  const shown = ctx.notes.filter(matches);

  // ---- filter bar
  const sel = (key, opts) => {
    const s = h('select', { onchange: (e) => { filters[key] = e.target.value; saveFilters(); reload(); } },
      opts.map(([v, label]) => {
        const o = h('option', { value: v }, label);
        if (v === filters[key]) o.selected = true;
        return o;
      }));
    return s;
  };
  const countBy = (s) => ctx.notes.filter((n) => n.status === s).length;
  const filterBar = h('div', { class: 'filter-bar card' },
    field('Status', sel('status', [
      ['active', `Open & planned (${countBy('open') + countBy('planned')})`],
      ['open', `Open (${countBy('open')})`], ['planned', `Planned (${countBy('planned')})`],
      ['done', `Done (${countBy('done')})`], ['all', `All (${ctx.notes.length})`],
    ])),
    field('Pump model', sel('model', [['', 'All models'], ...ctx.models.map((m) => [m.id, m.name])])),
    field('Build type', sel('type', [['', 'All types'], ...ctx.types.map((t) => [t.id, t.name]), ['none', 'Not specified']])),
    field('Priority', sel('priority', [['', 'Any priority'], ...Object.entries(PRIORITIES)])),
    h('div', { class: 'filter-check' },
      checkbox('Only my notes', filters.mine, { onchange: (e) => { filters.mine = e.target.checked; saveFilters(); reload(); } }).el),
    JSON.stringify(filters) !== JSON.stringify(defaultFilters)
      ? h('button', { class: 'btn btn-sm btn-ghost filter-reset', onclick: () => { filters = { ...defaultFilters }; saveFilters(); reload(); } }, 'Reset filters')
      : null,
  );

  // ---- list
  const list = shown.length
    ? h('div', { class: 'demand-list' }, shown.map((n) => noteCard(n, ctx, reload)))
    : h('div', { class: 'card empty' }, ctx.notes.length ? 'No notes match these filters.' : 'No demand notes yet. Use "New note" to post one.');

  mount(main,
    h('div', { class: 'page-head' },
      h('h1', { class: 'page-title' }, 'Demand & Notes'),
      h('button', { class: 'btn btn-primary', onclick: () => editDemand(ctx, null, reload) }, '+ New note'),
    ),
    filterBar,
    h('p', { class: 'muted small result-count' }, `${shown.length} note${shown.length === 1 ? '' : 's'}`),
    list,
  );
}

function noteCard(n, ctx, reload) {
  const editable = canEdit(n);
  return h('article', { class: `demand-card card prio-edge-${n.priority} ${n.status === 'done' ? 'is-done' : ''}` },
    h('div', { class: 'demand-top' },
      headline(n, ctx),
      h('div', { class: 'demand-badges' }, dueBadge(n), priorityBadge(n.priority), statusBadge(n.status)),
    ),
    n.comment ? h('p', { class: 'demand-comment' }, n.comment) : null,
    h('div', { class: 'demand-foot' },
      h('span', { class: 'muted small' }, attribution(n, ctx)),
      h('div', { class: 'demand-actions' },
        statusButtons(n, reload),
        editable ? h('button', { class: 'btn btn-sm', onclick: () => editDemand(ctx, n, reload) }, 'Edit') : null,
        auth.isAdmin ? h('button', { class: 'btn btn-sm btn-danger', onclick: () => deleteNote(n, reload) }, 'Delete') : null,
      ),
    ),
  );
}

// ------------------------------------------------------------------ planner panel
let panelOpen = (() => { try { return localStorage.getItem('demandPanel') !== 'closed'; } catch { return true; } })();

/** Compact "open demand" panel for the planner page. */
export async function demandPanel(monday, onChanged) {
  const ctx = await loadDemand({ onlyActive: true });
  if (reportError(ctx.error, 'Loading open demand')) return null;
  const weekEnd = toISO(addDays(monday, 4));
  const todayISO = toISO(today());
  const overdue = ctx.notes.filter((n) => n.needed_by && n.needed_by < todayISO).length;
  const dueThisWeek = ctx.notes.filter((n) => n.needed_by && n.needed_by >= todayISO && n.needed_by <= weekEnd).length;

  const rows = ctx.notes.map((n) => h('li', {},
    h('button', {
      type: 'button',
      class: `demand-row prio-edge-${n.priority}`,
      title: [n.comment, attribution(n, ctx)].filter(Boolean).join('\n'),
      onclick: () => (canEdit(n) ? editDemand(ctx, n, onChanged) : showNote(n, ctx)),
    },
      h('span', { class: 'demand-row-main' }, headline(n, ctx), n.comment ? h('span', { class: 'demand-row-comment' }, n.comment) : null),
      h('span', { class: 'demand-badges' }, dueBadge(n), n.priority !== 'normal' ? priorityBadge(n.priority) : null, statusBadge(n.status)),
    )));

  const body = h('div', { class: 'panel-body', hidden: !panelOpen },
    ctx.notes.length ? h('ul', { class: 'demand-rows' }, rows) : h('p', { class: 'muted small panel-empty' }, 'No open demand. 🎉'),
    h('div', { class: 'panel-foot' },
      h('button', { class: 'btn btn-sm', onclick: () => editDemand(ctx, null, onChanged) }, '+ New note'),
      h('a', { href: '#/demand', class: 'small' }, 'All demand & notes →'),
    ),
  );
  const toggle = h('button', {
    class: 'panel-toggle',
    'aria-expanded': String(panelOpen),
    onclick: () => {
      panelOpen = !panelOpen;
      body.hidden = !panelOpen;
      toggle.setAttribute('aria-expanded', String(panelOpen));
      try { localStorage.setItem('demandPanel', panelOpen ? 'open' : 'closed'); } catch { /* ignore */ }
    },
  },
    h('span', { class: 'panel-caret', 'aria-hidden': 'true' }, '▸'),
    h('span', { class: 'panel-title' }, `Open demand (${ctx.notes.length})`),
    overdue ? h('span', { class: 'due due-overdue' }, `${overdue} overdue`) : null,
    dueThisWeek ? h('span', { class: 'due due-soon' }, `${dueThisWeek} due this week`) : null,
  );
  return h('section', { class: 'card demand-panel' }, toggle, body);
}

function showNote(n, ctx) {
  openModal({
    title: 'Demand note',
    body: h('div', { class: 'stack' },
      h('div', {}, headline(n, ctx)),
      h('div', { class: 'demand-badges' }, dueBadge(n), priorityBadge(n.priority), statusBadge(n.status)),
      n.comment ? h('p', { class: 'demand-comment' }, n.comment) : null,
      h('p', { class: 'muted small' }, attribution(n, ctx)),
    ),
    actions: [{ label: 'Close' }],
  });
}
