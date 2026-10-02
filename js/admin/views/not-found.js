import { emptyState, linkButton } from '../../ui/components.js';
import { page } from '../ui.js';

export default async function render() {
  return page({ title: 'Not found' }, emptyState({
    title: 'No such page in the dashboard',
    message: 'The address may be mistyped, or the item may have been deleted.',
    actions: [linkButton('Back to overview', '#/', { variant: 'primary', icon: 'home' })],
  }));
}

/** Shown instead of admin-only sections when a moderator opens them. No data is requested. */
export function adminOnlyNotice(title) {
  return page({ title: title || 'Administrators only' }, emptyState({
    title: 'Administrators only',
    message: 'This section is limited to administrators. Moderators can manage content, moderation, creators, submissions, users (members only) and announcements.',
    actions: [linkButton('Back to overview', '#/', { variant: 'ghost', icon: 'home' })],
  }));
}
