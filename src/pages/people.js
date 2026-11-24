import { h, mount, toast, reportError, openModal, confirmDialog, field, checkbox } from '../ui.js';
import { supabase } from '../supabase.js';
import { auth } from '../auth.js';
import { makeHours, patternSummary, hoursText, hasOverrides } from '../hours.js';
import { editPersonPattern } from './hoursEditor.js';
import { toISO, today, mondayOf, addDays, fromISO, fmtDate } from '../dates.js';
import { fmtMin, toMin } from '../daytime.js';

let showInactive = false;

// People + skills matrix. Viewers see it read-only; RLS enforces this too.
export async function renderPeople(main) {
  const optional = (q) => q.then((x) => (x.error ? { data: null, error: null } : x));
  const [people, models, skills, patterns, patternDays, personPatterns, settings, profiles] = await Promise.all([
    supabase.from('people').select('*').order('name'),
    supabase.from('pump_models').select('id, name, short_code, active').order('sort_order').order('name'),
    supabase.from('person_skills').select('person_id, pump_model_id'),
    optional(supabase.from('work_patterns').select('*').order('sort_order').order('name')),
    optional(supabase.from('work_pattern_days').select('*')),
    optional(supabase.from('person_work_patterns').select('*').order('effective_from')),
    supabase.from('app_settings').select('*').eq('id', 1).maybeSingle(),
    auth.isAdmin ? supabase.from('profiles').select('id, full_name, email') : Promise.resolve({ data: [] }),
  ]);
  if (reportError(people.error || models.error || skills.error, 'Loading people')) return;
  const hoursReady = Array.isArray(patterns.data);

  const admin = auth.isAdmin;
  const reload = () => renderPeople(main);
  const activeModels = models.data.filter((m) => m.active);
  const skillSet = new Set(skills.data.map((s) => `${s.person_id}|${s.pump_model_id}`));
  const has = (p, m) => skillSet.has(`${p.id}|${m.id}`);
  const visible = people.data.filter((p) => showInactive || p.active);
  const inactiveCount = people.data.filter((p) => !p.active).length;

  const toggleSkill = async (person, model, input) => {
    input.disabled = true;
    const key = `${person.id}|${model.id}`;
    const q = input.checked
      ? supabase.from('person_skills').insert({ person_id: person.id, pump_model_id: model.id })
      : supabase.from('person_skills').delete().eq('person_id', person.id).eq('pump_model_id', model.id);
    const { error } = await q;
    input.disabled = false;
    if (reportError(error, 'Updating skills')) {
      input.checked = !input.checked;
      return;
    }
    if (input.checked) skillSet.add(key); else skillSet.delete(key);
    countCell(person).textContent = String(activeModels.filter((m) => has(person, m)).length);
  };

  const countCells = new Map();
  const countCell = (p) => {
    if (!countCells.has(p.id)) countCells.set(p.id, h('td', { class: 'num' }));
    return countCells.get(p.id);
  };

  const header = h('tr', {},
    h('th', { class: 'sticky-col', scope: 'col' }, 'Name'),
    activeModels.map((m) => h('th', { class: 'skill-col', scope: 'col', title: m.name },
      h('span', {}, m.short_code || m.name),
    )),
    h('th', { scope: 'col', class: 'num', title: 'Number of pump models trained on' }, 'Trained'),
    admin ? h('th', { scope: 'col' }, h('span', { class: 'sr-only' }, 'Actions')) : null,
  );

  const body = visible.map((p) => {
    countCell(p).textContent = String(activeModels.filter((m) => has(p, m)).length);
    return h('tr', { class: p.active ? '' : 'inactive' },
      h('th', { class: 'sticky-col person-cell', scope: 'row' },
        h('div', { class: 'person-name' }, p.name, p.active ? null : h('span', { class: 'tag tag-muted' }, 'inactive')),
        p.job_title ? h('div', { class: 'muted small' }, p.job_title) : null,
        p.notes ? h('div', { class: 'muted small person-notes', title: p.notes }, p.notes) : null,
      ),
      activeModels.map((m) => {
        if (!admin) {
          return h('td', { class: 'skill-cell' },
            has(p, m) ? h('span', { class: 'tick', 'aria-label': `${p.name} trained on ${m.name}` }, '✓') : h('span', { class: 'sr-only' }, 'not trained'));
        }
        const input = h('input', { type: 'checkbox', 'aria-label': `${p.name} trained on ${m.name}`, title: `${p.name} — ${m.name}` });
        input.checked = has(p, m);
        input.addEventListener('change', () => toggleSkill(p, m, input));
        return h('td', { class: 'skill-cell' }, input);
      }),
      countCell(p),
      admin ? h('td', { class: 'row-actions' },
        h('button', { class: 'btn btn-sm', onclick: () => editPerson(p, models.data, skillSet, reload, profiles.data || [], people.data) }, 'Edit'),
      ) : null,
    );
  });

  const table = visible.length
    ? h('div', { class: 'table-scroll' },
        h('table', { class: 'matrix' }, h('thead', {}, header), h('tbody', {}, body)))
    : h('div', { class: 'empty' }, admin ? 'No team members yet. Click "Add person" to start.' : 'No team members yet.');

  const inactiveToggle = inactiveCount
    ? checkbox(`Show inactive (${inactiveCount})`, showInactive, {
        onchange: (e) => { showInactive = e.target.checked; reload(); },
      }).el
    : null;

  mount(main,
    h('div', { class: 'page-head' },
      h('h1', { class: 'page-title' }, 'People'),
      h('div', { class: 'page-head-actions' },
        inactiveToggle,
        admin ? h('button', { class: 'btn btn-primary', onclick: () => editPerson(null, models.data, skillSet, reload, profiles.data || [], people.data) }, '+ Add person') : null,
      ),
    ),
    h('section', { class: 'card card-flush' },
      h('div', { class: 'card-head card-pad' },
        h('h2', {}, 'Team & training matrix'),
        h('span', { class: 'muted small' },
          admin ? 'Tick the pump models each person is trained on. Changes save immediately.'
                : 'Pump models each person is trained on.'),
      ),
      table,
    ),
    hoursReady ? hoursCard({ people: visible, patterns: patterns.data, patternDays: patternDays.data, personPatterns: personPatterns.data, settings: settings.data, admin, reload }) : null,
  );
}

