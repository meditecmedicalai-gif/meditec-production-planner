import { h, mount, toast, reportError, openModal, confirmDialog, field, checkbox, hhmm } from '../ui.js';
import { supabase } from '../supabase.js';

// Admin-only page: working hours, pump models and tasks.
export async function renderSettings(main, ctx) {
  const hoursCard = h('section', { class: 'card' });
  const modelsCard = h('section', { class: 'card' });
  const tasksCard = h('section', { class: 'card' });
  const typesCard = h('section', { class: 'card' });
  const equipCard = h('section', { class: 'card' });
  mount(main,
    h('h1', { class: 'page-title' }, 'Settings'),
    h('div', { class: 'stack-lg' }, hoursCard, modelsCard, typesCard, tasksCard, equipCard),
  );
  await Promise.all([
    renderHours(hoursCard, ctx),
    renderRefList(modelsCard, MODELS),
    renderRefList(typesCard, BUILD_TYPES),
    renderRefList(tasksCard, TASKS),
    renderRefList(equipCard, EQUIPMENT),
  ]);
}

// ------------------------------------------------------------ working hours
async function renderHours(card, ctx) {
  const { data, error } = await supabase.from('app_settings').select('*').eq('id', 1).single();
  if (reportError(error, 'Loading working hours')) return;

  const time = (v) => h('input', { type: 'time', value: hhmm(v), required: true, step: 300 });
  const mins = (v) => h('input', { type: 'number', value: v, min: 0, max: 240, required: true, inputmode: 'numeric' });
  const f = {
    work_start: time(data.work_start), work_end: time(data.work_end),
    break_time: time(data.break_time), break_minutes: mins(data.break_minutes),
    lunch_time: time(data.lunch_time), lunch_minutes: mins(data.lunch_minutes),
  };

  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      if (f.work_end.value <= f.work_start.value) { toast('The finish time must be after the start time.', 'error'); return; }
      const { error: err } = await supabase.from('app_settings').update({
        work_start: f.work_start.value, work_end: f.work_end.value,
        break_time: f.break_time.value, break_minutes: Number(f.break_minutes.value),
        lunch_time: f.lunch_time.value, lunch_minutes: Number(f.lunch_minutes.value),
      }).eq('id', 1);
      if (reportError(err, 'Saving working hours')) return;
      toast('Working hours saved.', 'success');
      ctx?.refreshHeader?.();
    },
  },
    h('div', { class: 'form-grid' },
      field('Start', f.work_start), field('Finish', f.work_end),
      field('Break at', f.break_time), field('Break (minutes)', f.break_minutes),
      field('Lunch at', f.lunch_time), field('Lunch (minutes)', f.lunch_minutes),
    ),
    h('div', { class: 'form-actions' }, h('button', { type: 'submit', class: 'btn btn-primary' }, 'Save working hours')),
  );

  mount(card,
    h('h2', {}, 'Working hours'),
    h('p', { class: 'muted small' }, 'Shown in the header on every page.'),
    form,
  );
}

// ----------------------------------------------------- pump models & tasks
const MODELS = {
  table: 'pump_models',
  title: 'Pump models',
  singular: 'pump model',
  help: 'Inactive models are hidden when planning but kept in past weeks. Delete only works for models never used.',
  columns: 'id, name, short_code, active, sort_order',
  flags: [],
  extraFields: [
    { key: 'short_code', label: 'Short code', hint: 'Optional short name for the planner grid, e.g. MATS', maxlength: 12 },
  ],
};

const BUILD_TYPES = {
  table: 'build_types',
  title: 'Build types',
  singular: 'build type',
  help: 'Every pump job is tagged with a build type (shown as a coloured tag in the planner). The default type is pre-selected for new work.',
  columns: 'id, name, color, is_default, active, sort_order',
  flags: [],
  extraFields: [
    { key: 'color', label: 'Colour', type: 'color', default: '#64748b' },
  ],
  hasDefault: true,
};

const TASKS = {
  table: 'tasks',
  title: 'Tasks / operations',
  singular: 'task',
  help: '"Counts as output" tasks are added up as units produced in the weekly summary (normally Final assembly only).',
  columns: 'id, name, requires_pump, counts_as_output, is_background, active, sort_order',
  flags: [
    { key: 'requires_pump', label: 'Requires a pump model', badge: 'needs pump' },
    { key: 'counts_as_output', label: 'Counts as output (units produced)', badge: 'counts as output', accent: true },
    { key: 'is_background', label: 'Background / unattended (runs while the person does other work, e.g. soak test). Can be overridden per job.', badge: '⏱ background' },
  ],
  extraFields: [],
};

const EQUIPMENT = {
  table: 'equipment',
  title: 'Equipment / test stations',
  singular: 'equipment item',
  help: 'Jobs can be linked to one item; the planner warns when the same item is booked at overlapping times.',
  columns: 'id, name, notes, active, sort_order',
  flags: [],
  extraFields: [
    { key: 'notes', label: 'Notes', hint: 'Optional, e.g. location or capacity', maxlength: 60 },
  ],
};

