// Site footer with legal, creator and help links, plus open-content attribution.
import { h } from '../core/dom.js';
import { session } from '../core/session.js';
import { logoMark } from './icons.js';

export function mountFooter(root) {
  root.className = 'lm-footer';
  const col = (title, links) => h('div', null, h('h2', null, title), h('ul', { role: 'list' }, ...links.map(([label, href]) => h('li', null, h('a', { href }, label)))));
  root.replaceChildren(h('div', { class: 'lm-container' },
    h('div', { class: 'lm-footer__grid' },
      h('div', { class: 'lm-footer__brand' },
        h('a', { class: 'lm-logo', href: '#/', 'aria-label': 'Lumina home' }, logoMark(), h('span', { class: 'lm-logo__word', 'aria-hidden': 'true' }, 'LUMINA')),
        h('p', null, 'A streaming garden for film and television.')),
      col('Browse', [['Discover', '#/discover'], ['Movies', '#/movies'], ['TV Shows', '#/tv'], ['Genres', '#/genres'], ['New Releases', '#/new'], ['Velvia Suggestions', '#/velvia']]),
      col('Your Lumina', [['My List', '#/my-list'], ['Viewing history', '#/my-list/history'], ['Settings', '#/settings'], ['Viewing statistics', '#/stats']]),
      col('Creators', [['Submit your work', '#/creators'], ['Creator dashboard', '#/creators/dashboard'], ['Submission agreement', '#/legal/creator-agreement']]),
      col('Legal & help', [['Terms of Service', '#/legal/terms'], ['Privacy Policy', '#/legal/privacy'], ['Cookie Policy', '#/legal/cookies'], ['Copyright & Takedown', '#/legal/copyright'], ['Community Guidelines', '#/legal/community'], ['Accessibility', '#/legal/accessibility'], ['Contact & Support', '#/legal/contact']])),
    h('div', { class: 'lm-footer__legal' },
      h('span', null, `© ${new Date().getFullYear()} Lumina. Legal pages are drafts pending review.`),
      h('span', null, 'Open films courtesy of the Blender Foundation under Creative Commons licences — see each title for attribution.'),
      h('span', { 'data-mode-note': '' }, session.isServer ? '' : 'Preview mode: running on static hosting.'))));
  return root;
}
