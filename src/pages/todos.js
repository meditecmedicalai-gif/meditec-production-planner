// To-dos (Demand & Notes → To-dos): title, details, due date, priority, owner,
// status, checklist — and office time blocks scheduled for them in the planner.
import { h, mount, toast, reportError, openModal, confirmDialog, field } from '../ui.js';
import { supabase } from '../supabase.js';
import { auth } from '../auth.js';
import { toISO, fromISO, today, mondayOf, fmtDayShort, fmtDate } from '../dates.js';
import { dueWords, PRIORITY_RANK } from '../demandModel.js';
import { hm } from '../jobs.js';
import { setPendingPlan } from './demand.js';

export const TODO_STATUS = { todo: 'To do', in_progress: 'In progress', done: 'Done' };
const PRIORITIES = { urgent: 'Urgent', high: 'High', normal: 'Normal', low: 'Low' };
const optional = (q) => q.then((r) => (r.error ? { data: [], error: r.error } : r));

/** To-dos + the jobs scheduled for them. → { items: [{ todo, state }], ready, … } */
export async function loadTodos() {
  const [todos, profiles, people, tasks] = await Promise.all([
    optional(supabase.from('todos').select('*')),
    supabase.from('profiles').select('id, full_name, email'),
    supabase.from('people').select('id, name, active, user_id'),
    supabase.from('tasks').select('*').order('sort_order'),
  ]);
  const ready = !todos.error; // false before migration 012
  const list = todos.data || [];
  const ids = list.map((t) => t.id);
  const links = ids.length
    ? await optional(supabase.from('assignments').select('id, todo_id, person_id, task_id, work_date, start_time, end_time, end_date').in('todo_id', ids))
    : { data: [] };
  const todayISO = toISO(today());
  const items = list.map((todo) => ({ todo, state: todoState(todo, links.data || [], todayISO) }));
  items.sort((a, b) => (a.state.overdue ? 0 : 1) - (b.state.overdue ? 0 : 1)
    || (a.todo.due_date ?? '9999').localeCompare(b.todo.due_date ?? '9999')
    || (PRIORITY_RANK[a.todo.priority] ?? 9) - (PRIORITY_RANK[b.todo.priority] ?? 9)
    || (b.todo.created_at || '').localeCompare(a.todo.created_at || ''));
  const profs = profiles.data || [];
  return {
    ready, items, todayISO, profiles: profs,
    personById: new Map((people.data || []).map((p) => [p.id, p])),
    people: people.data || [],
    taskById: new Map((tasks.data || []).map((t) => [t.id, t])),
    officeTasks: (tasks.data || []).filter((t) => t.category === 'office' && t.active),
    nameOf: (id) => { const p = profs.find((x) => x.id === id); return p ? (p.full_name || p.email) : '—'; },
  };
}

export function todoState(todo, links, todayISO) {
  const list = Array.isArray(todo.checklist) ? todo.checklist : [];
  const jobs = links.filter((a) => a.todo_id === todo.id).sort((a, b) => (a.work_date + (a.start_time || '')).localeCompare(b.work_date + (b.start_time || '')));
  return {
    checkTotal: list.length, checkDone: list.filter((c) => c.done).length,
    overdue: Boolean(todo.due_date && todo.due_date < todayISO && todo.status !== 'done'),
    jobs,
  };
}

export const canEditTodo = (t) => auth.isAdmin || t.created_by === auth.session?.user.id || t.owner_id === auth.session?.user.id;

// ------------------------------------------------------------------ actions
async function setStatus(t, status, onSaved) {
  const { error } = await supabase.from('todos').update({ status }).eq('id', t.id);
  if (reportError(error, 'Updating to-do')) return;
  toast(status === 'done' ? 'To-do done. ✓' : `Marked ${TODO_STATUS[status].toLowerCase()}.`, 'success');
  onSaved();
}
async function toggleItem(t, i, onSaved) {
  const list = (t.checklist || []).map((c, j) => (j === i ? { ...c, done: !c.done } : c));
  const { error } = await supabase.from('todos').update({ checklist: list }).eq('id', t.id);
  if (reportError(error, 'Updating checklist')) return;
  onSaved();
}
async function deleteTodo(t, onSaved) {
  if (!(await confirmDialog('Delete to-do?', `Delete "${t.title}"? Time blocks scheduled for it stay in the plan (just unlinked). The change history keeps a record.`))) return;
  const { error } = await supabase.from('todos').delete().eq('id', t.id);
  if (reportError(error, 'Deleting')) return;
  toast('To-do deleted.', 'success');
  onSaved();
}

/** "Schedule this": Add work in the planner as an office job, linked to the to-do. */
export function scheduleThis(x, ctx, onSamePage) {
  let d = fromISO(ctx.todayISO);
  while (d.getDay() === 0 || d.getDay() === 6) d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
  const date = toISO(d);
  setPendingPlan({ todoId: x.todo.id, date, title: x.todo.title, ownerId: x.todo.owner_id });
  const hash = `#/planner?week=${toISO(mondayOf(d))}`;
  if (location.hash === hash && onSamePage) onSamePage(); else location.hash = hash;
}

