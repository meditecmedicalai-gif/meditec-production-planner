import { h, mount, toast } from '../ui.js';
import { auth, changePassword } from '../auth.js';

export function renderAccount(main) {
  const pw1 = h('input', { type: 'password', id: 'pw1', autocomplete: 'new-password', minlength: '8', required: true });
  const pw2 = h('input', { type: 'password', id: 'pw2', autocomplete: 'new-password', minlength: '8', required: true });
  const error = h('p', { class: 'form-error', role: 'alert' });

  const form = h('form', {
    class: 'stack',
    onsubmit: async (e) => {
      e.preventDefault();
      error.textContent = '';
      if (pw1.value.length < 8) { error.textContent = 'Use at least 8 characters.'; return; }
      if (pw1.value !== pw2.value) { error.textContent = 'The passwords do not match.'; return; }
      const { error: err } = await changePassword(pw1.value);
      if (err) { error.textContent = err.message; return; }
      form.reset();
      toast('Password changed.', 'success');
    },
  },
    h('div', { class: 'field' }, h('label', { for: 'pw1' }, 'New password'), pw1),
    h('div', { class: 'field' }, h('label', { for: 'pw2' }, 'Repeat new password'), pw2),
    error,
    h('div', {}, h('button', { type: 'submit', class: 'btn btn-primary' }, 'Change password')),
  );

  const p = auth.profile;
  mount(main,
    h('h1', { class: 'page-title' }, 'My account'),
    h('div', { class: 'grid-2' },
      h('section', { class: 'card' },
        h('h2', {}, 'Details'),
        h('dl', { class: 'details' },
          h('dt', {}, 'Name'), h('dd', {}, p.full_name || '—'),
          h('dt', {}, 'E-mail'), h('dd', {}, p.email),
          h('dt', {}, 'Role'), h('dd', {}, h('span', { class: `role-badge role-${p.app_role}` }, p.app_role)),
          h('dt', {}, 'Permissions'), h('dd', {},
            auth.isAdmin
              ? 'Full access: schedule, people, demand notes, settings and change history.'
              : 'View everything; create demand notes and edit your own notes (including marking them done).'),
        ),
      ),
      h('section', { class: 'card' }, h('h2', {}, 'Change password'), form),
    ),
  );
}
