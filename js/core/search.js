// Catalog search shared by the server (/api/search) and Preview mode.
// Relevance tiers are ported from the original Lumina search (exact > prefix > whole word >
// contains > all words > partial words) and extended with people, genres, keywords and
// typo tolerance. Filters combine with AND; multiple values inside one filter combine with OR.
import { editDistance, escapeRegExp, normalize, tokens, typoBudget } from './text.js';
import { countryName, languageName } from './format.js';

const DAY = 86_400_000;

/** Precomputes normalized fields for a title summary. Cache the result per catalog version. */
export function indexTitle(t) {
  const people = [...(t.directors || []), ...(t.cast || [])];
  return {
    t,
    title: normalize(t.title),
    original: normalize(t.originalTitle || ''),
    titleTokens: tokens(`${t.title} ${t.originalTitle || ''}`),
    people: people.map((p) => ({ name: p, norm: normalize(p) })),
    genres: (t.genres || []).map(normalize),
    keywords: [...(t.keywords || []), ...(t.moods || []), ...(t.tags || [])].map(normalize),
    keywordTokens: [...new Set([...(t.keywords || []), ...(t.moods || []), ...(t.tags || []), ...(t.genres || [])].flatMap(tokens))],
    synopsis: normalize(`${t.tagline || ''} ${t.synopsis || ''}`),
    countries: (t.countries || []).map(normalize),
    language: normalize(t.originalLanguage || ''),
    // English display names, so "Netherlands", "Japan" or "English" find titles by origin.
    countryNames: (t.countries || []).map((c) => normalize(countryName(c))).filter((n) => n && n.length > 2),
    languageNames: [...new Set([t.originalLanguage, ...(t.audioLanguages || [])].filter(Boolean))]
      .map((l) => normalize(languageName(l))).filter((n) => n && n.length > 2),
  };
}

/** Whether `name` (a normalized display name) is the query or appears in it as whole words. */
const namesIn = (q, name) => name === q || new RegExp(`(?:^| )${escapeRegExp(name)}(?: |$)`).test(q);

export function buildIndex(titles) {
  return titles.map(indexTitle);
}

function scoreTitle(doc, q, words) {
  const { title, original } = doc;
  let score = 0;
  let matched = '';
  for (const candidate of [title, original]) {
    if (!candidate) continue;
    let s = 0;
    if (candidate === q) s = 10000;
    else if (candidate.startsWith(q)) s = 9000;
    else if (new RegExp(`\\b${escapeRegExp(q)}\\b`).test(candidate)) s = 8000;
    else if (candidate.includes(q)) s = 7000;
    else if (words.length > 1) {
      const found = words.filter((w) => candidate.includes(w)).length;
      if (found === words.length) s = 6000;
      else if (found > 0) s = (found / words.length) * 4000;
    } else if (words.length === 1 && words[0].length > 2 && candidate.includes(words[0])) s = 5000;
    if (s > score) {
      score = s;
      matched = 'title';
    }
  }
  return { score, matched };
}

function fuzzyTitleScore(doc, words) {
  // Each query word may match a title token within its typo budget.
  let hits = 0;
  for (const w of words) {
    const budget = typoBudget(w.length);
    if (!budget) continue;
    if (doc.titleTokens.some((tok) => editDistance(w, tok, budget) <= budget || (tok.length > w.length && editDistance(w, tok.slice(0, w.length), budget) <= budget))) hits++;
  }
  return hits ? (hits / words.length) * 3500 : 0;
}

/** Whether `w` is within its typo budget of `tok` (or of the start of a longer `tok`). */
function nearMiss(w, tok) {
  const budget = typoBudget(w.length);
  if (!budget) return false;
  return editDistance(w, tok, budget) <= budget || (tok.length > w.length + 2 && editDistance(w, tok.slice(0, w.length), budget) <= budget);
}

function fuzzyKeywordScore(doc, words) {
  // Misspelled keywords, moods and genres ("dragn", "cinematografy").
  const hits = words.filter((w) => w.length > 3 && doc.keywordTokens.some((tok) => nearMiss(w, tok))).length;
  return hits ? (hits / words.length) * 3000 : 0;
}

