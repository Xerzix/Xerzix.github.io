// Personal collections: named, ordered lists of titles owned by one profile. Private by
// default; "unlisted" collections get a random share token that makes a read-only copy
// available at /api/shared/collections/:token. Every owner query is scoped in SQL by the
// profile id the route took from the session (never from the client).
import { now } from '../db/index.js';
import { newId, randomToken } from '../lib/crypto.js';
import { conflict, notFound } from '../lib/errors.js';

export const COLLECTION_LIMITS = { perProfile: 200, itemsPerCollection: 500, previews: 4 };

export class CollectionService {
  constructor(db, catalog, { publicUrl = '' } = {}) {
    this.db = db;
    this.catalog = catalog;
    this.publicUrl = publicUrl.replace(/\/$/, '');
  }

  /** Summaries the given profile may see (parental limits applied), keyed by id. */
  visible(profile) {
    return new Map(this.catalog.published(profile).map((t) => [t.id, t]));
  }

  shareUrl(token) {
    return token ? `${this.publicUrl}/#/shared/${token}` : null;
  }

  dto(row, items, visible) {
    const titles = items.filter((i) => visible.has(i.title_id));
    const out = {
      id: row.id,
      name: row.name,
      description: row.description,
      visibility: row.visibility,
      itemCount: titles.length,
      previews: titles.slice(0, COLLECTION_LIMITS.previews).map((i) => visible.get(i.title_id)),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    if (row.visibility === 'unlisted' && row.share_token) {
      out.shareToken = row.share_token;
      out.shareUrl = this.shareUrl(row.share_token);
    }
    return out;
  }

  itemRows(collectionId) {
    return this.db.all('SELECT * FROM collection_items WHERE collection_id = ? ORDER BY position, added_at', collectionId);
  }

  withItems(row, visible) {
    const items = this.itemRows(row.id);
    return {
      ...this.dto(row, items, visible),
      items: items.filter((i) => visible.has(i.title_id)).map((i) => ({
        titleId: i.title_id,
        addedAt: i.added_at,
        position: i.position,
        note: i.note || null,
        title: visible.get(i.title_id),
      })),
    };
  }

  /** The owner's row, or 404 — also for collections that belong to someone else. */
  own(profileId, id) {
    const row = this.db.get('SELECT * FROM collections WHERE id = ? AND profile_id = ?', String(id), profileId);
    if (!row) throw notFound('That collection does not exist.');
    return row;
  }

  list(profile) {
    const rows = this.db.all('SELECT * FROM collections WHERE profile_id = ? ORDER BY updated_at DESC, created_at DESC', profile.id);
    if (!rows.length) return [];
    const visible = this.visible(profile);
    const items = this.db.all(
      `SELECT ci.collection_id, ci.title_id, ci.position, ci.added_at FROM collection_items ci
         JOIN collections c ON c.id = ci.collection_id
        WHERE c.profile_id = ? ORDER BY ci.position, ci.added_at`,
      profile.id,
    );
    const byCollection = new Map();
    for (const i of items) {
      if (!byCollection.has(i.collection_id)) byCollection.set(i.collection_id, []);
      byCollection.get(i.collection_id).push(i);
    }
    return rows.map((r) => this.dto(r, byCollection.get(r.id) || [], visible));
  }

  get(profile, id) {
    return this.withItems(this.own(profile.id, id), this.visible(profile));
  }

  create(profile, { name, description = '', visibility = 'private' }) {
    const count = this.db.get('SELECT COUNT(*) AS n FROM collections WHERE profile_id = ?', profile.id).n;
    if (count >= COLLECTION_LIMITS.perProfile) {
      throw conflict(`A profile can keep up to ${COLLECTION_LIMITS.perProfile} collections.`, 'COLLECTION_LIMIT', { max: COLLECTION_LIMITS.perProfile });
    }
    const id = newId('col');
    const ts = now();
    this.db.run(
      'INSERT INTO collections (id, profile_id, name, description, visibility, share_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id, profile.id, name, description || '', visibility, visibility === 'unlisted' ? randomToken(18) : null, ts, ts,
    );
    return this.get(profile, id);
  }

  /** Applies a partial update. Returns { collection, visibilityChanged }. */
  update(profile, id, patch) {
    const row = this.own(profile.id, id);
    const next = {
      name: patch.name ?? row.name,
      description: patch.description === undefined ? row.description : (patch.description ?? ''),
      visibility: patch.visibility ?? row.visibility,
    };
    // Going private revokes the link; sharing again issues a fresh one.
    let token = row.share_token;
    if (next.visibility === 'private') token = null;
    else if (!token) token = randomToken(18);
    this.db.run(
      'UPDATE collections SET name = ?, description = ?, visibility = ?, share_token = ?, updated_at = ? WHERE id = ? AND profile_id = ?',
      next.name, next.description, next.visibility, token, now(), row.id, profile.id,
    );
    return { collection: this.get(profile, row.id), visibilityChanged: next.visibility !== row.visibility, previous: row.visibility };
  }

  remove(profile, id) {
    const r = this.db.run('DELETE FROM collections WHERE id = ? AND profile_id = ?', String(id), profile.id);
    if (!r.changes) throw notFound('That collection does not exist.');
  }

  addItem(profile, id, titleId, { note } = {}) {
    const row = this.own(profile.id, id);
    const ts = now();
    this.db.tx(() => {
      const exists = this.db.get('SELECT 1 FROM collection_items WHERE collection_id = ? AND title_id = ?', row.id, titleId);
      if (exists) {
        if (note !== undefined) this.db.run('UPDATE collection_items SET note = ? WHERE collection_id = ? AND title_id = ?', note, row.id, titleId);
      } else {
        const { n, maxPos } = this.db.get('SELECT COUNT(*) AS n, MAX(position) AS maxPos FROM collection_items WHERE collection_id = ?', row.id);
        if (n >= COLLECTION_LIMITS.itemsPerCollection) {
          throw conflict(`A collection can hold up to ${COLLECTION_LIMITS.itemsPerCollection} titles.`, 'COLLECTION_FULL', { max: COLLECTION_LIMITS.itemsPerCollection });
        }
        this.db.run(
          'INSERT INTO collection_items (collection_id, title_id, position, note, added_at) VALUES (?, ?, ?, ?, ?)',
          row.id, titleId, (maxPos ?? -1) + 1, note ?? null, ts,
        );
      }
      this.db.run('UPDATE collections SET updated_at = ? WHERE id = ?', ts, row.id);
    });
  }

  removeItem(profile, id, titleId) {
    const row = this.own(profile.id, id);
    this.db.tx(() => {
      const r = this.db.run('DELETE FROM collection_items WHERE collection_id = ? AND title_id = ?', row.id, titleId);
      if (r.changes) this.db.run('UPDATE collections SET updated_at = ? WHERE id = ?', now(), row.id);
    });
  }

  /**
   * Public, read-only view of an unlisted collection. The owner appears only as their
   * profile name; ids, tokens and account details are never included. Titles outside the
   * viewer's own parental limits are left out.
   */
  shared(token, viewerProfile = null) {
    const row = this.db.get(
      `SELECT c.*, p.name AS owner_name FROM collections c
         JOIN profiles p ON p.id = c.profile_id
         JOIN accounts a ON a.id = p.account_id
        WHERE c.share_token = ? AND c.visibility = 'unlisted' AND a.status = 'active'`,
      String(token),
    );
    if (!row) throw notFound('This shared collection is not available. The link may have been turned off.');
    const visible = this.visible(viewerProfile);
    const items = this.itemRows(row.id).filter((i) => visible.has(i.title_id));
    return {
      name: row.name,
      description: row.description,
      owner: { name: row.owner_name },
      itemCount: items.length,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      items: items.map((i) => ({ titleId: i.title_id, addedAt: i.added_at, position: i.position, note: i.note || null, title: visible.get(i.title_id) })),
    };
  }
}
