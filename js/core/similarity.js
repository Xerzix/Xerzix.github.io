// Content similarity used for "More like this", "Because you watched" and Velvia.
import { normalize } from './text.js';

const set = (arr) => new Set((arr || []).map(normalize));

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

export function similarityScore(a, b) {
  if (a.id === b.id) return -1;
  let s = 0;
  s += 3 * jaccard(set(a.genres), set(b.genres));
  s += 2 * jaccard(set(a.moods), set(b.moods));
  s += 1 * jaccard(set(a.keywords), set(b.keywords));
  s += 0.75 * jaccard(set((a.tags || []).filter((t) => t !== 'featured')), set((b.tags || []).filter((t) => t !== 'featured')));
  const dirs = set(a.directors);
  if ((b.directors || []).some((d) => dirs.has(normalize(d)))) s += 1.5;
  const cast = set(a.cast);
  if ((b.cast || []).some((c) => cast.has(normalize(c)))) s += 0.5;
  if (a.type === b.type) s += 0.25;
  if (a.year && b.year) s += Math.max(0, 0.3 - Math.abs(a.year - b.year) * 0.03);
  return s;
}

/** Most similar titles to `target` from `pool`, highest first. */
export function similarTitles(target, pool, limit = 12) {
  return pool
    .map((t) => ({ t, s: similarityScore(target, t) }))
    .filter((x) => x.s > 0.2)
    .sort((a, b) => b.s - a.s || (a.t.editorialRank ?? 1000) - (b.t.editorialRank ?? 1000))
    .slice(0, limit)
    .map((x) => x.t);
}

/**
 * Builds a taste vector (weights per genre/mood/keyword) from weighted seed titles.
 * seeds: [{ title, weight }] — e.g. watched = 1, completed = 1.5, in list = 0.8, rated n = (n-3)
 */
export function tasteProfile(seeds) {
  const w = new Map();
  const add = (key, v) => w.set(key, (w.get(key) || 0) + v);
  for (const { title, weight } of seeds) {
    for (const g of title.genres || []) add(`g:${normalize(g)}`, 3 * weight);
    for (const m of title.moods || []) add(`m:${normalize(m)}`, 2 * weight);
    for (const k of title.keywords || []) add(`k:${normalize(k)}`, weight);
    for (const d of title.directors || []) add(`d:${normalize(d)}`, 1.5 * weight);
  }
  return w;
}

export function tasteScore(profile, t) {
  let s = 0;
  for (const g of t.genres || []) s += profile.get(`g:${normalize(g)}`) || 0;
  for (const m of t.moods || []) s += profile.get(`m:${normalize(m)}`) || 0;
  for (const k of t.keywords || []) s += profile.get(`k:${normalize(k)}`) || 0;
  for (const d of t.directors || []) s += profile.get(`d:${normalize(d)}`) || 0;
  return s;
}