function scoreDoc(doc, q, words) {
  let { score, matched } = scoreTitle(doc, q, words);
  const reasons = [];
  if (score) reasons.push('title');

  // People: actor or director names.
  for (const p of doc.people) {
    let s = 0;
    if (p.norm === q) s = 8500;
    else if (p.norm.includes(q)) s = 6500;
    else if (words.length > 1 && words.every((w) => p.norm.includes(w))) s = 6000;
    else if (words.some((w) => w.length > 3 && p.norm.split(' ').some((part) => editDistance(w, part, typoBudget(w.length)) <= typoBudget(w.length)))) s = 3000;
    if (s > score) {
      score = s;
      matched = 'person';
    }
    if (s) reasons.push(`person:${p.name}`);
  }

  if (doc.genres.some((g) => g === q || words.includes(g))) {
    score = Math.max(score, 4500);
    reasons.push('genre');
    matched ||= 'genre';
  }
  const kwHits = doc.keywords.filter((k) => k === q || k.includes(q) || words.some((w) => w.length > 3 && k.includes(w))).length;
  if (kwHits) {
    score = Math.max(score, 3000 + Math.min(kwHits, 5) * 200);
    reasons.push('keyword');
    matched ||= 'keyword';
  }
  if (doc.countries.some((c) => c === q) || doc.language === q
    || doc.countryNames.some((n) => namesIn(q, n)) || doc.languageNames.some((n) => namesIn(q, n))) {
    score = Math.max(score, 2500);
    reasons.push('origin');
    matched ||= 'origin';
  }

  if (!score) {
    const fz = Math.max(fuzzyTitleScore(doc, words), fuzzyKeywordScore(doc, words));
    if (fz >= 1000) {
      score = fz;
      matched = 'fuzzy';
      reasons.push('typo');
    }
  }

  // Year tokens ("2010", "sci-fi 2012") narrow results rather than match on their own.
  const year = words.find((w) => /^(19|20)\d{2}$/.test(w));
  if (year) {
    if (String(doc.t.year) === year) score = Math.max(score, 2000) + 1500;
    else if (words.length === 1) score = 0;
  }

  if (score > 0) {
    if (doc.synopsis.includes(q)) score += 500;
    for (const w of words) if (w.length > 2 && doc.synopsis.includes(w)) score += 100;
    score += Math.min((doc.t.memberRating?.count || 0) * 2, 50);
  } else {
    // Synopsis-only matches are weak but useful for descriptive queries ("samurai", "llama").
    const hits = words.filter((w) => w.length > 3 && doc.synopsis.includes(w)).length;
    if (hits && hits >= Math.ceil(words.length / 2)) {
      score = 1000 + hits * 150;
      matched = 'synopsis';
    }
  }
  return { score, matched, reasons };
}

export const SORTS = ['relevance', 'newest', 'oldest', 'title', 'rating', 'added', 'runtime'];

function applyFilters(t, f, now) {
  if (f.type && f.type !== 'all' && t.type !== f.type) return false;
  if (f.genres?.length && !f.genres.some((g) => (t.genres || []).map(normalize).includes(normalize(g)))) return false;
  if (f.tags?.length && !f.tags.some((g) => (t.tags || []).includes(g))) return false;
  if (f.yearFrom && !(t.year >= f.yearFrom)) return false;
  if (f.yearTo && !(t.year <= f.yearTo)) return false;
  if (f.runtimeMin && !(t.runtimeMin >= f.runtimeMin)) return false;
  if (f.runtimeMax && !(t.runtimeMin && t.runtimeMin <= f.runtimeMax)) return false;
  if (f.maxAge !== undefined && f.maxAge !== null && !(t.minAge <= f.maxAge)) return false;
  if (f.ageRatings?.length && !f.ageRatings.includes(t.ageRating)) return false;
  if (f.language && t.originalLanguage !== f.language && !(t.audioLanguages || []).includes(f.language)) return false;
  if (f.subtitles && !(t.subtitleLanguages || []).includes(f.subtitles)) return false;
  if (f.country && !(t.countries || []).includes(f.country)) return false;
  if (f.resolution && !((t.resolutions || [])[0] >= f.resolution)) return false;
  if (f.minRating && !((t.memberRating?.average || 0) >= f.minRating)) return false;
  if (f.recentDays && !(t.addedAt && now - Date.parse(t.addedAt) <= f.recentDays * DAY)) return false;
  return true;
}

