import { h } from '../core/dom.js';
import { emptyState, linkButton } from '../ui/components.js';

export default async function render() {
  return h('div', { class: 'lm-page lm-container' }, h('h1', { class: 'visually-hidden' }, 'Page not found'), emptyState({
    title: 'This path leads nowhere',
    message: 'The page you were looking for is not in the garden. It may have moved, or the link may be mistyped.',
    actions: [linkButton('Return home', '#/', { variant: 'primary', icon: 'home' }), linkButton('Search Lumina', '#/search', { variant: 'ghost', icon: 'search' })],
  }));
}
