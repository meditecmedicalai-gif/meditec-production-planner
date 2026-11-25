import { h, mount } from '../ui.js';
import { signIn } from '../auth.js';
import { toggleTheme } from '../theme.js';

const LOGO = 'brand/logo.png';

export function renderLogin(app) {
  const email = h('input', { type: 'email', id: 'email', autocomplete: 'username', required: true });
  const password = h('input', { type: 'password', id: 'password', autocomplete: 'current-password', required: true });
  const error = h('p', { class: 'form-error', role: 'alert' });
  const submit = h('button', { type: 'submit', class: 'btn btn-primary btn-block' }, 'Sign in');

  const form = h('form', {
    class: 'stack',
    onsubmit: async (e) => {
      e.preventDefault();
      error.textContent = '';
      submit.disabled = true;
      submit.textContent = 'Signing in…';
      const { error: err } = await signIn(email.value, password.value);
      if (err) {
        error.textContent = /invalid login/i.test(err.message) ? 'Incorrect e-mail or password.' : err.message;
        submit.disabled = false;
        submit.textContent = 'Sign in';
      }
      // On success the auth listener in main.js re-renders the app.
    },
  },
    h('div', { class: 'field' }, h('label', { for: 'email' }, 'E-mail'), email),
    h('div', { class: 'field' }, h('label', { for: 'password' }, 'Password'), password),
    error,
    submit,
  );

  // The logo is a drop-in file; if it is missing the text wordmark shows.
  const artLogo = h('img', { class: 'login-logo-on-art', src: LOGO, alt: 'Meditec — Enhancing patient care' });
  const wordmark = h('div', { class: 'wordmark-on-art', hidden: true }, 'Meditec');
  const tagline = h('div', { class: 'tagline', hidden: true }, 'Enhancing patient care');
  artLogo.addEventListener('error', () => { artLogo.remove(); wordmark.hidden = false; tagline.hidden = false; });
  const cardLogo = h('img', { class: 'login-logo', src: LOGO, alt: 'Meditec' });
  cardLogo.addEventListener('error', () => cardLogo.remove());

  mount(app, h('main', { class: 'login' },
    h('section', { class: 'login-art', 'aria-hidden': 'true' },
      h('div', {}, artLogo, wordmark),
      h('div', {},
        h('h2', {}, 'Meditec Production Room Planning'),
        h('p', {}, 'Who’s building what, what’s needed, and what’s running overnight — in one place.'),
      ),
      tagline,
    ),
    h('section', { class: 'login-side', style: 'position:relative' },
      h('button', { class: 'theme-toggle', 'aria-label': 'Switch light / dark mode', title: 'Light / dark', onclick: toggleTheme }),
      h('div', { class: 'login-card' },
        cardLogo,
        h('h1', {}, 'Welcome back'),
        h('p', { class: 'lead' }, 'Sign in to Meditec Production Room Planning.'),
        form,
        h('p', { class: 'foot' }, 'Accounts are created by the administrator. Forgotten your password? Ask the administrator to reset it.'),
        h('p', { class: 'credit' }, 'Built by Prince Tony'),
      ),
    ),
  ));
  email.focus();
}
