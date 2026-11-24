import '@fontsource-variable/inter';
import '@fontsource-variable/fraunces';
import './styles.css';
import { supabase, isConfigured } from './supabase.js';
import { auth, loadSession, loadProfile, signOut } from './auth.js';
import { h, mount, hhmm, toast, avatar } from './ui.js';
import { initTheme, toggleTheme } from './theme.js';
import { icon } from './icons.js';
import { startRealtime, stopRealtime } from './realtime.js';
import { renderLogin } from './pages/login.js';
import { renderToday } from './pages/today.js';
import { renderPlanner } from './pages/planner.js';
import { renderDemand } from './pages/demand.js';
import { renderHistory } from './pages/history.js';
import { renderAccount } from './pages/account.js';
import { renderPeople } from './pages/people.js';
import { renderSettings } from './pages/settings.js';

initTheme();
const app = document.getElementById('app');

// Hash routes. `admin: true` hides the page from viewers (RLS still
// enforces the real permissions in the database).
const routes = {
  '/today':    { label: 'Today',          icon: 'today',    render: renderToday },
  '/planner':  { label: 'Week planner',   icon: 'week',     render: renderPlanner, tab: 'Week' },
  '/demand':   { label: 'Demand & notes', icon: 'notes',    render: renderDemand, tab: 'Notes' },
  '/people':   { label: 'People',         icon: 'people',   render: renderPeople },
  '/settings': { label: 'Settings',       icon: 'settings', render: renderSettings, admin: true },
  '/history':  { label: 'History',        icon: 'history',  render: renderHistory, admin: true },
  '/account':  { label: 'My account',     icon: 'account',  render: renderAccount, hidden: true },
};
const DEFAULT_ROUTE = '/today';
const TAB_ROUTES = ['/today', '/planner', '/demand', '/people'];
const LOGO = 'brand/logo.png'; // drop-in file in /public/brand — the wordmark shows if it is missing

