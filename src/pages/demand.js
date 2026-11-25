// Demand & Notes: requests for pumps, linked to the jobs that cover them.
// Status is worked out from the linked jobs (see demandModel.js) and can be
// overridden. Used by the Demand page, the planner panel and Today.
import { h, mount, toast, reportError, openModal, confirmDialog, field, checkbox } from '../ui.js';
import { supabase } from '../supabase.js';
import { auth } from '../auth.js';
import { toISO, fromISO, today, mondayOf, fmtDayShort, fmtDate } from '../dates.js';
import {
  demandState, dueWords, sortByUrgency, suggestDate, legacyStatus, SECTIONS, STATUS_LABEL, nextStageToPlan,
} from '../demandModel.js';
import { loadTodos, todoSections, editTodo } from './todos.js';

export const PRIORITIES = { urgent: 'Urgent', high: 'High', normal: 'Normal', low: 'Low' };
export const STATUSES = { open: 'Needs planning', partly: 'Partly planned', planned: 'Fully planned', done: 'Done' };

// ------------------------------------------------------------------ "Plan this" hand-over to the planner
let pendingPlan = null;
/** Taken (once) by the planner after it renders: { noteId, date }. */
export const takePendingPlan = () => { const p = pendingPlan; pendingPlan = null; return p; };
export const setPendingPlan = (p) => { pendingPlan = p; };

// ------------------------------------------------------------------ data
const optional = (q) => q.then((r) => (r.error ? { data: [], error: null } : r));

/** Demand notes + the jobs linked to them + lookups. → { items: [{ note, state }], … } */
export async function loadDemand() {
  const [notes, models, types, profiles, tasks, people] = await Promise.all([
    supabase.from('demand_notes').select('*'),
    supabase.from('pump_models').select('id, name, short_code, active, sort_order').order('sort_order').order('name'),
    supabase.from('build_types').select('id, name, color, is_default, active, sort_order').order('sort_order').order('name'),
    supabase.from('profiles').select('id, full_name, email'),
    supabase.from('tasks').select('*').order('sort_order'),
    supabase.from('people').select('id, name, active'),
  ]);
  const error = [notes, models, types, profiles, tasks, people].find((r) => r.error)?.error;
  if (error) return { error };
  const ids = notes.data.map((n) => n.id);
  // demand_id comes with migration 011 — without it, nothing is linked yet
  // stages / units done / logged / manual planned come with migration 012 — without it: the old behaviour
  const [links, stages, manual, logs] = await Promise.all([
    ids.length ? optional(supabase.from('assignments').select('*').in('demand_id', ids)) : { data: [] },
    supabase.from('pump_model_stages').select('*').order('position'),
    ids.length ? optional(supabase.from('demand_stage_plans').select('*').in('demand_id', ids)) : { data: [] },
    ids.length ? optional(supabase.from('demand_progress').select('*').in('demand_id', ids)) : { data: [] },
  ]);
  const progressReady = !stages.error; // migration 012 run
  const taskById = new Map(tasks.data.map((t) => [t.id, t]));
  const stagesByModel = new Map();
  for (const st of (stages.data || []).slice().sort((a, b) => a.position - b.position)) {
    if (!stagesByModel.has(st.pump_model_id)) stagesByModel.set(st.pump_model_id, []);
    stagesByModel.get(st.pump_model_id).push(st.task_id);
  }
  const todayISO = toISO(today());
  const opts = { taskById, todayISO, stagesByModel, manual: manual.data || [], logs: logs.data || [] };
  const items = sortByUrgency(notes.data.map((note) => ({ note, state: demandState(note, links.data || [], opts) })), todayISO);
  return {
    items, notes: items.map((x) => x.note), todayISO,
    models: models.data, modelById: new Map(models.data.map((m) => [m.id, m])),
    types: types.data, typeById: new Map(types.data.map((t) => [t.id, t])),
    tasks: tasks.data, taskById, stagesByModel, progressReady,
    personById: new Map(people.data.map((p) => [p.id, p])),
    nameOf: (id) => {
      const p = profiles.data.find((x) => x.id === id);
      return p ? (p.full_name || p.email) : 'someone';
    },
  };
}

