import './styles.css';
import { supabase, isConfigured } from './supabase.js';
import { auth, loadSession, loadProfile, signOut } from './auth.js';
import { h, mount, hhmm } from './ui.js';
import { renderLogin } from './pages/login.js';
import { renderPlanner } from './pages/planner.js';
import { renderDemand } from './pages/demand.js';
import { renderHistory } from './pages/history.js';
import { renderAccount } from './pages/account.js';
import { renderPeople } from './pages/people.js';
import { renderSettings } from './pages/settings.js';

const app = document.getElementById('app');

// Hash routes. `admin: true` hides the page from viewers (RLS still
// enforces the real permissions in the database).
const routes = {
  '/planner':  { label: 'Planner',        render: renderPlanner },
  '/demand':   { label: 'Demand & Notes', render: renderDemand },
  '/people':   { label: 'People',         render: renderPeople },
  '/settings': { label: 'Settings',       render: renderSettings, admin: true },
  '/history':  { label: 'History',        render: renderHistory, admin: true },
  '/account':  { label: 'My account',     render: renderAccount, hidden: true },
};
const DEFAULT_ROUTE = '/planner';

function currentPath() {
  // "#/planner?week=2026-11-23" -> "/planner"
  const path = location.hash.replace(/^#/, '').split('?')[0] || DEFAULT_ROUTE;
  return routes[path] ? path : DEFAULT_ROUTE;
}

let workingHours = null;
async function loadWorkingHours() {
  const { data } = await supabase.from('app_settings').select('*').eq('id', 1).maybeSingle();
  workingHours = data;
}

function header(path) {
  const navLinks = Object.entries(routes)
    .filter(([, r]) => !r.hidden && (!r.admin || auth.isAdmin))
    .map(([p, r]) =>
      h('a', { href: `#${p}`, class: p === path ? 'active' : '', 'aria-current': p === path ? 'page' : false }, r.label),
    );

  const hours = workingHours
    ? h('div', { class: 'hours', title: 'Working hours (admin can change in Settings)' },
        `${hhmm(workingHours.work_start)}–${hhmm(workingHours.work_end)}`,
        h('span', { class: 'muted' },
          ` · Break ${hhmm(workingHours.break_time)} · Lunch ${hhmm(workingHours.lunch_time)}`),
      )
    : null;

  const name = auth.profile?.full_name || auth.session?.user.email;
  return h('header', { class: 'topbar' },
    h('div', { class: 'topbar-inner' },
      h('a', { class: 'brand', href: `#${DEFAULT_ROUTE}` },
        h('span', { class: 'brand-mark', 'aria-hidden': 'true' }),
        h('span', {}, 'Pump Room Planner'),
      ),
      h('nav', { class: 'mainnav', 'aria-label': 'Main' }, navLinks),
      h('div', { class: 'topbar-right' },
        hours,
        h('a', { class: 'user-chip', href: '#/account', title: 'My account' },
          h('span', {}, name),
          h('span', { class: `role-badge role-${auth.profile?.app_role}` }, auth.profile?.app_role),
        ),
        h('button', { class: 'btn btn-ghost btn-sm', onclick: () => signOut() }, 'Sign out'),
      ),
    ),
  );
}

async function render() {
  if (!isConfigured) {
    mount(app, h('main', { class: 'center-page' },
      h('div', { class: 'card narrow' },
        h('h1', {}, 'Setup needed'),
        h('p', {}, 'The Supabase URL and anon key are missing. For local development copy .env.example to .env; for GitHub Pages set the repository variables VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (see README).'),
      )));
    return;
  }

  if (!auth.session) {
    renderLogin(app);
    return;
  }

  if (!auth.isMember) {
    mount(app, h('main', { class: 'center-page' },
      h('div', { class: 'card narrow' },
        h('h1', {}, 'Account not enabled'),
        h('p', {}, `You are signed in as ${auth.session.user.email}, but this account has not been enabled for the planner. Please contact the administrator.`),
        h('button', { class: 'btn', onclick: () => signOut() }, 'Sign out'),
      )));
    return;
  }

  const path = currentPath();
  const route = routes[path];
  const main = h('main', { class: 'page', id: 'main' });
  mount(app, header(path), main);
  if (route.admin && !auth.isAdmin) {
    mount(main, h('div', { class: 'card' }, 'This page is for administrators only.'));
    return;
  }
  document.title = `${route.label} · Pump Room Planner`;
  await route.render(main, { refreshHeader: async () => { await loadWorkingHours(); render(); } });
}

async function start() {
  if (isConfigured) {
    await loadSession();
    if (auth.isMember) await loadWorkingHours();

    supabase.auth.onAuthStateChange((event, session) => {
      const sameUser = (session?.user.id ?? null) === (auth.session?.user.id ?? null);
      auth.session = session;
      // Token refreshes and focus re-checks fire auth events too: only
      // re-render when the signed-in user actually changes.
      if (sameUser && event !== 'USER_UPDATED') return;
      // Defer DB calls out of the auth callback (recommended by supabase-js).
      setTimeout(async () => {
        await loadProfile();
        if (auth.isMember) await loadWorkingHours();
        render();
      }, 0);
    });
  }
  window.addEventListener('hashchange', render);
  render();
}

start();
