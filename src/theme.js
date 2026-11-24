// Light / dark theme, remembered per device (falls back to the device setting).
const KEY = 'theme';
const listeners = new Set();

function stored() {
  try { return localStorage.getItem(KEY); } catch { return null; }
}

export function currentTheme() {
  return document.documentElement.dataset.theme || 'light';
}

export function initTheme() {
  const t = stored() || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.dataset.theme = t;
}

export function toggleTheme() {
  const t = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem(KEY, t); } catch { /* private mode: not remembered */ }
  listeners.forEach((fn) => fn(t));
}

export const onThemeChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Read a CSS colour token (e.g. "--brand") for charts. */
export const token = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