function currentPath() {
  // "#/planner?week=2026-11-23" -> "/planner"
  const path = location.hash.replace(/^#/, '').split('?')[0] || DEFAULT_ROUTE;
  return routes[path] ? path : DEFAULT_ROUTE;
}

// ---------------------------------------------------------------- shared state
let workingHours = null;
let overdueCount = 0;
let liveOn = false;
let names = new Map();
let collapsed = (() => { try { return localStorage.getItem('sidebar') === 'collapsed'; } catch { return false; } })();

async function loadShellData() {
  const today = new Date().toISOString().slice(0, 10);
  const [hours, overdue, profiles] = await Promise.all([
    supabase.from('app_settings').select('*').eq('id', 1).maybeSingle(),
    supabase.from('demand_notes').select('id', { count: 'exact', head: true }).in('status', ['open', 'planned']).lt('needed_by', today),
    supabase.from('profiles').select('id, full_name, email'),
  ]);
  workingHours = hours.data;
  overdueCount = overdue.count || 0;
  names = new Map((profiles.data || []).map((p) => [p.id, p.full_name || p.email]));
}

// ---------------------------------------------------------------- shell
function logo(cls) {
  const img = h('img', { class: cls, src: LOGO, alt: 'Meditec — Enhancing patient care' });
  img.addEventListener('error', () => img.closest('.brand, .login-brandmark')?.classList.add('no-logo'));
  return img;
}

function navLinks(path) {
  return Object.entries(routes)
    .filter(([, r]) => !r.hidden && (!r.admin || auth.isAdmin))
    .map(([p, r]) => h('a', {
      href: `#${p}`, class: p === path ? 'active' : '', 'aria-current': p === path ? 'page' : false, title: r.label,
    }, icon(r.icon), h('span', {}, r.label),
    p === '/demand' && overdueCount ? h('b', { class: 'nav-count', title: `${overdueCount} overdue` }, String(overdueCount)) : null));
}

function sidebar(path) {
  const name = auth.profile?.full_name || auth.session?.user.email;
  const hours = workingHours
    ? h('div', { class: 'hours', title: 'Working hours (Settings)' },
        h('b', {}, `${hhmm(workingHours.work_start)}–${hhmm(workingHours.work_end)}`),
        ` · Break ${hhmm(workingHours.break_time)} · Lunch ${hhmm(workingHours.lunch_time)}`)
    : null;
  return h('aside', { class: 'sidebar', 'aria-label': 'Main navigation' },
    h('a', { class: 'brand', href: `#${DEFAULT_ROUTE}` }, logo('brand-logo'), h('span', { class: 'brand-word' }, 'Meditec')),
    h('span', { class: 'brand-mini', 'aria-hidden': 'true' }, 'M'),
    h('span', { class: 'brand-sub' }, 'Pump Room Planner'),
    h('nav', { class: 'mainnav' }, navLinks(path)),
    h('div', { class: 'side-foot' },
      hours,
      h('span', { class: `live ${liveOn ? 'on' : ''}`, id: 'live', title: liveOn ? 'Live: changes by others appear automatically' : 'Live updates connecting…' },
        h('i'), h('span', {}, liveOn ? 'Live' : 'Connecting…')),
      h('a', { class: 'me', href: '#/account', title: 'My account' },
        avatar(name, auth.session?.user.id),
        h('div', { class: 'who' }, name, h('br'), h('span', {}, auth.profile?.app_role === 'admin' ? 'Admin' : 'Viewer'))),
      h('div', { class: 'side-actions' },
        h('button', { class: 'theme-toggle', 'aria-label': 'Switch light / dark mode', title: 'Light / dark', onclick: toggleTheme }),
        h('button', { class: 'btn btn-ghost btn-sm signout', onclick: () => signOut() }, 'Sign out'),
        h('button', {
          class: 'collapse-btn', title: 'Collapse sidebar', 'aria-label': 'Collapse sidebar',
          onclick: () => {
            collapsed = !collapsed;
            document.querySelector('.app-shell')?.classList.toggle('collapsed', collapsed);
            try { localStorage.setItem('sidebar', collapsed ? 'collapsed' : 'open'); } catch { /* ignore */ }
          },
        }, icon('chevron')),
      ),
    ),
  );
}

function tabbar(path) {
  const sheetBack = h('div', { class: 'sheet-back' });
  const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-label': 'More' },
    h('div', { class: 'grab' }),
    auth.isAdmin ? h('a', { href: '#/settings' }, icon('settings'), 'Settings') : null,
    auth.isAdmin ? h('a', { href: '#/history' }, icon('history'), 'History') : null,
    h('a', { href: '#/account' }, icon('account'), 'My account'),
    h('button', { class: 'sheet-item', onclick: toggleTheme }, icon('moon'), 'Light / dark mode'),
    h('button', { class: 'sheet-item', onclick: () => signOut() }, icon('signout'), 'Sign out'),
  );
  const close = () => { sheet.classList.remove('open'); sheetBack.classList.remove('open'); };
  sheetBack.addEventListener('click', close);
  sheet.addEventListener('click', (e) => { if (e.target.closest('a, button')) setTimeout(close, 50); });
  const tabs = TAB_ROUTES.map((p) => h('a', { href: `#${p}`, class: p === path ? 'active' : '' },
    icon(routes[p].icon), routes[p].tab || routes[p].label,
    p === '/demand' && overdueCount ? h('b', { class: 'nav-count' }, String(overdueCount)) : null));
  const moreActive = !TAB_ROUTES.includes(path);
  return [
    h('nav', { class: 'tabbar', 'aria-label': 'Main' }, tabs,
      h('button', { class: moreActive ? 'active' : '', onclick: () => { sheet.classList.add('open'); sheetBack.classList.add('open'); } }, icon('more'), 'More')),
    sheetBack, sheet,
  ];
}

// ---------------------------------------------------------------- render
let main = null;
let currentRoute = null;

