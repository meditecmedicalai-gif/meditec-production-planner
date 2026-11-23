import { h, mount, reportError } from '../ui.js';
import { supabase } from '../supabase.js';
import { auth } from '../auth.js';

// Phase 1 landing page: proves login, role and database access work.
// Replaced by the weekly planner in Phase 3.
export async function renderHome(main) {
  mount(main, h('h1', { class: 'page-title' }, 'Planner'), h('p', { class: 'muted' }, 'Loading…'));

  const [models, tasks] = await Promise.all([
    supabase.from('pump_models').select('name, short_code, is_trial, active').order('sort_order'),
    supabase.from('tasks').select('name, requires_pump, counts_as_output, active').order('sort_order'),
  ]);
  if (reportError(models.error, 'Loading pump models') || reportError(tasks.error, 'Loading tasks')) return;

  const list = (rows, extra) =>
    h('ul', { class: 'plain-list' }, rows.map((r) => h('li', {}, r.name, extra?.(r))));

  mount(main,
    h('h1', { class: 'page-title' }, 'Planner'),
    h('div', { class: 'card notice' },
      h('strong', {}, 'Phase 1: sign-in and database are working. '),
      `You are signed in as ${auth.profile.full_name || auth.profile.email} with the ${auth.profile.app_role} role. `,
      'The weekly planner grid arrives in Phase 3.',
    ),
    h('div', { class: 'grid-2' },
      h('section', { class: 'card' },
        h('h2', {}, `Pump models (${models.data.length})`),
        list(models.data, (m) => m.short_code && m.short_code !== m.name ? h('span', { class: 'tag' }, m.short_code) : null),
      ),
      h('section', { class: 'card' },
        h('h2', {}, `Tasks / operations (${tasks.data.length})`),
        list(tasks.data, (t) => t.counts_as_output ? h('span', { class: 'tag tag-accent' }, 'counts as output') : null),
      ),
    ),
  );
}