function sorter(sort) {
  const byTitle = (a, b) => a.t.title.localeCompare(b.t.title);
  const date = (t) => Date.parse(t.releaseDate || `${t.year || 0}-01-01`) || 0;
  switch (sort) {
    case 'newest': return (a, b) => date(b.t) - date(a.t) || byTitle(a, b);
    case 'oldest': return (a, b) => date(a.t) - date(b.t) || byTitle(a, b);
    case 'title': return byTitle;
    case 'rating': return (a, b) => (b.t.memberRating?.average || 0) - (a.t.memberRating?.average || 0) || (b.t.memberRating?.count || 0) - (a.t.memberRating?.count || 0) || byTitle(a, b);
    case 'added': return (a, b) => (Date.parse(b.t.addedAt) || 0) - (Date.parse(a.t.addedAt) || 0) || byTitle(a, b);
    case 'runtime': return (a, b) => (a.t.runtimeMin || 0) - (b.t.runtimeMin || 0) || byTitle(a, b);
    default: return (a, b) => b.score - a.score || (a.t.editorialRank ?? 1000) - (b.t.editorialRank ?? 1000) || byTitle(a, b);
  }
}

function facetCounts(docs) {
  const count = (arr) => {
    const m = new Map();
    for (const v of arr) m.set(v, (m.get(v) || 0) + 1);
    return [...m.entries()].map(([value, n]) => ({ value, count: n })).sort((a, b) => b.count - a.count || String(a.value).localeCompare(String(b.value)));
  };
  return {
    type: count(docs.map((d) => d.t.type)),
    genres: count(docs.flatMap((d) => d.t.genres || [])),
    languages: count(docs.map((d) => d.t.originalLanguage).filter(Boolean)),
    countries: count(docs.flatMap((d) => d.t.countries || [])),
    subtitles: count(docs.flatMap((d) => d.t.subtitleLanguages || [])),
    decades: count(docs.map((d) => (d.t.year ? `${Math.floor(d.t.year / 10) * 10}s` : null)).filter(Boolean)),
    ageRatings: count(docs.map((d) => d.t.ageRating)),
    resolutions: count(docs.map((d) => (d.t.resolutions || [])[0]).filter(Boolean)),
  };
}

/**
 * Searches an index built with buildIndex().
 * @returns {{items, total, page, pageSize, facets, didYouMean, query}}
 */
export function search(index, params = {}) {
  const q = normalize(params.q || '');
  const words = q ? q.split(' ') : [];
  const now = params.now ?? Date.now();
  const filters = params.filters || {};
  let docs = index.filter((d) => applyFilters(d.t, filters, now));

  let scored;
  if (q) {
    scored = docs.map((d) => ({ ...d, ...scoreDoc(d, q, words) })).filter((d) => d.score >= 1000);
  } else {
    scored = docs.map((d) => ({ ...d, score: 0, matched: '' }));
  }
  const sort = params.sort && SORTS.includes(params.sort) ? params.sort : q ? 'relevance' : 'added';
  scored.sort(sorter(sort));

  let didYouMean = null;
  if (q && scored.length && scored.every((d) => d.matched === 'fuzzy')) {
    // Every result is a typo match: say which spelling was used ("dragn" → "dragon").
    didYouMean = correctQuery(index, words);
  }
  if (q && !scored.length) {
    let best = null;
    for (const d of index) {
      for (const cand of [d.title, ...d.people.map((p) => p.norm)]) {
        const dist = editDistance(q, cand, Math.max(2, Math.floor(q.length / 3)));
        if (dist <= Math.max(2, Math.floor(q.length / 3)) && (!best || dist < best.dist)) best = { dist, text: cand === d.title ? d.t.title : d.people.find((p) => p.norm === cand)?.name };
      }
    }
    didYouMean = best?.text || correctQuery(index, words);
  }

  const pageSize = Math.min(Math.max(Number(params.pageSize) || 24, 1), 100);
  const page = Math.max(Number(params.page) || 1, 1);
  const start = (page - 1) * pageSize;
  return {
    query: params.q || '',
    sort,
    total: scored.length,
    page,
    pageSize,
    items: scored.slice(start, start + pageSize).map((d) => ({ ...d.t, match: d.matched || undefined })),
    facets: facetCounts(scored),
    didYouMean,
  };
}

const vocabCache = new WeakMap();
/** Every title, people, keyword, mood and genre word in the index, for spelling corrections. */
function vocabulary(index) {
  let vocab = vocabCache.get(index);
  if (!vocab) {
    vocab = new Set();
    for (const d of index) {
      for (const tok of [...d.titleTokens, ...d.keywordTokens, ...d.people.flatMap((p) => p.norm.split(' '))]) if (tok.length > 2) vocab.add(tok);
    }
    vocabCache.set(index, vocab);
  }
  return vocab;
}