export const canEdit = (note) => auth.isAdmin || note.created_by === auth.session?.user.id;

// ------------------------------------------------------------------ display pieces
export function typeTag(type) {
  return h('span', { class: 'type-tag', style: `--type-color:${type.color}` }, type.name);
}
export const priorityBadge = (p) => h('span', { class: `prio prio-${p}` }, PRIORITIES[p] || p);
export const statusBadge = (s) => h('span', { class: `status status-${s}` }, STATUSES[s] || s);
const modelName = (note, ctx) => (note.any_pump ? 'Any / mixed pump' : ctx.modelById.get(note.pump_model_id)?.name || 'General note');

/** "QPro 2000 · Trial × 10" (plain text, e.g. for the job form). */
export function noteText(note, ctx) {
  const type = ctx.typeById.get(note.build_type_id);
  return [modelName(note, ctx), type?.name].filter(Boolean).join(' · ') + (note.quantity != null ? ` × ${note.quantity}` : '');
}

function ago(ts) {
  const mins = (Date.now() - new Date(ts).getTime()) / 60000;
  if (mins < 2) return 'just now';
  if (mins < 60) return `${Math.round(mins)} min ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)} h ago`;
  const days = Math.round(mins / 1440);
  return days === 1 ? 'yesterday' : days < 14 ? `${days} days ago` : fmtDate(new Date(ts));
}

export function attribution(note, ctx) {
  const posted = `Asked by ${ctx.nameOf(note.created_by)} · ${ago(note.created_at)}`;
  const edited = note.updated_by && note.updated_at && (note.updated_by !== note.created_by || note.updated_at.slice(0, 16) !== note.created_at.slice(0, 16))
    ? ` · edited by ${ctx.nameOf(note.updated_by)} ${ago(note.updated_at)}` : '';
  return posted + edited;
}

/** "Mon 24 Nov · Irwin · Final assembly × 4" */
const jobLine = (a, ctx) => [fmtDayShort(fromISO(a.work_date)) + (a.end_date && a.end_date > a.work_date ? ` → ${fmtDayShort(fromISO(a.end_date))}` : ''),
  (ctx.personById.get(a.person_id)?.name || '—').split(' ')[0], ctx.taskById.get(a.task_id)?.name || 'Job'].join(' · ')
  + (a.qty_target != null ? ` × ${a.qty_target}` : '') + (a.qty_done != null ? ` · ${a.qty_done} done` : '');

/** Two-colour bar: done = solid, planned-not-done = lighter. */
function bar(planned, done, needed, label) {
  const base = needed || Math.max(planned, done) || 1;
  const pd = Math.min(100, (done / base) * 100);
  const pp = Math.min(100, (Math.max(planned, done) / base) * 100);
  return h('div', { class: 'dc-bar', role: 'img', 'aria-label': label },
    h('span', { class: 'bar-planned', style: `width:${pp}%` }), h('span', { class: 'bar-done', style: `width:${pd}%` }));
}
const plannedTitle = (s) => `${s.plannedJobs} from jobs${s.plannedManual ? ` · ${s.plannedManual} entered manually` : ''}`;

function progress(x) {
  const s = x.state;
  const { planned, needed, completed } = s;
  const txt = needed != null
    ? [`${needed} needed`, h('span', { title: plannedTitle(s), class: 'dc-pl' }, `${planned} planned`), `${completed} done`, h('b', {}, `${s.toDo} still to do`)]
    : [h('span', { title: plannedTitle(s), class: 'dc-pl' }, `${planned} planned`), `${completed} done`];
  return h('div', { class: 'dc-progress' },
    bar(planned, completed, needed, `${completed} done, ${planned} planned of ${needed ?? '?'}`),
    h('span', { class: 'dc-planned' }, txt.flatMap((t, i) => (i ? [' · ', t] : [t]))),
    h('span', { class: `dstat dstat-${x.state.status}`, title: x.state.overridden ? `Set by hand (automatic: ${STATUS_LABEL[x.state.auto]})` : 'Worked out from the linked jobs' },
      STATUS_LABEL[x.state.status], x.state.overridden ? ' · set by hand' : ''));
}

