// "Follow <creator>" toggles. Following a creator sends this profile a "creator release"
// notification when Lumina publishes new work from them (Settings → Notifications can turn
// those off). Server mode only: Preview mode has no creators or notifications.
import { h } from '../core/dom.js';
import { api } from '../api/client.js';
import { session } from '../core/session.js';
import { icon } from './icons.js';
import { button, toast, toastError } from './components.js';

/** The ids this profile follows for `type`, or null when follows are unavailable. */
export async function followedIds(type) {
  if (!session.isServer || !session.profile) return null;
  try {
    const { items } = await api.follows.list();
    return new Set(items.filter((f) => f.type === type).map((f) => f.id));
  } catch {
    return null;
  }
}

/**
 * A toggle button for one creator ({ id, name }). The label stays "Follow <name>" and
 * aria-pressed carries the state. Returns null when the viewer cannot follow this creator.
 */
export function creatorFollowButton(creator, followed, { variant = 'ghost', size = 'sm' } = {}) {
  if (!creator?.id || !creator.name || !followed) return null;
  if (session.account?.id === creator.id) return null; // creators are never notified about their own work
  let following = followed.has(creator.id);
  const label = `Follow ${creator.name}`;
  const hint = () => (following
    ? `You are following ${creator.name}. Select to stop release notifications.`
    : `Get notified when ${creator.name} releases new work on Lumina`);
  const b = button(label, { variant, size, icon: following ? 'check' : 'bell', className: 'lm-follow-creator', attrs: { 'aria-pressed': String(following), title: hint(), 'data-follow-creator': creator.id } });
  const paint = () => {
    b.replaceChildren(icon(following ? 'check' : 'bell'), h('span', null, label));
    b.setAttribute('aria-pressed', String(following));
    b.title = hint();
  };
  b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      if (following) await api.follows.unfollow('creator', creator.id);
      else await api.follows.follow('creator', creator.id);
      following = !following;
      if (following) followed.add(creator.id);
      else followed.delete(creator.id);
      paint();
      toast(following ? `You will be notified when ${creator.name} releases new work.` : `You unfollowed ${creator.name}.`, { type: 'success', timeout: 2800 });
    } catch (err) {
      toastError(err);
    } finally {
      b.disabled = false;
    }
  });
  return b;
}