async function render() {
  if (!isConfigured) {
    mount(app, h('main', { class: 'center-page' },
      h('div', { class: 'card narrow' },
        h('h1', {}, 'Setup needed'),
        h('p', {}, 'The Supabase URL and anon key are missing. For local development copy .env.example to .env; for GitHub Pages set the repository variables VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (see README).'),
      )));
    return;
  }
  if (!auth.session) { renderLogin(app); return; }
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
  currentRoute = route;
  main = h('main', { class: 'page page-enter', id: 'main' });
  mount(app, h('div', { class: `app-shell ${collapsed ? 'collapsed' : ''}` },
    sidebar(path),
    h('div', { class: 'content' }, main),
  ), ...tabbar(path));
  if (route.admin && !auth.isAdmin) {
    mount(main, h('div', { class: 'card' }, 'This page is for administrators only.'));
    return;
  }
  document.title = `${route.label} · Pump Room Planner`;
  await route.render(main, pageCtx());
  main.dataset.loaded = '1';
}

const pageCtx = () => ({ refreshHeader: async () => { await loadShellData(); render(); } });

/** Re-render the current page in place (no skeleton, no page animation). */
async function refreshQuietly() {
  if (!main || !currentRoute || !auth.isMember) return;
  if (document.querySelector('dialog[open]')) { pendingRefresh = true; return; } // don't disturb an open form
  await loadShellData();
  const counts = document.querySelectorAll('.nav-count');
  counts.forEach((c) => { c.textContent = String(overdueCount); c.hidden = !overdueCount; });
  main.classList.remove('page-enter');
  await currentRoute.render(main, pageCtx());
}

// ---------------------------------------------------------------- live updates
let pendingRefresh = false;
let liveTimer = null;
const LABEL = { assignments: 'the plan', absences: 'absences', demand_notes: 'demand notes', people: 'people', person_skills: 'training records',
  pump_models: 'pump models', tasks: 'tasks', build_types: 'build types', equipment: 'equipment', app_settings: 'working hours' };

function onLiveChange(payload) {
  const row = payload.new && Object.keys(payload.new).length ? payload.new : null;
  const by = row?.updated_by || row?.created_by;
  if (by && by !== auth.session?.user.id) {
    const who = names.get(by) || 'Someone';
    if (payload.table === 'demand_notes' && payload.eventType === 'INSERT') {
      toast(`${who} added a note${row.comment ? `: “${row.comment.slice(0, 70)}”` : ''}`, 'live');
    } else {
      toast(`${who} updated ${LABEL[payload.table] || 'the planner'}`, 'live');
    }
  }
  clearTimeout(liveTimer);
  liveTimer = setTimeout(refreshQuietly, 600); // batch bursts (e.g. copy last week)
}

setInterval(() => {
  if (pendingRefresh && !document.querySelector('dialog[open]')) { pendingRefresh = false; refreshQuietly(); }
}, 1000);

function setLive(on) {
  liveOn = on;
  const el = document.getElementById('live');
  if (el) {
    el.classList.toggle('on', on);
    el.title = on ? 'Live: changes by others appear automatically' : 'Live updates connecting…';
    el.lastChild.textContent = on ? 'Live' : 'Connecting…';
  }
}

// ---------------------------------------------------------------- start
async function start() {
  if (isConfigured) {
    await loadSession();
    if (auth.isMember) {
      await loadShellData();
      startRealtime({ onChange: onLiveChange, onStatus: setLive });
    }

    supabase.auth.onAuthStateChange((event, session) => {
      const sameUser = (session?.user.id ?? null) === (auth.session?.user.id ?? null);
      auth.session = session;
      // Token refreshes and focus re-checks fire auth events too: only
      // re-render when the signed-in user actually changes.
      if (sameUser && event !== 'USER_UPDATED') return;
      // Defer DB calls out of the auth callback (recommended by supabase-js).
      setTimeout(async () => {
        await loadProfile();
        if (auth.isMember) {
          await loadShellData();
          startRealtime({ onChange: onLiveChange, onStatus: setLive });
          // Everyone lands on "Today" after signing in.
          if (event === 'SIGNED_IN') history.replaceState(null, '', '#/today');
        } else {
          stopRealtime(); setLive(false);
        }
        render();
      }, 0);
    });
  }
  window.addEventListener('hashchange', render);
  render();
}

start();