/** Add / edit a to-do. */
export function editTodo(ctx, todo, onSaved) {
  const isNew = !todo;
  const me = auth.session?.user.id;
  const title = h('input', { type: 'text', maxlength: 140, value: todo?.title ?? '', placeholder: 'e.g. Update the QPro build instructions', required: true });
  const details = h('textarea', { rows: 3, maxlength: 2000, placeholder: 'Details (optional)' }, todo?.details ?? '');
  const due = h('input', { type: 'date', value: todo?.due_date ?? '' });
  const priority = h('select', {}, Object.entries(PRIORITIES).map(([k, v]) => h('option', { value: k, selected: k === (todo?.priority ?? 'normal') }, v)));
  const owner = h('select', {}, ctx.profiles.map((p) => h('option', { value: p.id, selected: p.id === (todo?.owner_id ?? me) }, (p.full_name || p.email) + (p.id === me ? ' (me)' : ''))));
  const status = h('select', {}, Object.entries(TODO_STATUS).map(([k, v]) => h('option', { value: k, selected: k === (todo?.status ?? 'todo') }, v)));
  const checklist = h('textarea', { rows: 4, maxlength: 3000, placeholder: 'One item per line (optional)' },
    (todo?.checklist || []).map((c) => c.text).join('\n'));
  const error = h('p', { class: 'form-error', role: 'alert' });
  const actions = [];
  if (!isNew && auth.isAdmin) actions.push({ label: 'Delete', variant: 'danger', onClick: () => { deleteTodo(todo, onSaved); return true; } });
  actions.push({ label: 'Cancel' }, {
    label: isNew ? 'Add to-do' : 'Save', variant: 'primary',
    onClick: async () => {
      error.textContent = '';
      if (!title.value.trim()) { error.textContent = 'Give the to-do a title.'; return false; }
      const old = new Map((todo?.checklist || []).map((c) => [c.text, c.done]));
      const items = checklist.value.split('\n').map((t) => t.trim()).filter(Boolean).map((text) => ({ text, done: Boolean(old.get(text)) }));
      const values = { title: title.value.trim(), details: details.value.trim() || null, due_date: due.value || null, priority: priority.value,
        owner_id: owner.value || me, status: status.value, checklist: items };
      const { error: err } = isNew ? await supabase.from('todos').insert(values) : await supabase.from('todos').update(values).eq('id', todo.id);
      if (reportError(err, 'Saving to-do')) return false;
      toast(isNew ? 'To-do added.' : 'To-do saved.', 'success');
      onSaved();
      return true;
    },
  });
  openModal({
    title: isNew ? 'New to-do' : 'Edit to-do',
    body: h('div', { class: 'stack' },
      field('Title', title), field('Details', details),
      h('div', { class: 'form-grid form-grid-3' }, field('Due', due), field('Priority', priority), field('Owner', owner)),
      isNew ? null : field('Status', status),
      field('Checklist', checklist, 'Tick items off on the card.'),
      todo ? h('p', { class: 'muted small' }, `Added by ${ctx.nameOf(todo.created_by)} on ${fmtDate(new Date(todo.created_at))}`) : null,
      error),
    actions,
  });
  (isNew ? title : details).focus();
}

// ------------------------------------------------------------------ card
const timeBlock = (a, ctx) => [fmtDayShort(fromISO(a.work_date)) + (a.start_time ? ` ${hm(a.start_time)}${a.end_time ? `–${hm(a.end_time)}` : ''}` : ''),
  (ctx.personById.get(a.person_id)?.name || '—').split(' ')[0], ctx.taskById.get(a.task_id)?.name || 'Office'].join(' · ');