/** The query with each unknown word replaced by its closest catalog word, or null if nothing changed. */
function correctQuery(index, words) {
  const vocab = vocabulary(index);
  let changed = false;
  const out = words.map((w) => {
    if (vocab.has(w) || !typoBudget(w.length)) return w;
    let best = null;
    for (const tok of vocab) {
      const dist = editDistance(w, tok, typoBudget(w.length));
      if (dist <= typoBudget(w.length) && (!best || dist < best.dist || (dist === best.dist && tok < best.tok))) best = { dist, tok };
    }
    if (!best) return w;
    changed = true;
    return best.tok;
  });
  if (!changed) return null;
  const fixed = out.join(' ');
  // Show a whole title or name as it is written ("Sintel", not "sintel").
  for (const d of index) {
    if (d.title === fixed) return d.t.title;
    const person = d.people.find((p) => p.norm === fixed);
    if (person) return person.name;
  }
  return fixed;
}

/** Instant suggestions: titles, people and genres. */
export function suggest(index, rawQ, limit = 8) {
  const q = normalize(rawQ);
  if (!q) return [];
  const words = q.split(' ');
  const titles = index
    .map((d) => ({ d, ...scoreDoc(d, q, words) }))
    .filter((x) => x.score >= 1000 && (x.matched === 'title' || x.matched === 'fuzzy'))
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map(({ d }) => ({ kind: 'title', id: d.t.id, label: d.t.title, sub: [d.t.year, d.t.type === 'series' ? 'Series' : 'Film'].filter(Boolean).join(' · '), poster: d.t.poster }));

  const people = new Map();
  for (const d of index) {
    for (const p of d.people) {
      if (p.norm.includes(q) || p.norm.split(' ').some((part) => part.startsWith(q))) {
        const role = (d.t.directors || []).includes(p.name) ? 'Director' : 'Cast';
        if (!people.has(p.name)) people.set(p.name, { kind: 'person', label: p.name, sub: role });
      }
    }
  }
  const genres = new Map();
  for (const d of index) for (const g of d.t.genres || []) if (normalize(g).startsWith(q)) genres.set(g, { kind: 'genre', label: g, sub: 'Genre' });

  return [...titles, ...[...people.values()].slice(0, 3), ...[...genres.values()].slice(0, 2)].slice(0, limit);
}

// ── URL query <-> filter object (shared by the search page, the server and Preview mode) ──
const LIST_KEYS = ['genres', 'tags', 'ageRatings'];
const INT_KEYS = ['yearFrom', 'yearTo', 'runtimeMin', 'runtimeMax', 'resolution'];

/** Converts flat query-string params into { q, sort, page, pageSize, filters }. */
export function parseSearchParams(params = {}) {
  const get = (k) => (params instanceof URLSearchParams ? params.get(k) : params[k]);
  const filters = {};
  const type = get('type');
  if (type === 'movie' || type === 'series') filters.type = type;
  for (const k of LIST_KEYS) {
    const val = get(k);
    if (val) filters[k] = String(val).split(',').map((s) => s.trim()).filter(Boolean).slice(0, 20);
  }
  for (const k of INT_KEYS) {
    const n = parseInt(get(k), 10);
    if (Number.isFinite(n) && n >= 0) filters[k] = n;
  }
  const minRating = parseFloat(get('minRating'));
  if (Number.isFinite(minRating) && minRating > 0) filters.minRating = Math.min(minRating, 5);
  for (const k of ['language', 'subtitles', 'country']) {
    const val = get(k);
    if (val && /^[A-Za-z-]{2,8}$/.test(val)) filters[k] = val;
  }
  if (get('recent') === '1' || get('recent') === 'true') filters.recentDays = 30;
  const sort = get('sort');
  return {
    q: String(get('q') || '').slice(0, 200),
    sort: SORTS.includes(sort) ? sort : undefined,
    page: Math.max(parseInt(get('page'), 10) || 1, 1),
    pageSize: Math.min(Math.max(parseInt(get('pageSize'), 10) || 24, 1), 100),
    filters,
  };
}

/** Inverse of parseSearchParams — returns a plain object suitable for URLSearchParams. */
export function toSearchParams({ q, sort, page, filters = {} } = {}) {
  const out = {};
  if (q) out.q = q;
  if (sort) out.sort = sort;
  if (page && page > 1) out.page = String(page);
  if (filters.type) out.type = filters.type;
  for (const k of LIST_KEYS) if (filters[k]?.length) out[k] = filters[k].join(',');
  for (const k of INT_KEYS) if (filters[k] !== undefined) out[k] = String(filters[k]);
  if (filters.minRating) out.minRating = String(filters.minRating);
  for (const k of ['language', 'subtitles', 'country']) if (filters[k]) out[k] = filters[k];
  if (filters.recentDays) out.recent = '1';
  return out;
}