/** One small row per stage: "Sub-assembly ▓▒░ 20/50 · 5 done". */
function stageRows(x) {
  const s = x.state;
  if (!s.stages || s.stages.length < 2) return null;
  return h('ul', { class: 'dc-stages', 'aria-label': 'Progress per stage' }, s.stages.map((st, i) => h('li', { class: i === s.stages.length - 1 ? 'is-last' : '' },
    h('span', { class: 'st-name', title: i === s.stages.length - 1 ? 'Last stage — counts as planned / complete for this note' : '' }, st.name),
    bar(st.planned, st.done, s.needed, `${st.name}: ${st.done} done, ${st.planned} planned`),
    h('span', { class: 'st-num', title: plannedTitle(st) }, `${st.planned}${s.needed != null ? `/${s.needed}` : ''}`, st.done ? h('span', { class: 'st-done' }, ` · ${st.done} done`) : null))));
}

/** "Tue 25 Nov · +3 · Prince" (newest first, 3 shown). */
function logHistory(x, ctx) {
  const logs = x.state.logs || [];
  if (!logs.length) return null;
  const stageName = (id) => ctx.taskById.get(id)?.name;
  return h('ul', { class: 'dc-logs', 'aria-label': 'Completed units logged' }, logs.slice(0, 3).map((l) => h('li', {},
    `${fmtDayShort(fromISO(l.work_date))} · +${l.qty} · ${ctx.nameOf(l.created_by).split(' ')[0]}`,
    l.task_id && stageName(l.task_id) && x.state.stages.length > 1 ? ` · ${stageName(l.task_id)}` : '', l.note ? h('span', { class: 'muted' }, ` — ${l.note}`) : null)),
  logs.length > 3 ? h('li', { class: 'muted' }, `+ ${logs.length - 3} earlier`) : null);
}

function dueLine(note, ctx, status, state) {
  const dw = dueWords(note.needed_by, ctx.todayISO);
  if (state?.overdue && state.toDo) dw.text = `${dw.text} — ${state.toDo} still to do`; // "Overdue 2 days — 38 still to do"
  const qty = note.quantity != null ? `${note.quantity} needed` : 'Needed';
  return h('div', { class: 'dc-need' },
    h('span', { class: 'dc-need-txt' }, note.needed_by ? `${qty} by ${fmtDayShort(fromISO(note.needed_by))}` : `${qty} · no date`),
    note.needed_by && status !== 'done' ? h('span', { class: `due-words due-${dw.level}` }, dw.text) : null);
}

// ------------------------------------------------------------------ actions
async function setOverride(note, override, onSaved, ctx, x) {
  const status = override || x?.state.auto || 'open';
  const { error } = await supabase.from('demand_notes').update({ status_override: override, status: legacyStatus(status) }).eq('id', note.id);
  if (reportError(error, 'Updating status')) return;
  toast(override ? `Marked ${STATUS_LABEL[override].toLowerCase()}.` : 'Status back to automatic.', 'success');
  onSaved();
}

export async function deleteNote(note, onSaved) {
  if (!(await confirmDialog('Delete note?', 'Delete this demand note permanently? Linked jobs stay in the plan (just unlinked). The change history keeps a record. To close it instead, mark it Done.'))) return false;
  const { error } = await supabase.from('demand_notes').delete().eq('id', note.id);
  if (reportError(error, 'Deleting')) return false;
  toast('Note deleted.', 'success');
  onSaved();
  return true;
}

/** "Plan this": open Add work in the planner, pre-filled and linked to the note. */
export function planThis(x, ctx, onSamePage) {
  const date = suggestDate(x.note.needed_by, ctx.todayISO);
  const next = nextStageToPlan(x.state);
  pendingPlan = { noteId: x.note.id, date, taskId: next?.taskId || null, qty: next?.qty ?? null };
  const hash = `#/planner?week=${toISO(mondayOf(fromISO(date)))}`;
  if (location.hash === hash && onSamePage) onSamePage(); else location.hash = hash;
}