async function renderRefList(card, cfg) {
  const { data: rows, error } = await supabase.from(cfg.table).select(cfg.columns).order('sort_order').order('name');
  if (reportError(error, `Loading ${cfg.title.toLowerCase()}`)) return;
  const reload = () => renderRefList(card, cfg);

  const move = async (index, dir) => {
    const a = rows[index];
    const b = rows[index + dir];
    if (!b) return;
    // Renumber the whole list in steps of 10, with the two rows swapped,
    // so equal sort_order values can't get stuck.
    const ordered = rows.slice();
    ordered[index] = b;
    ordered[index + dir] = a;
    const updates = ordered
      .map((r, i) => ({ id: r.id, sort_order: (i + 1) * 10 }))
      .filter((u, i) => ordered[i].sort_order !== u.sort_order);
    for (const u of updates) {
      const { error: err } = await supabase.from(cfg.table).update({ sort_order: u.sort_order }).eq('id', u.id);
      if (reportError(err, 'Reordering')) break;
    }
    reload();
  };

  const toggleActive = async (row) => {
    const { error: err } = await supabase.from(cfg.table).update({ active: !row.active }).eq('id', row.id);
    if (!reportError(err, 'Updating')) {
      toast(`${row.name} ${row.active ? 'deactivated' : 'reactivated'}.`, 'success');
      reload();
    }
  };

  const makeDefault = async (row) => {
    // Only one default is allowed (unique index), so clear the old one first.
    let { error: err } = await supabase.from(cfg.table).update({ is_default: false }).eq('is_default', true);
    if (!err) ({ error: err } = await supabase.from(cfg.table).update({ is_default: true }).eq('id', row.id));
    if (!reportError(err, 'Updating')) {
      toast(`${row.name} is now the default.`, 'success');
      reload();
    }
  };

  const remove = async (row) => {
    if (!(await confirmDialog(`Delete ${cfg.singular}?`, `Delete "${row.name}" permanently? If it has been used anywhere, deactivate it instead.`))) return;
    const { error: err } = await supabase.from(cfg.table).delete().eq('id', row.id);
    if (!reportError(err, `Could not delete "${row.name}"`)) {
      toast(`${row.name} deleted.`, 'success');
      reload();
    }
  };

  const list = h('ul', { class: 'ref-list' }, rows.map((row, i) =>
    h('li', { class: row.active ? '' : 'inactive' },
      h('div', { class: 'ref-main' },
        row.color ? h('span', { class: 'swatch', style: `background:${row.color}`, 'aria-hidden': 'true' }) : null,
        h('span', { class: 'ref-name' }, row.name),
        cfg.extraFields.map((x) => (x.type !== 'color' && row[x.key] ? h('span', { class: 'tag' }, row[x.key]) : null)),
        row.is_default ? h('span', { class: 'tag tag-accent' }, 'default') : null,
        cfg.flags.map((fl) => (row[fl.key] ? h('span', { class: `tag ${fl.accent ? 'tag-accent' : ''}` }, fl.badge) : null)),
        row.active ? null : h('span', { class: 'tag tag-muted' }, 'inactive'),
      ),
      h('div', { class: 'ref-actions' },
        h('button', { class: 'btn btn-sm btn-ghost', title: 'Move up', 'aria-label': `Move ${row.name} up`, disabled: i === 0, onclick: () => move(i, -1) }, '↑'),
        h('button', { class: 'btn btn-sm btn-ghost', title: 'Move down', 'aria-label': `Move ${row.name} down`, disabled: i === rows.length - 1, onclick: () => move(i, 1) }, '↓'),
        cfg.hasDefault && !row.is_default && row.active
          ? h('button', { class: 'btn btn-sm', onclick: () => makeDefault(row) }, 'Make default') : null,
        h('button', { class: 'btn btn-sm', onclick: () => editRef(cfg, row, reload) }, 'Edit'),
        row.is_default ? null : h('button', { class: 'btn btn-sm', onclick: () => toggleActive(row) }, row.active ? 'Deactivate' : 'Reactivate'),
        row.is_default ? null : h('button', { class: 'btn btn-sm btn-danger', onclick: () => remove(row) }, 'Delete'),
      ),
    ),
  ));

  mount(card,
    h('div', { class: 'card-head' },
      h('h2', {}, `${cfg.title} (${rows.filter((r) => r.active).length} active)`),
      h('button', {
        class: 'btn btn-primary btn-sm',
        onclick: () => editRef(cfg, null, reload, (rows.at(-1)?.sort_order ?? 0) + 10),
      }, `+ Add ${cfg.singular}`),
    ),
    h('p', { class: 'muted small' }, cfg.help),
    list,
  );
}

function editRef(cfg, row, onSaved, nextSortOrder) {
  const name = h('input', { type: 'text', value: row?.name ?? '', required: true, maxlength: 80 });
  const extras = cfg.extraFields.map((x) => ({
    key: x.key,
    input: x.type === 'color'
      ? h('input', { type: 'color', value: row?.[x.key] ?? x.default, class: 'color-input' })
      : h('input', { type: 'text', value: row?.[x.key] ?? '', maxlength: x.maxlength }),
    ...x,
  }));
  const flags = cfg.flags.map((fl) => ({ key: fl.key, ...checkbox(fl.label, row ? row[fl.key] : fl.key === 'requires_pump') }));
  const error = h('p', { class: 'form-error', role: 'alert' });

  openModal({
    title: row ? `Edit ${cfg.singular}` : `Add ${cfg.singular}`,
    body: h('div', { class: 'stack' },
      field('Name', name),
      extras.map((x) => field(x.label, x.input, x.hint)),
      flags.map((fl) => fl.el),
      error,
    ),
    actions: [
      { label: 'Cancel' },
      {
        label: 'Save',
        variant: 'primary',
        onClick: async () => {
          const values = { name: name.value.trim() };
          if (!values.name) { error.textContent = 'Please enter a name.'; return false; }
          for (const x of extras) values[x.key] = x.input.value.trim() || null;
          for (const fl of flags) values[fl.key] = fl.input.checked;
          const q = row
            ? supabase.from(cfg.table).update(values).eq('id', row.id)
            : supabase.from(cfg.table).insert({ ...values, sort_order: nextSortOrder });
          const { error: err } = await q;
          if (reportError(err, 'Saving')) return false;
          toast(`${values.name} saved.`, 'success');
          onSaved();
          return true;
        },
      },
    ],
  });
  name.focus();
}