// ------------------------------------------------------------------ working hours per person
function hoursCard({ people, patterns, patternDays, personPatterns, settings, admin, reload }) {
  const hrs = makeHours({ patterns, patternDays, personPatterns, settings });
  const todayISO = toISO(today());
  const monday = mondayOf(today());
  const weekDays = (personId) => [1, 2, 3, 4, 5, 6, 7].map((w) => {
    const x = hrs.forDay(personId, toISO(addDays(monday, w - 1)));
    return { weekday: w, works: x.works, start_time: x.work_start, end_time: x.work_end, break_time: x.break_time, break_minutes: x.break_minutes, lunch_time: x.lunch_time, lunch_minutes: x.lunch_minutes };
  });
  const overrideText = (a) => [a.start_time && `start ${fmtMin(toMin(a.start_time))}`, a.end_time && `finish ${fmtMin(toMin(a.end_time))}`,
    a.break_time && `break ${fmtMin(toMin(a.break_time))}`, a.break_minutes != null && `break ${a.break_minutes}m`,
    a.lunch_time && `lunch ${fmtMin(toMin(a.lunch_time))}`, a.lunch_minutes != null && `lunch ${a.lunch_minutes}m`].filter(Boolean).join(', ');
  const rows = people.map((p) => {
    const mine = personPatterns.filter((a) => a.person_id === p.id);
    const cur = hrs.assignmentOn(p.id, todayISO);
    const pat = cur ? hrs.patternById.get(cur.pattern_id) : hrs.defaultPattern;
    return h('tr', { 'data-person': p.id },
      h('th', { scope: 'row', class: 'person-cell' }, h('div', { class: 'person-name' }, p.name)),
      h('td', {}, h('b', {}, pat?.name || 'Standard'), cur ? null : h('span', { class: 'muted small' }, ' (default)'),
        cur && hasOverrides(cur) ? h('span', { class: 'tag tag-accent', title: overrideText(cur) }, 'own hours') : null),
      h('td', { class: 'hours-week' }, patternSummary(weekDays(p.id))),
      h('td', {}, mine.length
        ? h('ul', { class: 'hours-history' }, mine.map((a) => h('li', {},
            h(admin ? 'button' : 'span', admin ? { type: 'button', class: 'linklike', onclick: () => editPersonPattern({ person: p, patterns, assignment: a, onSaved: reload }) } : {},
              `${hrs.patternById.get(a.pattern_id)?.name || 'Pattern'} from ${fmtDate(fromISO(a.effective_from))}`),
            hasOverrides(a) ? h('span', { class: 'muted small' }, ` · ${overrideText(a)}`) : null,
            a.effective_from > todayISO ? h('span', { class: 'tag' }, 'upcoming') : null)))
        : h('span', { class: 'muted small' }, 'Default pattern')),
      admin ? h('td', { class: 'row-actions' },
        h('button', { class: 'btn btn-sm', title: `Change ${p.name}’s hours from a date`, onclick: () => editPersonPattern({ person: p, patterns, assignment: null, onSaved: reload }) }, 'Change hours…')) : null,
    );
  });
  return h('section', { class: 'card card-flush hours-card' },
    h('div', { class: 'card-head card-pad' },
      h('h2', {}, 'Working hours'),
      h('span', { class: 'muted small' }, admin
        ? 'Each person’s pattern from a date (past weeks keep their hours), with optional personal changes. One-off changes for a single day: use “Hours” on the planner.'
        : 'Each person’s working hours. Ask an admin to change them.')),
    h('div', { class: 'table-scroll' }, h('table', { class: 'data-table' },
      h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Person'), h('th', { scope: 'col' }, 'Pattern now'), h('th', { scope: 'col' }, 'This week'),
        h('th', { scope: 'col' }, 'Changes (effective from)'), admin ? h('th', { scope: 'col' }, h('span', { class: 'sr-only' }, 'Actions')) : null)),
      h('tbody', {}, rows))),
  );
}

