import { h, mount } from '../ui.js';
import { signIn } from '../auth.js';

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
        error.textContent = /invalid login/i.test(err.message)
          ? 'Incorrect e-mail or password.'
          : err.message;
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

  mount(app, h('main', { class: 'center-page' },
    h('div', { class: 'card narrow login-card' },
      h('div', { class: 'login-brand' },
        h('span', { class: 'brand-mark', 'aria-hidden': 'true' }),
        h('div', {},
          h('h1', {}, 'Pump Room Planner'),
          h('p', { class: 'muted' }, 'Meditec Medical Ltd'),
        ),
      ),
      form,
      h('p', { class: 'muted small' }, 'Accounts are created by the administrator. Forgotten your password? Ask the administrator to reset it.'),
    ),
  ));
  email.focus();
}