function options(rows, selectedId, blank) {
  const list = rows.filter((r) => r.active || r.id === selectedId);
  return [h('option', { value: '' }, blank), ...list.map((r) => {
    const o = h('option', { value: r.id }, r.name + (r.active ? '' : ' (inactive)'));
    if (r.id === selectedId) o.selected = true;
    return o;
  })];
}

/** Add / edit a demand note. Viewers can only open their own notes here. */
export function editDemand(ctx, note, onSaved) {
  const isNew = !note;
  const x = note ? ctx.items.find((i) => i.note.id === note.id) : null;
  const model = h('select', {}, options(ctx.models, note?.pump_model_id, '— General / not model-specific —'),
    h('option', { value: '__any' }, 'Any / mixed pump (e.g. rental repairs)'));
  if (note?.any_pump) model.value = '__any';
  const defaultType = ctx.types.find((t) => t.is_default);
  const type = h('select', {}, options(ctx.types, isNew ? defaultType?.id : note.build_type_id, '— Not specified —'));
  const qty = h('input', { type: 'number', min: 0, step: 1, inputmode: 'numeric', value: note?.quantity ?? '' });
  const neededBy = h('input', { type: 'date', value: note?.needed_by ?? '' });
  const priority = h('select', {}, Object.entries(PRIORITIES).map(([k, v]) => h('option', { value: k, selected: k === (note?.priority ?? 'normal') }, v)));
  const auto = x ? STATUS_LABEL[x.state.auto] : 'Needs planning';
  const status = h('select', {},
    h('option', { value: '' }, `Automatic — from the linked jobs${x ? ` (now: ${auto})` : ''}`),
    h('option', { value: 'done' }, 'Done (set by hand)'));
  status.value = note?.status_override || '';
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
        pump_model_id: model.value && model.value !== '__any' ? model.value : null,
        any_pump: model.value === '__any',
        build_type_id: type.value || null,
        quantity: qty.value === '' ? null : Number(qty.value),
        needed_by: neededBy.value || null,
        priority: priority.value,
        comment: comment.value.trim() || null,
      };
      // status override needs migration 011; the old status column is kept in step
      if (status.value || note?.status_override) values.status_override = status.value || null;
      values.status = legacyStatus(status.value || x?.state.auto || 'open');
      if (!values.pump_model_id && !values.any_pump && !values.comment) { error.textContent = 'Choose a pump model or write a comment.'; return false; }
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
      isNew ? null : field('Status', status, 'Automatic: Needs planning → Partly planned → Fully planned (from jobs + manual planned) → Done (when the last stage’s completed units reach the quantity). You can mark it Done by hand.'),
      note ? h('p', { class: 'muted small' }, attribution(note, ctx)) : null,
      error,
    ),
    actions,
  });
  (isNew ? model : comment).focus();
}

// ------------------------------------------------------------------ completed units & manual planned (admin)
/** "+ Log completed": units done outside a tracked job (quantity, date, stage, note). */
function logCompleted(x, ctx, onSaved) {
  const s = x.state;
  const qty = h('input', { type: 'number', min: 1, step: 1, inputmode: 'numeric', required: true });
  const date = h('input', { type: 'date', value: ctx.todayISO });
  const stage = h('select', {}, s.stages.map((st, i) => h('option', { value: st.taskId, selected: i === s.stages.length - 1 },
    `${st.name}${i === s.stages.length - 1 ? ' (last stage)' : ''} — ${st.done} done`)));
  const note = h('input', { type: 'text', maxlength: 200, placeholder: 'Optional, e.g. finished on the Saturday shift' });
  const error = h('p', { class: 'form-error', role: 'alert' });
  openModal({
    title: `Log completed · ${noteText(x.note, ctx)}`,
    body: h('div', { class: 'stack' },
      h('div', { class: 'form-grid form-grid-3' }, field('Quantity done', qty), field('Date', date), field('Stage', stage)),
      field('Note', note),
      h('p', { class: 'muted small' }, s.needed != null ? `${s.completed} of ${s.needed} done so far (last stage).` : `${s.completed} done so far.`),
      error),
    actions: [{ label: 'Cancel' }, {
      label: 'Log', variant: 'primary',
      onClick: async () => {
        const q = Number(qty.value);
        if (!Number.isInteger(q) || q < 1) { error.textContent = 'Enter how many were completed (1 or more).'; return false; }
        const st = s.stages.find((x2) => x2.taskId === stage.value);
        if (s.needed != null && st && st.done + q > s.needed
            && !(await confirmDialog('More than needed?', `That makes ${st.done + q} done at ${st.name}, but only ${s.needed} are needed. Log it anyway?`, 'Log anyway', 'primary'))) return false;
        const { error: err } = await supabase.from('demand_progress').insert({ demand_id: x.note.id, task_id: stage.value || null, qty: q, work_date: date.value || ctx.todayISO, note: note.value.trim() || null });
        if (reportError(err, 'Logging completed')) return false;
        toast(`Logged +${q} completed.`, 'success');
        onSaved();
        return true;
      },
    }],
  });
  qty.focus();
}

