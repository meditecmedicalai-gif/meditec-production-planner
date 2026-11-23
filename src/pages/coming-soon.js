import { h, mount } from '../ui.js';

export const renderComingSoon = (title, phase) => (main) => {
  mount(main,
    h('h1', { class: 'page-title' }, title),
    h('div', { class: 'card empty' },
      h('p', {}, `This section arrives in Phase ${phase}.`),
    ),
  );
};