export function todoCard(x, ctx, { onChanged, onSamePage, compact = false } = {}) {
  const t = x.todo; const s = x.state;
  const editable = canEditTodo(t);
  const dw = dueWords(t.due_date, ctx.todayISO);
  const due = t.due_date
    ? h('span', { class: 'dc-need-txt' }, `Due ${fmtDayShort(fromISO(t.due_date))}`, ' ', t.status !== 'done' ? h('span', { class: `due-words due-${dw.level}` }, dw.text) : null)
    : h('span', { class: 'muted small' }, 'No due date');
  const check = s.checkTotal ? h('div', { class: 'dc-progress' },
    h('div', { class: 'dc-bar', role: 'img', 'aria-label': `${s.checkDone} of ${s.checkTotal} done` }, h('span', { class: 'bar-done', style: `width:${(s.checkDone / s.checkTotal) * 100}%` })),
    h('span', { class: 'dc-planned' }, `${s.checkDone} / ${s.checkTotal}`)) : null;
  const schedule = auth.isAdmin && t.status !== 'done' ? h('button', { class: 'btn btn-sm btn-primary', onclick: () => scheduleThis(x, ctx, onSamePage) }, 'Schedule this') : null;
  if (compact) {
    return h('li', { class: `dc-row td-row td-${t.status}`, 'data-todo': t.id },
      h('div', { class: 'dc-row-main' }, h('b', { class: 'dc-model' }, t.title), due, check,
        t.priority !== 'normal' ? h('span', { class: `prio prio-${t.priority}` }, PRIORITIES[t.priority]) : null,
        h('span', { class: `tstat tstat-${t.status}` }, TODO_STATUS[t.status])),
      h('div', { class: 'dc-row-actions' }, schedule,
        editable && t.status !== 'done' ? h('button', { class: 'btn btn-sm btn-ghost', onclick: () => setStatus(t, 'done', onChanged) }, 'Done') : null));
  }
  return h('article', { class: `dcard card tcard td-${t.status} prio-edge-${t.priority}`, 'data-todo': t.id },
    h('div', { class: 'dc-head' }, h('span', { class: 'todo-ico', 'aria-hidden': 'true' }, '☑'), h('h3', { class: 'dc-model' }, t.title),
      h('span', { class: `tstat tstat-${t.status}` }, TODO_STATUS[t.status])),
    h('div', { class: 'dc-need' }, due),
    check,
    h('div', { class: 'dc-meta' }, h('span', { class: `prio prio-${t.priority}` }, PRIORITIES[t.priority]),
      h('span', { class: 'muted small' }, `For ${ctx.nameOf(t.owner_id)}`, t.created_by && t.created_by !== t.owner_id ? ` · added by ${ctx.nameOf(t.created_by)}` : '')),
    t.details ? h('p', { class: 'dc-comment', tabindex: 0, onclick: (e) => e.currentTarget.classList.toggle('open') }, t.details) : null,
    s.checkTotal ? h('ul', { class: 'td-check' }, (t.checklist || []).map((c, i) => h('li', {},
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: Boolean(c.done), disabled: !editable, onchange: () => toggleItem(t, i, onChanged) }), h('span', { class: c.done ? 'td-done' : '' }, c.text))))) : null,
    s.jobs.length ? h('ul', { class: 'dc-jobs', 'aria-label': 'Scheduled time' }, s.jobs.map((a) => h('li', {}, '💻 ', timeBlock(a, ctx)))) : null,
    h('div', { class: 'dc-actions' },
      schedule,
      editable && t.status === 'todo' ? h('button', { class: 'btn btn-sm', onclick: () => setStatus(t, 'in_progress', onChanged) }, 'Start') : null,
      editable && t.status !== 'done' ? h('button', { class: 'btn btn-sm', onclick: () => setStatus(t, 'done', onChanged) }, 'Mark done') : null,
      editable && t.status === 'done' ? h('button', { class: 'btn btn-sm btn-ghost', onclick: () => setStatus(t, 'todo', onChanged) }, 'Reopen') : null,
      editable ? h('button', { class: 'btn btn-sm', onclick: () => editTodo(ctx, t, onChanged) }, 'Edit') : null,
      auth.isAdmin ? h('button', { class: 'btn btn-sm btn-danger', onclick: () => deleteTodo(t, onChanged) }, 'Delete') : null));
}

let doneOpen = false;
/** Sections: To do · In progress · Done (collapsed). */
export function todoSections(ctx, items, onChanged) {
  return [['todo', '☐ To do'], ['in_progress', 'In progress'], ['done', 'Done']].map(([key, label]) => {
    const list = items.filter((x) => x.todo.status === key);
    const head = h('h2', { class: `dsec-title tsec-${key}` }, label, ' ', h('span', { class: 'dsec-count' }, String(list.length)));
    const cards = list.length ? h('div', { class: 'demand-list' }, list.map((x) => todoCard(x, ctx, { onChanged })))
      : h('p', { class: 'muted small dsec-empty' }, key === 'todo' ? 'Nothing to do. 🎉' : 'None.');
    if (key === 'done') {
      return h('details', { class: 'dsec dsec-done-wrap tsec-done-wrap', open: doneOpen, ontoggle: (e) => { doneOpen = e.currentTarget.open; } }, h('summary', {}, head), cards);
    }
    return h('section', { class: 'dsec', 'data-todos': key }, head, cards);
  });
}

/** Today: "My to-dos" — top 5 not done, overdue first. */
export function myTodosCard(ctx, onChanged) {
  const me = auth.session?.user.id;
  const mine = ctx.items.filter((x) => x.todo.owner_id === me && x.todo.status !== 'done').slice(0, 5);
  return h('section', { class: 'card my-todos' },
    h('div', { class: 'card-head' }, h('h2', {}, 'My to-dos'), h('a', { class: 'link small', href: '#/demand?tab=todos' }, 'All to-dos →')),
    h('p', { class: 'sub' }, 'Overdue first, then by due date'),
    !ctx.ready ? h('p', { class: 'muted' }, 'To-dos arrive with migration 012.')
      : mine.length ? h('ul', { class: 'dc-rows' }, mine.map((x) => todoCard(x, ctx, { compact: true, onChanged })))
        : h('p', { class: 'muted' }, 'Nothing on your list. 🎉'),
    ctx.ready ? h('button', { class: 'btn btn-sm', onclick: () => editTodo(ctx, null, onChanged) }, '+ New to-do') : null);
}

export { mount };
