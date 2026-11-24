// Small DOM helpers. Text is always set via textContent (never innerHTML)
// so notes typed by users can't inject HTML.

/**
 * h('div', { class: 'card', onclick: fn }, 'text', childNode, [more])
 */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === false || value == null) continue;
    if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'class') {
      el.className = value;
    } else if (key === 'dataset') {
      Object.assign(el.dataset, value);
    } else if (value === true) {
      el.setAttribute(key, '');
    } else {
      el.setAttribute(key, value);
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function mount(container, ...children) {
  container.replaceChildren();
  append(container, children);
}

// ---------------------------------------------------------------- toasts
let toastHost;
export function toast(message, type = 'info') {
  if (!toastHost) {
    toastHost = h('div', { class: 'toast-host', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastHost);
  }
  const t = h('div', { class: `toast toast-${type}` }, message);
  toastHost.append(t);
  while (toastHost.children.length > 3) toastHost.firstChild.remove();
  setTimeout(() => t.classList.add('toast-hide'), 3500);
  setTimeout(() => t.remove(), 4000);
}

/** Show a friendly message for a Supabase error and return true if there was one. */
export function reportError(error, context = 'Something went wrong') {
  if (!error) return false;
  console.error(context, error);
  let msg = error.message || String(error);
  if (error.code === '42501' || /row-level security/i.test(msg)) msg = 'You do not have permission to do that.';
  else if (error.code === '23503') msg = 'It is still in use elsewhere (e.g. in the schedule). Deactivate it instead.';
  else if (error.code === '23505') msg = 'An item with that name already exists.';
  toast(`${context}: ${msg}`, 'error');
  return true;
}

// ---------------------------------------------------------------- modal
/**
 * Opens a modal dialog. `body` is a node; `actions` is an array of
 * { label, variant, onClick } — onClick may return false to keep it open.
 */
export function openModal({ title, body, actions = [], wide = false }) {
  const dialog = h('dialog', { class: `modal ${wide ? 'modal-wide' : ''}` });
  const close = () => {
    dialog.close();
    dialog.remove();
  };
  const buttons = actions.map((a) =>
    h('button', {
      type: 'button',
      class: `btn ${a.variant ? 'btn-' + a.variant : ''}`,
      onclick: async () => {
        const keepOpen = (await a.onClick?.()) === false;
        if (!keepOpen) close();
      },
    }, a.label),
  );
  mount(dialog,
    h('div', { class: 'modal-head' },
      h('h2', {}, title),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', onclick: close }, '×'),
    ),
    h('div', { class: 'modal-body' }, body),
    buttons.length ? h('div', { class: 'modal-actions' }, buttons) : null,
  );
  dialog.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  document.body.append(dialog);
  dialog.showModal();
  return { close, dialog };
}

/** Formats a Postgres "HH:MM:SS" time as "HH:MM". */
export const hhmm = (t) => (t ? String(t).slice(0, 5) : '');

// ---------------------------------------------------------------- forms
let fieldSeq = 0;
/** Label + control wrapper. Returns the wrapper; the control keeps its own reference. */
export function field(label, control, hint) {
  const id = control.id || `f${++fieldSeq}`;
  control.id = id;
  return h('div', { class: 'field' },
    h('label', { for: id }, label),
    control,
    hint ? h('span', { class: 'hint' }, hint) : null,
  );
}

/** Checkbox with its label to the right. */
export function checkbox(label, checked = false, attrs = {}) {
  const input = h('input', { type: 'checkbox', ...attrs });
  input.checked = Boolean(checked);
  return { input, el: h('label', { class: 'check' }, input, h('span', {}, label)) };
}

/** Yes/no confirmation dialog. Resolves true if confirmed. */
export function confirmDialog(title, message, confirmLabel = 'Delete', variant = 'danger') {
  return new Promise((resolve) => {
    let answered = false;
    const { dialog } = openModal({
      title,
      body: h('p', {}, message),
      actions: [
        { label: 'Cancel', onClick: () => { answered = true; resolve(false); } },
        { label: confirmLabel, variant, onClick: () => { answered = true; resolve(true); } },
      ],
    });
    dialog.addEventListener('close', () => { if (!answered) resolve(false); });
  });
}

// ---------------------------------------------------------------- design helpers
/** Grey placeholder blocks shown while a page loads (only on first load). */
export function skeleton(kind = 'page') {
  const line = (w) => h('div', { class: 'sk sk-line', style: `width:${w}%` });
  return h('div', { class: 'skeleton', 'aria-busy': 'true', 'aria-label': 'Loading' },
    h('div', { class: 'sk sk-title' }),
    line(46),
    h('div', { class: 'sk-row' }, h('div', { class: 'sk sk-card' }), h('div', { class: 'sk sk-card' }), kind === 'page' ? h('div', { class: 'sk sk-card' }) : null),
    h('div', { class: 'sk sk-card', style: 'height:220px' }),
  );
}

/** Show a skeleton unless the page already has content (live refreshes stay quiet). */
export function loading(main, kind) {
  if (!main.dataset.loaded) mount(main, skeleton(kind));
}

export const initials = (name = '') => name.trim().split(/\s+/).slice(0, 2).map((x) => x[0] || '').join('').toUpperCase() || '?';

const AV = ['#7C1874', '#0F766E', '#0369A1', '#A14D06', '#6D4FC7', '#B93A26', '#3E5C7E', '#4D7C0F'];
export function avatarColor(key = '') {
  let n = 0;
  for (const c of String(key)) n = (n * 31 + c.charCodeAt(0)) >>> 0;
  return AV[n % AV.length];
}
export function avatar(name, key, cls = '') {
  return h('span', { class: `av ${cls}`, style: `--av:${avatarColor(key || name)}`, 'aria-hidden': 'true' }, initials(name));
}

/** Count a number up from 0 (short and subtle; instant with reduced motion). */
export function countUp(el, to, ms = 650) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches || !to) { el.textContent = String(to); return; }
  const t0 = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - t0) / ms);
    el.textContent = String(Math.round(to * (1 - Math.pow(1 - k, 3))));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** Hover tooltips for elements with data-tip (plain text, never HTML). */
let tipEl;
export function enableTips(root) {
  if (!tipEl) {
    tipEl = h('div', { class: 'ttip', role: 'tooltip' });
    document.body.append(tipEl);
  }
  root.addEventListener('mousemove', (e) => {
    const t = e.target.closest('[data-tip]');
    if (!t) { tipEl.classList.remove('show'); return; }
    tipEl.textContent = t.dataset.tip;
    tipEl.classList.add('show');
    tipEl.style.left = `${Math.min(e.clientX + 14, innerWidth - 290)}px`;
    tipEl.style.top = `${e.clientY + 16}px`;
  });
  root.addEventListener('mouseleave', () => tipEl.classList.remove('show'));
}
