// Client session state: mode (server | static), signed-in account, active profile,
// feature flags and a cached view of the profile's library for card badges.
import { api } from '../api/client.js';
import { bus } from './bus.js';

export const session = {
  mode: 'static',
  account: null,
  profile: null,
  profileCount: 0,
  elevated: false,
  features: {},
  limits: { maxProfiles: 5 },
  plan: null,
  get isServer() {
    return this.mode === 'server';
  },
  get isSignedIn() {
    return !!this.account;
  },
  get hasProfile() {
    return !!this.profile;
  },
  get isStaff() {
    return this.account?.role === 'admin' || this.account?.role === 'moderator';
  },
};

export async function refreshSession() {
  const s = await api.session.get();
  Object.assign(session, {
    mode: s.mode,
    account: s.account,
    profile: s.profile,
    profileCount: s.profileCount,
    elevated: s.elevated,
    features: s.features || {},
    limits: s.limits || session.limits,
    plan: s.plan,
  });
  bus.emit('session:changed', session);
  await refreshLibrary();
  return session;
}

/** Replaces the active profile locally (after select/update) and notifies listeners. */
export function setProfile(profile) {
  session.profile = profile;
  bus.emit('session:changed', session);
  refreshLibrary();
}

// ── Library cache (My List ids and progress) used by cards everywhere ──
export const library = {
  listIds: new Set(),
  progress: {},
  ratings: {},
  ready: false,
  inList(id) {
    return this.listIds.has(id);
  },
  progressFor(id) {
    return this.progress[id] || null;
  },
};

export async function refreshLibrary() {
  if (!session.profile) {
    library.listIds = new Set();
    library.progress = {};
    library.ratings = {};
    library.ready = true;
    bus.emit('library:changed', {});
    return;
  }
  try {
    const s = await api.library.summary();
    library.listIds = new Set(s.watchlistIds);
    library.progress = s.progress || {};
    library.ratings = s.ratings || {};
  } catch {
    /* keep the previous cache */
  }
  library.ready = true;
  bus.emit('library:changed', {});
}

/** Adds or removes a title from My List. Returns the new state (true = in list). */
export async function toggleList(titleId) {
  const inList = library.listIds.has(titleId);
  if (inList) {
    library.listIds.delete(titleId);
    bus.emit('library:changed', { titleId });
    try {
      await api.library.removeFromList(titleId);
    } catch (err) {
      library.listIds.add(titleId);
      bus.emit('library:changed', { titleId });
      throw err;
    }
    return false;
  }
  library.listIds.add(titleId);
  bus.emit('library:changed', { titleId });
  try {
    await api.library.addToList(titleId);
  } catch (err) {
    library.listIds.delete(titleId);
    bus.emit('library:changed', { titleId });
    throw err;
  }
  return true;
}
