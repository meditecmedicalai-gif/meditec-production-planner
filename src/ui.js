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
  setTimeout(() => t.classList.add('toast-hide'), 3500);
  setTimeout(() => t.remove(), 4000);
}

/** Show a friendly message for a Supabase error and return true if there was one. */
export function reportError(error, context = 'Something went wrong') {
  if (!error) return false;
  console.error(context, error);
  const msg = error.code === '42501' || /row-level security/i.test(error.message || '')
    ? 'You do not have permission to do that.'
    : error.message || String(error);
  toast(`${context}: ${msg}`, 'error');
  return true;
}

// ---------------------------------------------------------------- modal
/**
 * Opens a modal dialog. `body` is a node; `actions` is an array of
 * { label, variant, onClick } — onClick may return false to keep it open.
 */
export function openModal({ title, body, actions = [] }) {
  const dialog = h('dialog', { class: 'modal' });
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