/** "Edit planned": manual planned quantity per stage (work planned outside the planner). */
function editPlanned(x, ctx, onSaved) {
  const s = x.state;
  const inputs = s.stages.map((st) => ({ st, inp: h('input', { type: 'number', min: 0, step: 1, inputmode: 'numeric', value: st.plannedManual || '', 'aria-label': `${st.name} planned manually` }) }));
  const error = h('p', { class: 'form-error', role: 'alert' });
  openModal({
    title: `Planned (manual) · ${noteText(x.note, ctx)}`,
    body: h('div', { class: 'stack' },
      h('p', { class: 'muted small' }, 'For work planned outside the planner. Planned shown = linked jobs + this.'),
      h('table', { class: 'data-table plan-table' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Stage'), h('th', {}, 'From jobs'), h('th', {}, 'Manual'), h('th', {}, 'Total'))),
        h('tbody', {}, inputs.map(({ st, inp }) => {
          const tot = h('td', { class: 'num' }, String(st.planned));
          inp.addEventListener('input', () => { tot.textContent = String(st.plannedJobs + (Number(inp.value) || 0)); });
          return h('tr', {}, h('th', { scope: 'row' }, st.name), h('td', { class: 'num' }, String(st.plannedJobs)), h('td', {}, inp), tot);
        }))),
      error),
    actions: [{ label: 'Cancel' }, {
      label: 'Save', variant: 'primary',
      onClick: async () => {
        for (const { st, inp } of inputs) {
          const v = inp.value === '' ? 0 : Number(inp.value);
          if (!Number.isInteger(v) || v < 0) { error.textContent = `${st.name}: a whole number, 0 or more.`; return false; }
          if (v === (st.plannedManual || 0)) continue;
          const { error: err } = v
            ? await supabase.from('demand_stage_plans').upsert({ demand_id: x.note.id, task_id: st.taskId, qty: v }, { onConflict: 'demand_id,task_id' })
            : await supabase.from('demand_stage_plans').delete().eq('demand_id', x.note.id).eq('task_id', st.taskId);
          if (reportError(err, 'Saving planned')) return false;
        }
        toast('Planned quantities saved.', 'success');
        onSaved();
        return true;
      },
    }],
  });
}

// ------------------------------------------------------------------ the card
/** One note as a card. opts: { onChanged, onSamePage, compact } */
export function noteCard(x, ctx, { onChanged, onSamePage, compact = false } = {}) {
  const n = x.note; const s = x.state;
  const type = ctx.typeById.get(n.build_type_id);
  const editable = canEdit(n);
  const canPlan = auth.isAdmin && s.status !== 'done' && (n.pump_model_id || n.any_pump) && Boolean(nextStageToPlan(s)) && (s.needed != null || !s.planned);
  const planBtn = canPlan ? h('button', {
    class: 'btn btn-sm btn-primary', title: `Add work for ${s.remaining ?? ''} ${modelName(n, ctx)}, linked to this note`.replace(/\s+/g, ' '),
    onclick: () => planThis(x, ctx, onSamePage),
  }, 'Plan this') : null;
  const comment = n.comment ? h('p', {
    class: 'dc-comment', tabindex: 0, title: 'Click to show all',
    onclick: (e) => e.currentTarget.classList.toggle('open'),
    onkeydown: (e) => { if (e.key === 'Enter') e.currentTarget.classList.toggle('open'); },
  }, n.comment) : null;

  if (compact) {
    return h('li', { class: `dc-row dc-${s.status}`, 'data-note': n.id },
      h('div', { class: 'dc-row-main' },
        h('b', { class: 'dc-model' }, modelName(n, ctx)), type ? typeTag(type) : null,
        dueLine(n, ctx, s.status, s), progress(x),
        s.tooLate ? h('span', { class: 'dc-late' }, `⚠ Planned too late — ${fmtDayShort(fromISO(s.lastFinish))}`) : null,
        n.priority !== 'normal' ? priorityBadge(n.priority) : null,
        n.comment ? h('span', { class: 'dc-row-comment', title: n.comment }, n.comment) : null),
      h('div', { class: 'dc-row-actions' }, planBtn,
        h('button', { class: 'btn btn-sm btn-ghost', onclick: () => (editable ? editDemand(ctx, n, onChanged) : showNote(x, ctx)) }, editable ? 'Edit' : 'View')));
  }

  return h('article', { class: `dcard card dc-${s.status} prio-edge-${n.priority}`, 'data-note': n.id },
    h('div', { class: 'dc-head' },
      h('h3', { class: 'dc-model' }, modelName(n, ctx)), type ? typeTag(type) : null),
    dueLine(n, ctx, s.status, s),
    progress(x),
    stageRows(x),
    s.tooLate ? h('p', { class: 'dc-late' }, `⚠ Planned too late — ${fmtDayShort(fromISO(s.lastFinish))}`) : null,
    h('div', { class: 'dc-meta' }, priorityBadge(n.priority), h('span', { class: 'muted small' }, attribution(n, ctx))),
    comment,
    s.jobs.length ? h('ul', { class: 'dc-jobs', 'aria-label': 'Linked jobs' }, s.jobs.map((a) => h('li', {}, jobLine(a, ctx)))) : null,
    logHistory(x, ctx),
    h('div', { class: 'dc-actions' },
      planBtn,
      auth.isAdmin && ctx.progressReady && (n.pump_model_id || n.any_pump) ? h('button', { class: 'btn btn-sm', onclick: () => logCompleted(x, ctx, onChanged) }, '+ Log completed') : null,
      auth.isAdmin && ctx.progressReady && (n.pump_model_id || n.any_pump) ? h('button', { class: 'btn btn-sm btn-ghost', onclick: () => editPlanned(x, ctx, onChanged) }, 'Edit planned') : null,
      editable && s.status !== 'done' ? h('button', { class: 'btn btn-sm', onclick: () => setOverride(n, 'done', onChanged, ctx, x) }, 'Mark done') : null,
      editable && s.overridden ? h('button', { class: 'btn btn-sm btn-ghost', onclick: () => setOverride(n, null, onChanged, ctx, x) }, 'Back to automatic') : null,
      editable ? h('button', { class: 'btn btn-sm', onclick: () => editDemand(ctx, n, onChanged) }, 'Edit') : null,
      auth.isAdmin ? h('button', { class: 'btn btn-sm btn-danger', onclick: () => deleteNote(n, onChanged) }, 'Delete') : null,
    ),
  );
}

function showNote(x, ctx) {
  openModal({
    title: 'Demand note',
    body: h('div', { class: 'stack' }, noteCard(x, ctx, {})),
    actions: [{ label: 'Close' }],
  });
}

// ------------------------------------------------------------------ page
const FILTER_KEY = 'demandFilters2';
const defaultFilters = { model: '', type: '', priority: '', mine: false, hidePlanned: false, tab: 'pump' };
let filters = (() => {
  try { return { ...defaultFilters, ...JSON.parse(localStorage.getItem(FILTER_KEY) || '{}') }; } catch { return { ...defaultFilters }; }
})();
const saveFilters = () => { try { localStorage.setItem(FILTER_KEY, JSON.stringify(filters)); } catch { /* ignore */ } };
let doneOpen = false;

export async function renderDemand(main) {
  const [ctx, tctx] = await Promise.all([loadDemand(), loadTodos()]);
  if (reportError(ctx.error, 'Loading demand notes')) return;
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  if (q.get('tab')) { filters.tab = q.get('tab'); saveFilters(); }
  const tab = ['pump', 'todos', 'all'].includes(filters.tab) ? filters.tab : 'pump';
  const reload = () => renderDemand(main);
  const me = auth.session.user.id;

  const matches = (x) => {
    const n = x.note;
    return (!filters.model || (filters.model === '__any' ? n.any_pump : n.pump_model_id === filters.model))
      && (!filters.type || (filters.type === 'none' ? !n.build_type_id : n.build_type_id === filters.type))
      && (!filters.priority || n.priority === filters.priority)
      && (!filters.mine || n.created_by === me);
  };
  const shown = ctx.items.filter(matches);

  const sel = (key, opts) => h('select', { onchange: (e) => { filters[key] = e.target.value; saveFilters(); reload(); } },
    opts.map(([v, label]) => h('option', { value: v, selected: v === filters[key] }, label)));
  const pumpOnly = tab !== 'todos'; // the To-dos tab only filters by priority and "only mine"
  const filterBar = h('div', { class: 'filter-bar card' },
    !pumpOnly ? null : field('Pump model', sel('model', [['', 'All models'], ...ctx.models.map((m) => [m.id, m.name]), ['__any', 'Any / mixed pump']])),
    !pumpOnly ? null : field('Build type', sel('type', [['', 'All types'], ...ctx.types.map((t) => [t.id, t.name]), ['none', 'Not specified']])),
    field('Priority', sel('priority', [['', 'Any priority'], ...Object.entries(PRIORITIES)])),
    h('div', { class: 'filter-check' },
      !pumpOnly ? null : checkbox('Hide fully planned', filters.hidePlanned, { onchange: (e) => { filters.hidePlanned = e.target.checked; saveFilters(); reload(); } }).el,
      checkbox(tab === 'todos' ? 'Only mine' : 'Only my notes', filters.mine, { onchange: (e) => { filters.mine = e.target.checked; saveFilters(); reload(); } }).el),
    JSON.stringify({ ...filters, tab: 'pump' }) !== JSON.stringify(defaultFilters)
      ? h('button', { class: 'btn btn-sm btn-ghost filter-reset', onclick: () => { filters = { ...defaultFilters, tab: filters.tab }; saveFilters(); reload(); } }, 'Reset filters')
      : null,
  );

  const sections = SECTIONS.filter((sec) => !(filters.hidePlanned && sec.key === 'planned')).map((sec) => {
    const list = shown.filter((x) => x.state.status === sec.key);
    const head = h('h2', { class: `dsec-title dsec-${sec.key}` }, sec.icon ? `${sec.icon} ` : '', sec.key === 'partly' ? h('span', { class: 'ico-partly', 'aria-hidden': 'true' }) : null, sec.label, ' ', h('span', { class: 'dsec-count' }, String(list.length)));
    const cards = list.length
      ? h('div', { class: 'demand-list' }, list.map((x) => noteCard(x, ctx, { onChanged: reload })))
      : h('p', { class: 'muted small dsec-empty' }, sec.key === 'open' ? 'Nothing waiting to be planned. 🎉' : 'None.');
    if (sec.key === 'done') {
      const det = h('details', { class: 'dsec dsec-done-wrap', open: doneOpen, ontoggle: (e) => { doneOpen = e.currentTarget.open; } },
        h('summary', {}, head), cards);
      return det;
    }
    return h('section', { class: 'dsec', 'data-section': sec.key }, head, cards);
  });

  // To-dos (filtered by priority / "only mine" too)
  const todosShown = tctx.items.filter((x) => (!filters.priority || x.todo.priority === filters.priority)
    && (!filters.mine || x.todo.owner_id === me || x.todo.created_by === me));
  const openTodos = tctx.items.filter((x) => x.todo.status !== 'done').length;
  const openNotes = ctx.items.filter((x) => x.state.status !== 'done').length;
  const setTab = (t) => { filters.tab = t; saveFilters(); reload(); };
  const tabs = h('div', { class: 'seg demand-tabs', role: 'tablist', 'aria-label': 'Show' },
    [['pump', `Pump demand (${openNotes})`], ['todos', `To-dos (${openTodos})`], ['all', 'All']].map(([k, l]) => h('button', {
      type: 'button', role: 'tab', 'aria-selected': String(tab === k), class: `seg-btn ${tab === k ? 'active' : ''}`, onclick: () => setTab(k),
    }, l)));
  const pumpPart = [
    tab === 'all' ? h('h2', { class: 'part-title' }, 'Pump demand') : null,
    h('p', { class: 'muted small result-count' }, `${shown.length} note${shown.length === 1 ? '' : 's'}${shown.length !== ctx.items.length ? ` of ${ctx.items.length}` : ''}`),
    ctx.items.length ? sections : h('div', { class: 'card empty' }, 'No demand notes yet. Use "New note" to post one.'),
  ];
  const todoPart = [
    tab === 'all' ? h('h2', { class: 'part-title' }, 'To-dos') : null,
    !tctx.ready ? h('div', { class: 'card empty' }, 'To-dos arrive with migration 012 (see README).')
      : tctx.items.length ? todoSections(tctx, todosShown, reload) : h('div', { class: 'card empty' }, 'No to-dos yet. Use "New to-do" to add one.'),
  ];
  mount(main,
    h('div', { class: 'page-head' },
      h('h1', { class: 'page-title' }, 'Demand & Notes'),
      h('div', { class: 'page-head-actions' },
        tab !== 'todos' ? h('button', { class: `btn ${tab === 'pump' ? 'btn-primary' : ''}`, onclick: () => editDemand(ctx, null, reload) }, '+ New note') : null,
        tab !== 'pump' && tctx.ready ? h('button', { class: 'btn btn-primary', onclick: () => editTodo(tctx, null, reload) }, '+ New to-do') : null),
    ),
    tabs,
    filterBar,
    tab !== 'todos' ? pumpPart : null,
    tab !== 'pump' ? todoPart : null,
  );
}

// ------------------------------------------------------------------ planner panel (compact)
let panelOpen = (() => { try { return localStorage.getItem('demandPanel') !== 'closed'; } catch { return true; } })();

/** Compact panel for the planner: only Needs planning and Partly planned, with "Plan this". */
export function demandPanel(ctx, onChanged) {
  if (!ctx || ctx.error) return null;
  const todo = ctx.items.filter((x) => x.state.status === 'open' || x.state.status === 'partly');
  const overdue = todo.filter((x) => x.note.needed_by && x.note.needed_by < ctx.todayISO).length;
  const late = ctx.items.filter((x) => x.state.tooLate).length;
  const group = (key) => {
    const list = todo.filter((x) => x.state.status === key);
    const sec = SECTIONS.find((s) => s.key === key);
    return list.length ? h('div', { class: 'dpanel-group' },
      h('div', { class: `dpanel-title dsec-${key}` }, sec.icon ? `${sec.icon} ` : '', key === 'partly' ? h('span', { class: 'ico-partly', 'aria-hidden': 'true' }) : null, `${sec.label} (${list.length})`),
      h('ul', { class: 'dc-rows' }, list.map((x) => noteCard(x, ctx, { compact: true, onChanged, onSamePage: onChanged })))) : null;
  };
  const body = h('div', { class: 'panel-body', hidden: !panelOpen },
    todo.length ? [group('open'), group('partly')] : h('p', { class: 'muted small panel-empty' }, 'Nothing waiting to be planned. 🎉'),
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
    h('span', { class: 'panel-title' }, `Open demand (${todo.length})`),
    overdue ? h('span', { class: 'due due-overdue' }, `${overdue} overdue`) : null,
    late ? h('span', { class: 'due due-soon' }, `${late} planned too late`) : null,
  );
  return h('section', { class: 'card demand-panel' }, toggle, body);
}
