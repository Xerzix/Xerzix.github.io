// Discover: personalised sections (server) or the catalog's editorial rows (Preview mode).
import { h, prefersReducedMotion } from '../core/dom.js';
import { api } from '../api/client.js';
import { session } from '../core/session.js';
import { carousel } from '../ui/carousel.js';
import { emptyState, linkButton } from '../ui/components.js';
import { icon } from '../ui/icons.js';
import { creatorFollowButton, followedIds } from '../ui/follow-button.js';

export default async function render(ctx) {
  ctx.setTitle('Discover');
  const { sections = [] } = await api.discover.get();
  const usable = sections.filter((s) => s.items?.length);
  const personal = usable.some((s) => s.id === 'new-for-you' || String(s.id).startsWith('because'));

  const head = h('header', { class: 'lm-page-header lm-disc-head' },
    h('div', null,
      h('p', { class: 'lm-eyebrow' }, 'Discover'),
      h('h1', { class: 'lm-h1' }, personal && session.profile ? `Discover, ${session.profile.name}` : 'Discover something new'),
      h('p', { class: 'lm-disc-head__sub' }, personal
        ? 'Picks shaped by what this profile watches and saves, alongside themed nights from the catalog.'
        : 'Themed nights, fresh releases and what is popular on Lumina. Watch a few titles and this page adapts to you.')),
    h('div', { class: 'lm-cluster' }, linkButton('Ask Velvia', '#/velvia', { variant: 'glass', size: 'sm', icon: 'sparkle' })));

  const page = h('div', { class: 'lm-disc lm-discover' }, h('div', { class: 'lm-page lm-container lm-discover__top' }, head));

  if (!usable.length) {
    page.firstChild.append(emptyState({
      title: 'Nothing to discover yet',
      message: 'Once titles are published they will be arranged into themed collections here.',
      actions: [linkButton('Browse genres', '#/genres', { variant: 'primary', icon: 'grid' })],
    }));
    return page;
  }

  // Quick jumps to each section (buttons, so the hash route is never disturbed).
  const rows = usable.map((s) => carousel({ id: s.id, title: s.title, subtitle: s.description || s.subtitle, href: s.href, items: s.items }));
  // Creator spotlight: follow the creators named in the row to hear about their next release.
  const spotlight = usable.findIndex((s) => s.id === 'creator-spotlight' && s.creators?.length);
  if (spotlight >= 0) {
    const followed = await followedIds('creator');
    const buttons = usable[spotlight].creators.map((c) => creatorFollowButton(c, followed)).filter(Boolean);
    if (buttons.length) {
      rows[spotlight].append(h('div', { class: 'lm-discover__follow' },
        h('p', { class: 'lm-small lm-muted' }, 'Follow a creator to be notified when Lumina publishes their next release.'),
        h('div', { class: 'lm-cluster' }, ...buttons)));
    }
  }
  if (usable.length > 3) {
    head.after(h('nav', { class: 'lm-chip-scroll lm-discover__jump', 'aria-label': 'Jump to a section' },
      ...usable.map((s, i) => h('button', {
        type: 'button',
        class: 'lm-chip',
        onClick: () => {
          rows[i].scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
          rows[i].querySelector('h2')?.setAttribute('tabindex', '-1');
          rows[i].querySelector('h2')?.focus({ preventScroll: true });
        },
      }, s.id === 'new-for-you' || String(s.id).startsWith('because') ? icon('sparkle') : null, s.title))));
  }
  page.append(h('div', { class: 'lm-discover__rows' }, ...rows));
  return page;
}
