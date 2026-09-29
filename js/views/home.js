// Home — the Lumina Gardens: cinematic featured banner and the collection rows.
import { h } from '../core/dom.js';
import { api } from '../api/client.js';
import { session } from '../core/session.js';
import { bus } from '../core/bus.js';
import { hero } from '../ui/hero.js';
import { carousel } from '../ui/carousel.js';
import { emptyState, errorState, linkButton } from '../ui/components.js';

export default async function render(ctx) {
  ctx.setTitle('Home');
  const home = await api.catalog.home();
  const hiddenRows = new Set(session.profile?.preferences?.home?.hiddenRows || []);
  const appearance = session.profile?.preferences?.appearance || {};

  const page = h('div', { class: 'lm-home' }, h('h1', { class: 'visually-hidden' }, 'Lumina home'));
  if (!home.featured.length && !home.rows.length) {
    page.append(h('div', { class: 'lm-page lm-container' }, emptyState({
      title: 'The garden is being planted',
      message: 'No titles have been published yet. Administrators can add licensed titles from the admin dashboard.',
      actions: [linkButton('Learn about submitting work', '#/creators', { variant: 'primary' })],
    })));
    return page;
  }

  const banner = hero(home.featured, { autoRotate: appearance.heroAutoRotate !== false });
  ctx.onDestroy(() => banner.destroy?.());
  page.append(banner);

  const rows = h('div', { class: 'lm-home__rows' });
  for (const row of home.rows) {
    if (hiddenRows.has(row.id)) continue;
    rows.append(carousel({ ...row, variant: row.variant || 'poster' }));
  }
  page.append(rows);

  // Keep Continue Watching and progress bars fresh when the library changes elsewhere.
  let refreshing = false;
  const off = bus.on('library:refresh-home', async () => {
    if (refreshing) return;
    refreshing = true;
    try {
      const next = await api.catalog.home();
      const fresh = h('div', { class: 'lm-home__rows' }, ...next.rows.filter((r) => !hiddenRows.has(r.id)).map((r) => carousel({ ...r, variant: r.variant || 'poster' })));
      rows.replaceWith(fresh);
    } catch (err) {
      rows.replaceWith(errorState(err));
    } finally {
      refreshing = false;
    }
  });
  ctx.onDestroy(off);
  return page;
}
