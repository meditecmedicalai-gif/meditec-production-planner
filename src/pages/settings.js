import { h, mount, toast, reportError, openModal, confirmDialog, field, checkbox, hhmm } from '../ui.js';
import { supabase } from '../supabase.js';

// Admin-only page: working hours, pump models and tasks.
export async function renderSettings(main, ctx) {
  const hoursCard = h('section', { class: 'card' });
  const modelsCard = h('section', { class: 'card' });
  const tasksCard = h('section', { class: 'card' });
  const typesCard = h('section', { class: 'card' });
  const equipCard = h('section', { class: 'card' });
  const testCard = h('section', { class: 'card' });
  mount(main,
    h('h1', { class: 'page-title' }, 'Settings'),
    h('div', { class: 'stack-lg' }, hoursCard, modelsCard, typesCard, tasksCard, testCard, equipCard),
  );
  const { data: areas } = await supabase.from('test_areas').select('id, name, active').order('sort_order').order('name');
  areaList = areas || [];
  await Promise.all([
    renderTestAreas(testCard, () => renderSettings(main, ctx)),
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
let areaList = [];
const MODELS = {
  table: 'pump_models',
  title: 'Pump models',
  singular: 'pump model',
  help: 'Inactive models are hidden when planning but kept in past weeks. Delete only works for models never used.',
  columns: 'id, name, short_code, test_area_id, active, sort_order',
  flags: [],
  extraFields: [
    { key: 'short_code', label: 'Short code', hint: 'Optional short name for the planner grid, e.g. MATS', maxlength: 12 },
    { key: 'test_area_id', label: 'Default test area', type: 'select', hint: 'Where this model is tested (for test capacity).', options: () => areaList,
      show: (v) => (v ? `🧪 ${areaList.find((a) => a.id === v)?.name || 'test area'}` : null) },
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
  columns: 'id, name, requires_pump, counts_as_output, is_background, is_testing, allows_any_pump, active, sort_order',
  flags: [
    { key: 'requires_pump', label: 'Requires a pump model', badge: 'needs pump' },
    { key: 'counts_as_output', label: 'Counts as output (units produced)', badge: 'counts as output', accent: true },
    { key: 'is_background', label: 'Background / unattended (runs while the person does other work, e.g. soak test). Can be overridden per job.', badge: '⏱ background' },
    { key: 'is_testing', label: 'Testing task — counts towards test capacity (quantity = pumps on test)', badge: '🧪 testing' },
    { key: 'allows_any_pump', label: 'Allows “Any / mixed pump” (e.g. rental repairs)', badge: 'any pump' },
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
        cfg.extraFields.map((x) => {
          if (x.type === 'color' || !row[x.key]) return null;
          const text = x.show ? x.show(row[x.key]) : row[x.key];
          return text ? h('span', { class: 'tag' }, text) : null;
        }),
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
      : x.type === 'select'
        ? (() => {
            const sel = h('select', {}, h('option', { value: '' }, '— none —'),
              x.options().filter((o) => o.active !== false || o.id === row?.[x.key]).map((o) => h('option', { value: o.id }, o.name)));
            sel.value = row?.[x.key] ?? '';
            return sel;
          })()
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

// ----------------------------------------------------- test areas & limits
async function renderTestAreas(card, reloadAll) {
  const [areas, limits, limitModels, shared, models, tasks, settings] = await Promise.all([
    supabase.from('test_areas').select('*').order('sort_order').order('name'),
    supabase.from('test_limits').select('*').order('sort_order').order('name'),
    supabase.from('test_limit_models').select('test_limit_id, pump_model_id'),
    supabase.from('test_area_shared_tasks').select('test_area_id, task_id'),
    supabase.from('pump_models').select('id, name, short_code, test_area_id, active').order('sort_order'),
    supabase.from('tasks').select('id, name, is_testing, active').order('sort_order'),
    supabase.from('app_settings').select('max_pumps_on_test').eq('id', 1).single(),
  ]);
  const err = [areas, limits, limitModels, shared, models, tasks, settings].find((r) => r.error)?.error;
  if (reportError(err, 'Loading test areas')) return;
  const modelName = new Map(models.data.map((m) => [m.id, m.name]));
  const taskName = new Map(tasks.data.map((t) => [t.id, t.name]));
  const reload = () => renderTestAreas(card, reloadAll);

  const siteMax = h('input', { type: 'number', min: 1, max: 99, value: settings.data.max_pumps_on_test, style: 'width:5.5rem' });
  const saveSite = h('button', { class: 'btn btn-sm', onclick: async () => {
    const v = Number(siteMax.value);
    if (!Number.isInteger(v) || v < 1) { toast('Enter a whole number of pumps.', 'error'); return; }
    const { error } = await supabase.from('app_settings').update({ max_pumps_on_test: v }).eq('id', 1);
    if (!reportError(error, 'Saving')) toast('Site-wide limit saved.', 'success');
  } }, 'Save');

  const areaBlock = (a) => {
    const aModels = models.data.filter((m) => m.test_area_id === a.id).map((m) => m.short_code || m.name);
    const aShared = shared.data.filter((s) => s.test_area_id === a.id).map((s) => taskName.get(s.task_id));
    const aLimits = limits.data.filter((l) => l.test_area_id === a.id);
    return h('div', { class: `area-block ${a.active ? '' : 'inactive'}` },
      h('div', { class: 'area-head' },
        h('div', {},
          h('b', { class: 'ref-name' }, a.name), h('span', { class: 'tag tag-accent' }, `max ${a.max_pumps} at once`),
          a.active ? null : h('span', { class: 'tag tag-muted' }, 'inactive'),
          h('div', { class: 'muted small' }, `Models: ${aModels.join(', ') || 'none yet (set a default test area on each pump model)'}`),
          aShared.length ? h('div', { class: 'muted small' }, `Counted once when run together: ${aShared.join(' + ')}`) : null,
        ),
        h('div', { class: 'ref-actions' },
          h('button', { class: 'btn btn-sm', onclick: () => editArea(a) }, 'Edit'),
          h('button', { class: 'btn btn-sm', onclick: () => editLimit(null, a.id) }, '+ Limit group'),
          h('button', { class: 'btn btn-sm btn-danger', onclick: () => removeArea(a) }, 'Delete'),
        ),
      ),
      aLimits.length ? h('ul', { class: 'ref-list limit-list' }, aLimits.map((l) => h('li', { class: l.active ? '' : 'inactive' },
        h('div', { class: 'ref-main' }, h('span', { class: 'ref-name' }, l.name), h('span', { class: 'tag' }, `max ${l.max_pumps}`),
          h('span', { class: 'muted small', style: 'margin-left:.5rem' },
            limitModels.data.filter((x) => x.test_limit_id === l.id).map((x) => modelName.get(x.pump_model_id)).join(' + ') || 'no models')),
        h('div', { class: 'ref-actions' },
          h('button', { class: 'btn btn-sm', onclick: () => editLimit(l, a.id) }, 'Edit'),
          h('button', { class: 'btn btn-sm btn-danger', onclick: () => removeLimit(l) }, 'Delete')),
      ))) : null,
    );
  };

  function editArea(a) {
    const name = h('input', { type: 'text', value: a?.name ?? '', maxlength: 80 });
    const max = h('input', { type: 'number', min: 1, max: 99, value: a?.max_pumps ?? 1 });
    const notes = h('input', { type: 'text', value: a?.notes ?? '', maxlength: 160 });
    const active = checkbox('Active', a ? a.active : true);
    const current = new Set(shared.data.filter((s) => s.test_area_id === a?.id).map((s) => s.task_id));
    const sharedBoxes = tasks.data.filter((t) => t.is_testing).map((t) => ({ id: t.id, ...checkbox(t.name, current.has(t.id)) }));
    const error = h('p', { class: 'form-error', role: 'alert' });
    openModal({
      title: a ? 'Edit test area' : 'Add test area',
      body: h('div', { class: 'stack' },
        h('div', { class: 'form-grid form-grid-2' }, field('Name', name), field('Max pumps on test at once', max)),
        field('Notes', notes),
        h('fieldset', { class: 'skills-fieldset' }, h('legend', {}, 'Tasks that run together on the same pumps (count once)'),
          h('div', { class: 'check-grid' }, sharedBoxes.map((b) => b.el)),
          h('p', { class: 'muted small' }, 'E.g. calibration and quality testing on Medicare / Mediflex: running both at once is not a clash.')),
        active.el, error),
      actions: [{ label: 'Cancel' }, { label: 'Save', variant: 'primary', onClick: async () => {
        const values = { name: name.value.trim(), max_pumps: Number(max.value), notes: notes.value.trim() || null, active: active.input.checked };
        if (!values.name) { error.textContent = 'Please enter a name.'; return false; }
        if (!Number.isInteger(values.max_pumps) || values.max_pumps < 1) { error.textContent = 'Max pumps must be a whole number (1 or more).'; return false; }
        let id = a?.id;
        if (a) {
          const { error: e } = await supabase.from('test_areas').update(values).eq('id', id);
          if (reportError(e, 'Saving')) return false;
        } else {
          const { data, error: e } = await supabase.from('test_areas').insert({ ...values, sort_order: (areas.data.length + 1) * 10 }).select('id').single();
          if (reportError(e, 'Saving')) return false;
          id = data.id;
        }
        const want = new Set(sharedBoxes.filter((b) => b.input.checked).map((b) => b.id));
        const add = [...want].filter((t) => !current.has(t)).map((t) => ({ test_area_id: id, task_id: t }));
        const del = [...current].filter((t) => !want.has(t));
        if (add.length) { const { error: e } = await supabase.from('test_area_shared_tasks').insert(add); if (reportError(e, 'Saving')) return false; }
        if (del.length) { const { error: e } = await supabase.from('test_area_shared_tasks').delete().eq('test_area_id', id).in('task_id', del); if (reportError(e, 'Saving')) return false; }
        toast('Test area saved.', 'success');
        reloadAll();
        return true;
      } }],
    });
  }

  function editLimit(l, areaId) {
    const name = h('input', { type: 'text', value: l?.name ?? '', maxlength: 80, placeholder: 'e.g. MediAir + Simplex' });
    const max = h('input', { type: 'number', min: 1, max: 99, value: l?.max_pumps ?? 1 });
    const current = new Set(limitModels.data.filter((x) => x.test_limit_id === l?.id).map((x) => x.pump_model_id));
    const boxes = models.data.filter((m) => m.active || current.has(m.id)).map((m) => ({ id: m.id, ...checkbox(m.name, current.has(m.id)) }));
    const error = h('p', { class: 'form-error', role: 'alert' });
    openModal({
      title: l ? 'Edit limit group' : 'Add limit group',
      body: h('div', { class: 'stack' },
        h('div', { class: 'form-grid form-grid-2' }, field('Name', name), field('Max pumps on test at once (combined)', max)),
        h('fieldset', { class: 'skills-fieldset' }, h('legend', {}, 'Pump models in this group'), h('div', { class: 'check-grid' }, boxes.map((b) => b.el))),
        error),
      actions: [{ label: 'Cancel' }, { label: 'Save', variant: 'primary', onClick: async () => {
        const values = { name: name.value.trim(), max_pumps: Number(max.value), test_area_id: areaId };
        const want = new Set(boxes.filter((b) => b.input.checked).map((b) => b.id));
        if (!values.name) { error.textContent = 'Please enter a name.'; return false; }
        if (!Number.isInteger(values.max_pumps) || values.max_pumps < 1) { error.textContent = 'Max pumps must be a whole number (1 or more).'; return false; }
        if (!want.size) { error.textContent = 'Tick at least one pump model.'; return false; }
        let id = l?.id;
        if (l) {
          const { error: e } = await supabase.from('test_limits').update(values).eq('id', id);
          if (reportError(e, 'Saving')) return false;
        } else {
          const { data, error: e } = await supabase.from('test_limits').insert(values).select('id').single();
          if (reportError(e, 'Saving')) return false;
          id = data.id;
        }
        const add = [...want].filter((m) => !current.has(m)).map((m) => ({ test_limit_id: id, pump_model_id: m }));
        const del = [...current].filter((m) => !want.has(m));
        if (add.length) { const { error: e } = await supabase.from('test_limit_models').insert(add); if (reportError(e, 'Saving')) return false; }
        if (del.length) { const { error: e } = await supabase.from('test_limit_models').delete().eq('test_limit_id', id).in('pump_model_id', del); if (reportError(e, 'Saving')) return false; }
        toast('Limit group saved.', 'success');
        reload();
        return true;
      } }],
    });
  }

  async function removeArea(a) {
    if (!(await confirmDialog('Delete test area?', `Delete “${a.name}” and its limit groups? Pump models in it will have no default test area until you pick another.`))) return;
    const { error } = await supabase.from('test_areas').delete().eq('id', a.id);
    if (!reportError(error, 'Deleting')) { toast('Test area deleted.', 'success'); reloadAll(); }
  }
  async function removeLimit(l) {
    if (!(await confirmDialog('Delete limit group?', `Delete “${l.name}”?`))) return;
    const { error } = await supabase.from('test_limits').delete().eq('id', l.id);
    if (!reportError(error, 'Deleting')) { toast('Limit group deleted.', 'success'); reload(); }
  }

  mount(card,
    h('div', { class: 'card-head' },
      h('h2', {}, 'Test areas & limits'),
      h('button', { class: 'btn btn-primary btn-sm', onclick: () => editArea(null) }, '+ Add test area')),
    h('p', { class: 'muted small' }, 'Pumps are tested several at a time. The planner adds up testing jobs (quantity = pumps on test) at overlapping times — including overnight and background jobs — and warns when an area, a limit group or the site-wide maximum is exceeded. Mark testing tasks under Tasks, and give each pump model a default test area.'),
    h('div', { class: 'site-max' }, h('span', {}, 'All areas together: max'), siteMax, h('span', {}, 'pumps on test at once'), saveSite),
    areas.data.length ? h('div', { class: 'stack' }, areas.data.map(areaBlock)) : h('p', { class: 'empty' }, 'No test areas yet.'),
  );
}