function editPerson(person, allModels, skillSet, onSaved, profiles = [], allPeople = []) {
  const canLink = profiles.length > 0 && (!allPeople.length || allPeople.some((x) => 'user_id' in x));
  const taken = new Set(allPeople.filter((x) => x.user_id && x.id !== person?.id).map((x) => x.user_id));
  const login = h('select', {}, h('option', { value: '' }, '— none —'),
    profiles.filter((pr) => !taken.has(pr.id)).map((pr) => h('option', { value: pr.id }, pr.full_name ? `${pr.full_name} (${pr.email})` : pr.email)));
  login.value = person?.user_id || '';
  const name = h('input', { type: 'text', value: person?.name ?? '', required: true, maxlength: 80, autocomplete: 'off' });
  const jobTitle = h('input', { type: 'text', value: person?.job_title ?? '', maxlength: 80, placeholder: 'e.g. Assembly operator' });
  const notes = h('textarea', { rows: 2, maxlength: 500 }, person?.notes ?? '');
  // Show active models, plus any inactive ones the person is already trained on.
  const models = allModels.filter((m) => m.active || (person && skillSet.has(`${person.id}|${m.id}`)));
  const skillBoxes = models.map((m) => ({
    model: m,
    ...checkbox(m.active ? m.name : `${m.name} (inactive)`, person && skillSet.has(`${person.id}|${m.id}`)),
  }));
  const error = h('p', { class: 'form-error', role: 'alert' });

  const actions = [{ label: 'Cancel' }];
  if (person) {
    actions.unshift({
      label: 'Delete',
      variant: 'danger',
      onClick: async () => {
        const ok = await confirmDialog('Delete person?',
          `Delete ${person.name} permanently? This only works if they have never been scheduled. Otherwise use "Deactivate" to hide them from planning.`);
        if (!ok) return false;
        const { error: err } = await supabase.from('people').delete().eq('id', person.id);
        if (reportError(err, `Could not delete ${person.name}`)) return false;
        toast(`${person.name} deleted.`, 'success');
        onSaved();
        return true;
      },
    });
    actions.splice(1, 0, {
      label: person.active ? 'Deactivate' : 'Reactivate',
      onClick: async () => {
        const { error: err } = await supabase.from('people').update({ active: !person.active }).eq('id', person.id);
        if (reportError(err, 'Updating')) return false;
        toast(`${person.name} ${person.active ? 'deactivated' : 'reactivated'}.`, 'success');
        onSaved();
        return true;
      },
    });
  }
  actions.push({
    label: 'Save',
    variant: 'primary',
    onClick: async () => {
      const values = {
        name: name.value.trim(),
        job_title: jobTitle.value.trim() || null,
        notes: notes.value.trim() || null,
      };
      if (canLink) values.user_id = login.value || null;
      if (!values.name) { error.textContent = 'Please enter a name.'; return false; }

      let id = person?.id;
      if (person) {
        const { error: err } = await supabase.from('people').update(values).eq('id', id);
        if (reportError(err, 'Saving')) return false;
      } else {
        const { data, error: err } = await supabase.from('people').insert(values).select('id').single();
        if (reportError(err, 'Saving')) return false;
        id = data.id;
      }

      // Sync skills: add newly ticked, remove unticked.
      const add = [];
      const remove = [];
      for (const b of skillBoxes) {
        const had = Boolean(person) && skillSet.has(`${person.id}|${b.model.id}`);
        if (b.input.checked && !had) add.push({ person_id: id, pump_model_id: b.model.id });
        if (!b.input.checked && had) remove.push(b.model.id);
      }
      if (add.length) {
        const { error: err } = await supabase.from('person_skills').insert(add);
        if (reportError(err, 'Saving skills')) return false;
      }
      if (remove.length) {
        const { error: err } = await supabase.from('person_skills').delete().eq('person_id', id).in('pump_model_id', remove);
        if (reportError(err, 'Saving skills')) return false;
      }
      toast(`${values.name} saved.`, 'success');
      onSaved();
      return true;
    },
  });

  openModal({
    title: person ? `Edit ${person.name}` : 'Add person',
    body: h('div', { class: 'stack' },
      field('Name', name),
      field('Job title / role', jobTitle),
      field('Notes', notes),
      canLink ? field('Linked login', login, 'Optional. The person who signs in with this login sees their own hours on Today.') : null,
      h('fieldset', { class: 'skills-fieldset' },
        h('legend', {}, 'Trained on'),
        h('div', { class: 'check-grid' }, skillBoxes.map((b) => b.el)),
      ),
      error,
    ),
    actions,
  });
  name.focus();
}
