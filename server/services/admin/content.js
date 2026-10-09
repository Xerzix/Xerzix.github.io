// Catalog administration: titles, seasons, episodes and media rows, publishing rules and
// the follower notifications that publishing triggers. Routes (server/routes/admin.js)
// validate input with the schemas exported here, call these functions, audit the change and
// invalidate the catalog read model.
import { now, parseJson, placeholders, toJson } from '../../db/index.js';
import { conflict, HttpError, notFound, validation } from '../../lib/errors.js';
import { newId } from '../../lib/crypto.js';
import { patterns, v } from '../../lib/validate.js';
import { notify } from '../notifications.js';
import { AGE_RATINGS, allowedFor, minAgeFor } from '../../../js/core/ratings.js';
import { isImageRef, likeTerm, mediaRefProblem, paging, slugify, uniqueId } from './common.js';

const RATING_CODES = AGE_RATINGS.map((r) => r.code);
const HDR_VALUES = ['HDR10', 'HDR10+', 'Dolby Vision', 'HLG'];
const SLUG = /^[a-z0-9][a-z0-9-]{1,79}$/;

// ───────────────────────────── Schemas ─────────────────────────────

const textList = (maxItems, maxLen = 60) => v.array(v.string().max(maxLen)).max(maxItems).unique();
const imageRef = () => v.string().max(1000).check(isImageRef, 'Use a site path such as assets/art/poster.svg, or an https URL on an origin listed in MEDIA_ORIGINS (browsers block images from anywhere else).').nullable();
// Ids that are also dashboard route words (#/content/new opens the create form).
const RESERVED_TITLE_IDS = new Set(['new']);

export const titleSchema = v.object({
  id: v.string().pattern(SLUG, 'Use 2–80 lowercase letters, numbers and hyphens.').check((s) => !RESERVED_TITLE_IDS.has(s), 'This id is reserved. Choose another.').optional(),
  type: v.enum(['movie', 'series']),
  title: v.string().min(1).max(200),
  originalTitle: v.string().max(200).nullable().optional(),
  tagline: v.string().max(300).nullable().optional(),
  synopsis: v.string().max(5000).nullable().optional(),
  year: v.int().min(1870).max(2100).nullable().optional(),
  releaseDate: v.string().pattern(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.').nullable().optional(),
  runtimeMin: v.int().min(0).max(1500).nullable().optional(),
  ageRating: v.enum(RATING_CODES).optional(),
  ratingSource: v.enum(['official', 'advisory']).optional(),
  genres: textList(12, 40).optional(),
  tags: textList(30, 60).optional(),
  moods: textList(30, 60).optional(),
  keywords: textList(60, 60).optional(),
  countries: v.array(v.string().pattern(/^[A-Za-z]{2}$/, 'Use two-letter country codes (ISO 3166-1).')).max(30).unique().optional(),
  originalLanguage: v.string().pattern(patterns.lang, 'Use a language code such as en or pt-BR.').nullable().optional(),
  credits: v.object({
    directors: v.array(v.string().max(120)).max(20).optional(),
    cast: v.array(v.object({ name: v.string().min(1).max(120), role: v.string().max(120).optional() })).max(150).optional(),
    crew: v.array(v.object({ name: v.string().min(1).max(120), job: v.string().min(1).max(80) })).max(150).optional(),
  }).optional(),
  awards: v.array(v.string().max(200)).max(40).optional(),
  poster: imageRef().optional(),
  backdrop: imageRef().optional(),
  palette: v.array(v.string().pattern(patterns.hexColor, 'Use #RRGGBB colours.')).max(8).optional(),
  license: v.object({
    name: v.string().max(120).optional(),
    url: v.string().url().max(500).optional(),
    attribution: v.string().max(500).optional(),
    source: v.string().max(300).optional(),
  }).optional(),
  featured: v.boolean().optional(),
  editorialRank: v.int().min(0).max(100000).optional(),
  creatorAccountId: v.string().max(80).nullable().optional(),
  // 'catalog' = listed for reference only (no media, never playable); 'stream' needs ready media.
  availability: v.enum(['stream', 'catalog']).optional(),
  tmdbId: v.int().min(1).max(100_000_000).nullable().optional(),
  tmdbType: v.enum(['movie', 'tv']).nullable().optional(),
});
export const titlePatchSchema = titleSchema.partial();

export const seasonSchema = v.object({
  number: v.int().min(0).max(999),
  name: v.string().max(120).nullable().optional(),
  synopsis: v.string().max(3000).nullable().optional(),
  year: v.int().min(1870).max(2100).nullable().optional(),
});

export const episodeSchema = v.object({
  seasonNumber: v.int().min(0).max(999),
  number: v.int().min(0).max(9999),
  name: v.string().min(1).max(200),
  synopsis: v.string().max(3000).nullable().optional(),
  runtimeMin: v.int().min(0).max(1500).nullable().optional(),
  still: imageRef().optional(),
  airDate: v.string().pattern(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.').nullable().optional(),
});

const timeS = () => v.number().min(0).max(200000).nullable().optional();
export const mediaSchema = v.object({
  titleId: v.string().max(80),
  episodeId: v.string().max(160).nullable().optional(),
  role: v.enum(['main', 'trailer', 'extra']).default('main'),
  label: v.string().max(120).nullable().optional(),
  kind: v.enum(['hls', 'dash', 'progressive']),
  source: v.string().max(1000),
  fallbacks: v.array(v.object({ kind: v.enum(['hls', 'dash', 'progressive']), src: v.string().max(1000) })).max(6).optional(),
  variants: v.array(v.object({ height: v.int().min(100).max(4320), src: v.string().max(1000), bitrateKbps: v.int().min(1).max(500000).optional() })).max(12).optional(),
  audioTracks: v.array(v.object({
    lang: v.string().pattern(patterns.lang, 'Use a language code such as en.'),
    label: v.string().min(1).max(60),
    kind: v.enum(['main', 'description', 'commentary', 'dub']).default('main'),
    default: v.boolean().default(false),
  })).max(30).optional(),
  subtitleTracks: v.array(v.object({
    lang: v.string().pattern(patterns.lang, 'Use a language code such as en.'),
    label: v.string().min(1).max(60),
    kind: v.enum(['subtitles', 'captions']).default('subtitles'),
    src: v.string().max(1000).nullable().optional(),
    default: v.boolean().default(false),
    forced: v.boolean().optional(),
    inManifest: v.boolean().optional(),
  })).max(60).optional(),
  audioFormats: v.array(v.string().max(40)).max(12).unique().optional(),
  hdr: v.enum(HDR_VALUES).nullable().optional(),
  durationS: timeS(),
  introStart: timeS(),
  introEnd: timeS(),
  creditsStart: timeS(),
  status: v.enum(['processing', 'ready', 'failed']).optional(),
});
export const mediaPatchSchema = mediaSchema.partial();

// ───────────────────────────── DTOs ─────────────────────────────

export function titleDto(r) {
  return {
    id: r.id,
    type: r.type,
    title: r.title,
    originalTitle: r.original_title,
    tagline: r.tagline,
    synopsis: r.synopsis,
    year: r.year,
    releaseDate: r.release_date,
    runtimeMin: r.runtime_min,
    ageRating: r.age_rating,
    ratingSource: r.rating_source,
    minAge: r.min_age,
    genres: parseJson(r.genres, []),
    tags: parseJson(r.tags, []),
    moods: parseJson(r.moods, []),
    keywords: parseJson(r.keywords, []),
    countries: parseJson(r.countries, []),
    originalLanguage: r.original_language,
    credits: { directors: [], cast: [], crew: [], ...parseJson(r.credits, {}) },
    awards: parseJson(r.awards, []),
    poster: r.poster,
    backdrop: r.backdrop,
    artworkSource: parseJson(r.artwork, {}).source || (r.poster ? 'manual' : null),
    availability: r.availability,
    tmdbId: r.tmdb_id,
    tmdbType: r.tmdb_type,
    palette: parseJson(r.palette, []),
    license: parseJson(r.license, {}),
    status: r.status,
    featured: !!r.featured,
    editorialRank: r.editorial_rank,
    creatorAccountId: r.creator_account_id,
    submissionId: r.submission_id,
    addedAt: r.added_at,
    updatedAt: r.updated_at,
    publishedAt: r.published_at,
  };
}

export function mediaDto(m) {
  return {
    id: m.id,
    titleId: m.title_id,
    episodeId: m.episode_id,
    role: m.role,
    label: m.label,
    kind: m.kind,
    source: m.source,
    fallbacks: parseJson(m.fallbacks, []),
    variants: parseJson(m.variants, []),
    resolutions: parseJson(m.resolutions, []),
    audioTracks: parseJson(m.audio_tracks, []),
    subtitleTracks: parseJson(m.subtitle_tracks, []),
    audioFormats: parseJson(m.audio_formats, []),
    videoCodecs: parseJson(m.video_codecs, []),
    hdr: m.hdr,
    durationS: m.duration_s,
    introStart: m.intro_start,
    introEnd: m.intro_end,
    creditsStart: m.credits_start,
    status: m.status,
    verified: !!m.verified_at,
    verifiedAt: m.verified_at,
    verifyReport: parseJson(m.verify_report, {}),
    createdAt: m.created_at,
    updatedAt: m.updated_at,
    ...(m.title_name !== undefined ? { titleName: m.title_name, titleType: m.title_type, titleStatus: m.title_status } : {}),
    ...(m.episode_name !== undefined ? { episodeName: m.episode_name, seasonNumber: m.season_number, episodeNumber: m.episode_number } : {}),
  };
}

function episodeRowDto(e, media = []) {
  return {
    id: e.id,
    titleId: e.title_id,
    seasonNumber: e.season_number,
    number: e.number,
    name: e.name,
    synopsis: e.synopsis,
    runtimeMin: e.runtime_min,
    still: e.still,
    airDate: e.air_date,
    media: media.map(mediaDto),
    hasReadyMedia: media.some((m) => m.role === 'main' && m.status === 'ready'),
  };
}

// ───────────────────────────── Titles ─────────────────────────────

export function getTitleRow(db, id) {
  const row = db.get('SELECT * FROM titles WHERE id = ?', id);
  if (!row) throw notFound('That title does not exist.');
  return row;
}

export function listTitles(db, query) {
  const { page, pageSize, offset } = paging(query, { size: 25 });
  const where = [];
  const args = [];
  if (query.q) {
    where.push(`(t.title LIKE ? ESCAPE '\\' OR t.id LIKE ? ESCAPE '\\' OR t.original_title LIKE ? ESCAPE '\\')`);
    const term = likeTerm(query.q);
    args.push(term, term, term);
  }
  if (['movie', 'series'].includes(query.type)) {
    where.push('t.type = ?');
    args.push(query.type);
  }
  if (['draft', 'published', 'unpublished'].includes(query.status)) {
    where.push('t.status = ?');
    args.push(query.status);
  }
  if (query.featured === '1') where.push('t.featured = 1');
  if (query.source === 'creator') where.push('t.creator_account_id IS NOT NULL');
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const sorts = {
    updated: 't.updated_at DESC',
    title: 't.title COLLATE NOCASE ASC',
    added: 't.added_at DESC',
    rank: 't.editorial_rank ASC, t.title COLLATE NOCASE ASC',
  };
  const order = sorts[query.sort] || sorts.updated;
  const total = db.get(`SELECT COUNT(*) AS n FROM titles t ${clause}`, ...args).n;
  const rows = db.all(
    `SELECT t.*,
            (SELECT COUNT(*) FROM media m WHERE m.title_id = t.id) AS media_total,
            (SELECT COUNT(*) FROM media m WHERE m.title_id = t.id AND m.status = 'ready') AS media_ready,
            (SELECT COUNT(*) FROM media m WHERE m.title_id = t.id AND m.verified_at IS NOT NULL) AS media_verified,
            (SELECT COUNT(*) FROM episodes e WHERE e.title_id = t.id) AS episode_count,
            a.display_name AS creator_name
       FROM titles t LEFT JOIN accounts a ON a.id = t.creator_account_id
       ${clause} ORDER BY ${order} LIMIT ? OFFSET ?`,
    ...args, pageSize, offset,
  );
  const counts = Object.fromEntries(db.all('SELECT status, COUNT(*) AS n FROM titles GROUP BY status').map((r) => [r.status, r.n]));
  return {
    items: rows.map((r) => ({
      id: r.id,
      type: r.type,
      title: r.title,
      year: r.year,
      status: r.status,
      poster: r.poster,
      genres: parseJson(r.genres, []),
      ageRating: r.age_rating,
      featured: !!r.featured,
      editorialRank: r.editorial_rank,
      updatedAt: r.updated_at,
      publishedAt: r.published_at,
      media: { total: r.media_total, ready: r.media_ready, verified: r.media_verified },
      episodeCount: r.episode_count,
      creator: r.creator_name ? { id: r.creator_account_id, name: r.creator_name } : null,
      submissionId: r.submission_id,
    })),
    total,
    page,
    pageSize,
    counts,
  };
}

/** Full editable view of a title with seasons, episodes, media and the publish checklist. */
export function adminTitle(db, id) {
  const row = getTitleRow(db, id);
  const media = db.all('SELECT * FROM media WHERE title_id = ? ORDER BY role, created_at', id);
  const seasons = db.all('SELECT * FROM seasons WHERE title_id = ? ORDER BY number', id);
  const episodes = db.all('SELECT * FROM episodes WHERE title_id = ? ORDER BY season_number, number', id);
  const byEpisode = new Map();
  for (const m of media) if (m.episode_id) byEpisode.set(m.episode_id, [...(byEpisode.get(m.episode_id) || []), m]);
  const numbers = [...new Set([...seasons.map((s) => s.number), ...episodes.map((e) => e.season_number)])].sort((a, b) => a - b);
  const creator = row.creator_account_id ? db.get('SELECT id, display_name, email FROM accounts WHERE id = ?', row.creator_account_id) : null;
  const submission = row.submission_id ? db.get('SELECT id, status, project_title FROM submissions WHERE id = ?', row.submission_id) : null;
  const followers = db.get(`SELECT COUNT(*) AS n FROM follows WHERE target_type = 'series' AND target_id = ?`, id).n;
  return {
    title: titleDto(row),
    seasons: numbers.map((n) => {
      const s = seasons.find((x) => x.number === n);
      return {
        id: s?.id || null,
        number: n,
        name: s?.name || null,
        synopsis: s?.synopsis || null,
        year: s?.year ?? null,
        episodes: episodes.filter((e) => e.season_number === n).map((e) => episodeRowDto(e, byEpisode.get(e.id) || [])),
      };
    }),
    media: media.map(mediaDto),
    publish: { missing: publishMissing(db, row) },
    creator: creator ? { id: creator.id, name: creator.display_name, email: creator.email } : null,
    submission: submission ? { id: submission.id, status: submission.status, projectTitle: submission.project_title } : null,
    followers,
  };
}

function titleColumns(input) {
  const cols = {};
  const map = {
    type: 'type', title: 'title', originalTitle: 'original_title', tagline: 'tagline', year: 'year', releaseDate: 'release_date',
    runtimeMin: 'runtime_min', ratingSource: 'rating_source', originalLanguage: 'original_language', poster: 'poster', backdrop: 'backdrop',
    editorialRank: 'editorial_rank', creatorAccountId: 'creator_account_id',
    availability: 'availability', tmdbId: 'tmdb_id', tmdbType: 'tmdb_type',
  };
  for (const [k, col] of Object.entries(map)) if (input[k] !== undefined) cols[col] = input[k];
  if (input.synopsis !== undefined) cols.synopsis = input.synopsis ?? '';
  if (input.ageRating !== undefined) {
    cols.age_rating = input.ageRating;
    cols.min_age = minAgeFor(input.ageRating);
  }
  for (const k of ['genres', 'tags', 'moods', 'keywords', 'awards', 'palette']) if (input[k] !== undefined) cols[k] = toJson(input[k]);
  if (input.countries !== undefined) cols.countries = toJson(input.countries.map((c) => c.toUpperCase()));
  if (input.credits !== undefined) cols.credits = toJson({ directors: input.credits.directors || [], cast: input.credits.cast || [], crew: input.credits.crew || [] });
  if (input.license !== undefined) cols.license = toJson(input.license);
  if (input.featured !== undefined) cols.featured = input.featured ? 1 : 0;
  return cols;
}

function assertCreator(db, accountId) {
  if (!accountId) return;
  if (!db.get('SELECT 1 FROM accounts WHERE id = ?', accountId)) throw validation({ creatorAccountId: 'No account has that id.' });
}

export function createTitle(db, input) {
  assertCreator(db, input.creatorAccountId);
  const exists = (id) => RESERVED_TITLE_IDS.has(id) || !!db.get('SELECT 1 FROM titles WHERE id = ?', id);
  let id = input.id;
  if (id) {
    if (exists(id)) throw validation({ id: 'Another title already uses this id.' });
  } else {
    id = uniqueId(slugify(input.title), exists);
  }
  const ts = now();
  const cols = { ...titleColumns({ ageRating: 'NR', ratingSource: 'advisory', ...input }), id, status: 'draft', added_at: ts, updated_at: ts };
  const keys = Object.keys(cols);
  db.run(`INSERT INTO titles (${keys.join(', ')}) VALUES (${placeholders(keys.length)})`, ...keys.map((k) => cols[k]));
  return id;
}

export function updateTitle(db, id, patch) {
  const row = getTitleRow(db, id);
  if (patch.type && patch.type !== row.type) {
    const hasEpisodes = db.get('SELECT 1 FROM episodes WHERE title_id = ? LIMIT 1', id);
    const hasMovieMedia = db.get(`SELECT 1 FROM media WHERE title_id = ? AND episode_id IS NULL AND role = 'main' LIMIT 1`, id);
    if (hasEpisodes || hasMovieMedia) throw validation({ type: 'Remove the episodes or main media before changing the type.' });
  }
  if (patch.creatorAccountId !== undefined) assertCreator(db, patch.creatorAccountId);
  const { id: _ignored, ...rest } = patch;
  const cols = titleColumns(rest);
  // Staff-chosen artwork replaces synced artwork and is kept by later syncs.
  const isSynced = (url) => typeof url === 'string' && url.startsWith('media/artwork/tmdb/');
  const artChanged = (col) => cols[col] !== undefined && cols[col] !== row[col] && !isSynced(cols[col]);
  if (artChanged('poster') || artChanged('backdrop')) cols.artwork = toJson({ source: 'manual', locked: true });
  const changed = [];
  const before = titleDto(row);
  for (const key of Object.keys(rest)) if (JSON.stringify(before[key]) !== JSON.stringify(rest[key])) changed.push(key);
  if (!Object.keys(cols).length) return { changed };
  cols.updated_at = now();
  const keys = Object.keys(cols);
  db.run(`UPDATE titles SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => cols[k]), id);
  return { changed };
}

/** What still blocks publishing: [{ field, message }]. */
export function publishMissing(db, row) {
  const missing = [];
  if (!String(row.synopsis || '').trim()) missing.push({ field: 'synopsis', message: 'Add a synopsis.' });
  if (!row.poster) missing.push({ field: 'poster', message: 'Add poster artwork (or sync it from TMDB).' });
  // Reference-only titles are never streamed, so they need neither a streaming licence nor media.
  if (row.availability === 'catalog') return missing;
  const license = parseJson(row.license, {});
  if (!license.name || !license.attribution) missing.push({ field: 'license', message: 'Add the licence name and the attribution line.' });
  if (row.type === 'movie') {
    const ok = db.get(`SELECT 1 FROM media WHERE title_id = ? AND episode_id IS NULL AND role = 'main' AND status = 'ready' LIMIT 1`, row.id);
    if (!ok) missing.push({ field: 'media', message: 'Add a ready main video (media) for this film.' });
  } else {
    const ok = db.get(`SELECT 1 FROM media m JOIN episodes e ON e.id = m.episode_id WHERE e.title_id = ? AND m.role = 'main' AND m.status = 'ready' LIMIT 1`, row.id);
    if (!ok) missing.push({ field: 'media', message: 'Add at least one episode with ready media.' });
  }
  return missing;
}

/**
 * Publishes a title (422 PUBLISH_REQUIREMENTS listing what is missing), completes a linked
 * creator submission and notifies followers. Returns { notified }.
 */
export function publishTitle(db, ctx, id) {
  const row = getTitleRow(db, id);
  const missing = publishMissing(db, row);
  if (missing.length) {
    throw new HttpError(422, 'PUBLISH_REQUIREMENTS', `This title is not ready to publish: ${missing.map((m) => m.message.replace(/\.$/, '').toLowerCase()).join('; ')}.`, {
      missing,
      fields: Object.fromEntries(missing.map((m) => [m.field, m.message])),
    });
  }
  const ts = now();
  return db.tx(() => {
    db.run(`UPDATE titles SET status = 'published', published_at = COALESCE(published_at, ?), updated_at = ? WHERE id = ?`, ts, ts, id);
    const published = db.get('SELECT * FROM titles WHERE id = ?', id);
    const submission = published.submission_id ? markSubmissionPublished(db, ctx, published) : null;
    const notified = notifyRelease(db, published);
    return { notified, submission };
  });
}

/**
 * Runs a destructive change inside a transaction and rolls it back when it would leave a
 * PUBLISHED title with nothing playable (the publish checklist only runs at publish time).
 */
function keepPlayable(db, titleId, change) {
  return db.tx(() => {
    const result = change();
    const row = db.get('SELECT * FROM titles WHERE id = ?', titleId);
    if (row?.status === 'published' && publishMissing(db, row).some((m) => m.field === 'media')) {
      throw conflict(
        row.type === 'movie'
          ? 'This is the only ready main video of a published film. Unpublish the title first, or add another ready main video.'
          : 'This would leave a published series without any episode that has ready media. Unpublish the title first, or add ready media to another episode.',
        'TITLE_WOULD_BE_UNPLAYABLE',
      );
    }
    return result;
  });
}

export function unpublishTitle(db, id) {
  const row = getTitleRow(db, id);
  if (row.status !== 'published') throw conflict('This title is not published.', 'NOT_PUBLISHED');
  db.run(`UPDATE titles SET status = 'unpublished', updated_at = ? WHERE id = ?`, now(), id);
}

export function deleteTitle(db, id) {
  const row = getTitleRow(db, id);
  if (row.status === 'published') throw conflict('Unpublish the title before deleting it.', 'TITLE_PUBLISHED');
  db.tx(() => {
    db.run(`DELETE FROM follows WHERE target_type = 'series' AND target_id = ?`, id);
    db.run('DELETE FROM titles WHERE id = ?', id);
  });
  return row;
}

/** Called when a title created from a creator submission goes live. */
export function markSubmissionPublished(db, ctx, titleRow) {
  const sub = db.get('SELECT * FROM submissions WHERE id = ?', titleRow.submission_id);
  if (!sub || sub.status === 'published') return null;
  if (sub.status !== 'approved') return null;
  const ts = now();
  db.run(`UPDATE submissions SET status = 'published', title_id = ?, status_reason = NULL, updated_at = ? WHERE id = ?`, titleRow.id, ts, sub.id);
  db.run(
    `INSERT INTO submission_events (submission_id, actor_account_id, kind, from_status, to_status, message, visible_to_creator, created_at)
     VALUES (?, ?, 'status', 'approved', 'published', ?, 1, ?)`,
    sub.id, ctx?.account?.id ?? null, `“${titleRow.title}” is now live on Lumina.`, ts,
  );
  notify(db, {
    accountId: sub.account_id,
    type: 'submission_update',
    title: `“${titleRow.title}” is live on Lumina`,
    body: 'Your submission has been published. Thank you for sharing your work.',
    link: `#/title/${titleRow.id}`,
    dedupeKey: `submission_published:${sub.id}`,
  });
  return { id: sub.id, status: 'published' };
}

// ───────────────────────────── Follower notifications ─────────────────────────────

function followers(db, type, ids, { nocase = false } = {}) {
  if (!ids.length) return [];
  const col = nocase ? 'lower(f.target_id)' : 'f.target_id';
  return db.all(
    `SELECT f.profile_id, f.target_id, p.account_id, p.max_age
       FROM follows f JOIN profiles p ON p.id = f.profile_id
       JOIN accounts a ON a.id = p.account_id AND a.status = 'active'
      WHERE f.target_type = ? AND ${col} IN (${placeholders(ids.length)})
      ORDER BY f.created_at`,
    type, ...(nocase ? ids.map((x) => String(x).toLowerCase()) : ids),
  );
}

/** Notifies each account at most once, and only when one of its following profiles may see the title. */
function notifyEach(db, rows, minAge, build, done) {
  let sent = 0;
  const firstProfile = new Map();
  for (const r of rows) {
    if (done.has(r.account_id) || firstProfile.has(r.account_id)) continue;
    if (!allowedFor({ maxAge: r.max_age }, minAge)) continue;
    firstProfile.set(r.account_id, r);
  }
  for (const [accountId, r] of firstProfile) {
    done.add(accountId);
    if (notify(db, { accountId, profileId: r.profile_id, ...build(r) })) sent++;
  }
  return sent;
}

/** Title published: creator followers first, then genre followers (one notification per account). */
export function notifyRelease(db, row) {
  const done = new Set(row.creator_account_id ? [row.creator_account_id] : []);
  const link = `#/title/${row.id}`;
  const blurb = (row.tagline || row.synopsis || '').slice(0, 180);
  let creatorRelease = 0;
  if (row.creator_account_id) {
    const creator = db.get('SELECT display_name FROM accounts WHERE id = ?', row.creator_account_id);
    creatorRelease = notifyEach(db, followers(db, 'creator', [row.creator_account_id]), row.min_age, () => ({
      type: 'creator_release',
      title: `${creator?.display_name || 'A creator you follow'} released “${row.title}”`,
      body: blurb,
      link,
      dedupeKey: `creator_release:${row.id}`,
    }), done);
  }
  const genres = parseJson(row.genres, []);
  const genreRelease = notifyEach(db, followers(db, 'genre', genres, { nocase: true }), row.min_age, (r) => ({
    type: 'genre_release',
    title: `New in ${genres.find((g) => g.toLowerCase() === String(r.target_id).toLowerCase()) || r.target_id}: “${row.title}”`,
    body: blurb,
    link,
    dedupeKey: `genre_release:${row.id}`,
  }), done);
  return { creatorRelease, genreRelease };
}

/**
 * An episode of a published series received ready main media: notify the series' followers.
 * Exported for the transcoding worker, which marks media ready asynchronously.
 */
export function notifyNewEpisode(db, mediaRow) {
  if (!mediaRow || mediaRow.role !== 'main' || !mediaRow.episode_id || mediaRow.status !== 'ready') return 0;
  const ep = db.get('SELECT * FROM episodes WHERE id = ?', mediaRow.episode_id);
  const title = ep && db.get('SELECT * FROM titles WHERE id = ?', ep.title_id);
  if (!title || title.status !== 'published' || title.type !== 'series') return 0;
  return notifyEach(db, followers(db, 'series', [title.id]), title.min_age, () => ({
    type: 'new_episode',
    title: `New episode of “${title.title}”`,
    body: `S${ep.season_number} · E${ep.number} — ${ep.name}`,
    link: `#/title/${title.id}`,
    data: { titleId: title.id, episodeId: ep.id },
    dedupeKey: `new_episode:${ep.id}`,
  }), new Set());
}

// ───────────────────────────── Seasons & episodes ─────────────────────────────

function requireSeries(row) {
  if (row.type !== 'series') throw conflict('Only series have seasons and episodes.', 'NOT_A_SERIES');
}

export function createSeason(db, titleId, input) {
  const row = getTitleRow(db, titleId);
  requireSeries(row);
  if (db.get('SELECT 1 FROM seasons WHERE title_id = ? AND number = ?', titleId, input.number)) throw validation({ number: 'This season number already exists.' });
  const id = uniqueId(`${titleId}-s${input.number}`, (x) => !!db.get('SELECT 1 FROM seasons WHERE id = ?', x));
  db.run('INSERT INTO seasons (id, title_id, number, name, synopsis, year) VALUES (?, ?, ?, ?, ?, ?)', id, titleId, input.number, input.name ?? null, input.synopsis ?? null, input.year ?? null);
  touchTitle(db, titleId);
  return db.get('SELECT * FROM seasons WHERE id = ?', id);
}

export function updateSeason(db, id, patch) {
  const s = db.get('SELECT * FROM seasons WHERE id = ?', id);
  if (!s) throw notFound('That season does not exist.');
  db.tx(() => {
    if (patch.number !== undefined && patch.number !== s.number) {
      if (db.get('SELECT 1 FROM seasons WHERE title_id = ? AND number = ?', s.title_id, patch.number)) throw validation({ number: 'This season number already exists.' });
      if (db.get('SELECT 1 FROM episodes WHERE title_id = ? AND season_number = ? LIMIT 1', s.title_id, patch.number)) throw validation({ number: 'Episodes already use that season number.' });
      db.run('UPDATE episodes SET season_number = ? WHERE title_id = ? AND season_number = ?', patch.number, s.title_id, s.number);
    }
    db.run(
      'UPDATE seasons SET number = ?, name = ?, synopsis = ?, year = ? WHERE id = ?',
      patch.number ?? s.number,
      patch.name !== undefined ? patch.name : s.name,
      patch.synopsis !== undefined ? patch.synopsis : s.synopsis,
      patch.year !== undefined ? patch.year : s.year,
      id,
    );
    touchTitle(db, s.title_id);
  });
  return db.get('SELECT * FROM seasons WHERE id = ?', id);
}

export function deleteSeason(db, id) {
  const s = db.get('SELECT * FROM seasons WHERE id = ?', id);
  if (!s) throw notFound('That season does not exist.');
  const episodes = db.get('SELECT COUNT(*) AS n FROM episodes WHERE title_id = ? AND season_number = ?', s.title_id, s.number).n;
  keepPlayable(db, s.title_id, () => {
    db.run('DELETE FROM episodes WHERE title_id = ? AND season_number = ?', s.title_id, s.number);
    db.run('DELETE FROM seasons WHERE id = ?', id);
    touchTitle(db, s.title_id);
  });
  return { season: s, episodesDeleted: episodes };
}

export function createEpisode(db, titleId, input) {
  const row = getTitleRow(db, titleId);
  requireSeries(row);
  if (db.get('SELECT 1 FROM episodes WHERE title_id = ? AND season_number = ? AND number = ?', titleId, input.seasonNumber, input.number)) {
    throw validation({ number: 'This episode number already exists in that season.' });
  }
  const id = uniqueId(`${titleId}-s${input.seasonNumber}e${input.number}`, (x) => !!db.get('SELECT 1 FROM episodes WHERE id = ?', x));
  db.tx(() => {
    if (!db.get('SELECT 1 FROM seasons WHERE title_id = ? AND number = ?', titleId, input.seasonNumber)) {
      const sid = uniqueId(`${titleId}-s${input.seasonNumber}`, (x) => !!db.get('SELECT 1 FROM seasons WHERE id = ?', x));
      db.run('INSERT INTO seasons (id, title_id, number, name) VALUES (?, ?, ?, NULL)', sid, titleId, input.seasonNumber);
    }
    db.run(
      'INSERT INTO episodes (id, title_id, season_number, number, name, synopsis, runtime_min, still, air_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, titleId, input.seasonNumber, input.number, input.name, input.synopsis ?? '', input.runtimeMin ?? null, input.still ?? null, input.airDate ?? null,
    );
    touchTitle(db, titleId);
  });
  return db.get('SELECT * FROM episodes WHERE id = ?', id);
}

export function updateEpisode(db, id, patch) {
  const e = db.get('SELECT * FROM episodes WHERE id = ?', id);
  if (!e) throw notFound('That episode does not exist.');
  const season = patch.seasonNumber ?? e.season_number;
  const number = patch.number ?? e.number;
  if ((season !== e.season_number || number !== e.number)
    && db.get('SELECT 1 FROM episodes WHERE title_id = ? AND season_number = ? AND number = ? AND id != ?', e.title_id, season, number, id)) {
    throw validation({ number: 'This episode number already exists in that season.' });
  }
  const pick = (k, col) => (patch[k] !== undefined ? patch[k] : e[col]);
  db.tx(() => {
    if (season !== e.season_number && !db.get('SELECT 1 FROM seasons WHERE title_id = ? AND number = ?', e.title_id, season)) {
      const sid = uniqueId(`${e.title_id}-s${season}`, (x) => !!db.get('SELECT 1 FROM seasons WHERE id = ?', x));
      db.run('INSERT INTO seasons (id, title_id, number) VALUES (?, ?, ?)', sid, e.title_id, season);
    }
    db.run(
      'UPDATE episodes SET season_number = ?, number = ?, name = ?, synopsis = ?, runtime_min = ?, still = ?, air_date = ? WHERE id = ?',
      season, number, pick('name', 'name'), pick('synopsis', 'synopsis') ?? '', pick('runtimeMin', 'runtime_min'), pick('still', 'still'), pick('airDate', 'air_date'), id,
    );
    touchTitle(db, e.title_id);
  });
  return db.get('SELECT * FROM episodes WHERE id = ?', id);
}

export function deleteEpisode(db, id) {
  const e = db.get('SELECT * FROM episodes WHERE id = ?', id);
  if (!e) throw notFound('That episode does not exist.');
  keepPlayable(db, e.title_id, () => {
    db.run('DELETE FROM episodes WHERE id = ?', id);
    touchTitle(db, e.title_id);
  });
  return e;
}

export function episodeDto(e) {
  return episodeRowDto(e, []);
}

function touchTitle(db, titleId) {
  db.run('UPDATE titles SET updated_at = ? WHERE id = ?', now(), titleId);
}

// ───────────────────────────── Media ─────────────────────────────

export function listMedia(db, query) {
  const { page, pageSize, offset } = paging(query, { size: 30 });
  const where = [];
  const args = [];
  if (query.titleId) {
    where.push('m.title_id = ?');
    args.push(query.titleId);
  }
  if (query.episodeId) {
    where.push('m.episode_id = ?');
    args.push(query.episodeId);
  }
  if (['hls', 'dash', 'progressive'].includes(query.kind)) {
    where.push('m.kind = ?');
    args.push(query.kind);
  }
  if (['processing', 'ready', 'failed'].includes(query.status)) {
    where.push('m.status = ?');
    args.push(query.status);
  }
  if (query.verified === '1') where.push('m.verified_at IS NOT NULL');
  if (query.verified === '0') where.push('m.verified_at IS NULL');
  if (query.q) {
    const term = likeTerm(query.q);
    where.push(`(t.title LIKE ? ESCAPE '\\' OR m.source LIKE ? ESCAPE '\\' OR e.name LIKE ? ESCAPE '\\' OR m.id LIKE ? ESCAPE '\\')`);
    args.push(term, term, term, term);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const from = `FROM media m LEFT JOIN titles t ON t.id = m.title_id LEFT JOIN episodes e ON e.id = m.episode_id ${clause}`;
  const total = db.get(`SELECT COUNT(*) AS n ${from}`, ...args).n;
  const rows = db.all(
    `SELECT m.*, t.title AS title_name, t.type AS title_type, t.status AS title_status,
            e.name AS episode_name, e.season_number, e.number AS episode_number
       ${from} ORDER BY t.title COLLATE NOCASE, e.season_number, e.number, m.role LIMIT ? OFFSET ?`,
    ...args, pageSize, offset,
  );
  return { items: rows.map(mediaDto), total, page, pageSize };
}

export function getMediaRow(db, id) {
  const m = db.get('SELECT * FROM media WHERE id = ?', id);
  if (!m) throw notFound('That media entry does not exist.');
  return m;
}

const PLAYABLE_SUBMISSION_ROLES = ['feature', 'episode', 'trailer', 'subtitle'];

/**
 * Which private storage keys may back a media row. Signed playback URLs make a media file
 * reachable by every viewer, so only:
 *   - media/… (transcoder output and files copied there when a submission is published), or
 *   - a video/subtitle file of a creator submission that an admin APPROVED (or published) and
 *     that is linked to this very title.
 * Upload staging files, documents and files of submissions still under review never qualify.
 */
export function storageSourceProblem(db, key, titleId) {
  if (key.startsWith('media/')) return null;
  const m = /^submissions\/([^/]+)\//.exec(key);
  if (m) {
    const file = db.get(
      `SELECT f.role, s.status, s.title_id FROM submission_files f JOIN submissions s ON s.id = f.submission_id
        WHERE f.storage_key = ? AND f.submission_id = ?`, key, m[1],
    );
    if (!file) return 'That submission file does not exist.';
    if (!PLAYABLE_SUBMISSION_ROLES.includes(file.role)) return 'Only video and subtitle files of a submission can be used as media.';
    if (!['approved', 'published'].includes(file.status)) return 'That submission has not been approved, so its files cannot be published.';
    if (!titleId || file.title_id !== titleId) return 'That submission file belongs to another title. Use “Create draft title” on the submission instead.';
    return null;
  }
  return 'Only storage keys under media/ (or files of an approved submission linked to this title) can be used as media.';
}

/** Validates locations inside a media body; throws 422 with per-field messages. */
function checkMediaRefs(db, input) {
  const errors = {};
  const check = (value, key) => {
    if (value === undefined || value === null) return;
    const problem = mediaRefProblem(value) || (value.startsWith('storage:') ? storageSourceProblem(db, value.slice(8), input.titleId) : null);
    if (problem) errors[key] = problem;
  };
  check(input.source, 'source');
  (input.fallbacks || []).forEach((f, i) => check(f.src, `fallbacks[${i}].src`));
  (input.variants || []).forEach((x, i) => check(x.src, `variants[${i}].src`));
  (input.subtitleTracks || []).forEach((s, i) => check(s.src, `subtitleTracks[${i}].src`));
  if (input.introStart != null && input.introEnd != null && input.introEnd <= input.introStart) errors.introEnd = 'The intro must end after it starts.';
  if (input.durationS && input.creditsStart != null && input.creditsStart > input.durationS) errors.creditsStart = 'Credits cannot start after the end of the video.';
  const defaults = (list) => (list || []).filter((t) => t.default).length;
  if (defaults(input.audioTracks) > 1) errors.audioTracks = 'Only one audio track can be the default.';
  if (defaults(input.subtitleTracks) > 1) errors.subtitleTracks = 'Only one subtitle track can be the default.';
  if (Object.keys(errors).length) throw validation(errors);
}

function checkPlacement(db, { titleId, episodeId, role }, exceptId = null) {
  const title = db.get('SELECT id, type FROM titles WHERE id = ?', titleId);
  if (!title) throw validation({ titleId: 'That title does not exist.' });
  if (episodeId) {
    const ep = db.get('SELECT id FROM episodes WHERE id = ? AND title_id = ?', episodeId, titleId);
    if (!ep) throw validation({ episodeId: 'That episode does not belong to this title.' });
  }
  if (role === 'main') {
    if (title.type === 'series' && !episodeId) throw validation({ episodeId: 'Main media for a series belongs to an episode. Choose one.' });
    if (title.type === 'movie' && episodeId) throw validation({ episodeId: 'Films do not have episodes.' });
    const dup = db.get(
      `SELECT id FROM media WHERE title_id = ? AND role = 'main' AND ${episodeId ? 'episode_id = ?' : 'episode_id IS NULL'} AND id != ? LIMIT 1`,
      ...(episodeId ? [titleId, episodeId] : [titleId]), exceptId || '',
    );
    if (dup) throw conflict(`${episodeId ? 'This episode' : 'This film'} already has main media (${dup.id}). Edit that entry instead.`, 'MEDIA_EXISTS', { mediaId: dup.id });
  }
  return title;
}

export function createMedia(db, input) {
  checkMediaRefs(db, input);
  checkPlacement(db, { titleId: input.titleId, episodeId: input.episodeId || null, role: input.role });
  const id = newId('med');
  const ts = now();
  db.run(
    `INSERT INTO media (id, title_id, episode_id, role, label, kind, source, fallbacks, variants, resolutions, audio_tracks, subtitle_tracks,
                        audio_formats, video_codecs, hdr, duration_s, intro_start, intro_end, credits_start, status, verified_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    id, input.titleId, input.episodeId || null, input.role, input.label ?? null, input.kind, input.source,
    toJson(input.fallbacks || []), toJson(input.variants || []), toJson(input.audioTracks || []), toJson(input.subtitleTracks || []),
    toJson(input.audioFormats || []), input.hdr ?? null, input.durationS ?? null, input.introStart ?? null, input.introEnd ?? null,
    input.creditsStart ?? null, input.status || 'ready', ts, ts,
  );
  const row = getMediaRow(db, id);
  const notified = notifyNewEpisode(db, row);
  touchTitle(db, input.titleId);
  return { row, notified };
}

export function updateMedia(db, id, patch) {
  const m = getMediaRow(db, id);
  const merged = {
    titleId: m.title_id,
    episodeId: patch.episodeId !== undefined ? patch.episodeId : m.episode_id,
    role: patch.role ?? m.role,
    introStart: patch.introStart !== undefined ? patch.introStart : m.intro_start,
    introEnd: patch.introEnd !== undefined ? patch.introEnd : m.intro_end,
    creditsStart: patch.creditsStart !== undefined ? patch.creditsStart : m.credits_start,
    durationS: patch.durationS !== undefined ? patch.durationS : m.duration_s,
  };
  checkMediaRefs(db, { ...patch, ...merged });
  if (patch.episodeId !== undefined || patch.role !== undefined) checkPlacement(db, merged, id);
  const cols = {};
  const scalar = { role: 'role', label: 'label', kind: 'kind', source: 'source', hdr: 'hdr', durationS: 'duration_s', introStart: 'intro_start', introEnd: 'intro_end', creditsStart: 'credits_start', status: 'status' };
  for (const [k, col] of Object.entries(scalar)) if (patch[k] !== undefined) cols[col] = patch[k];
  if (patch.episodeId !== undefined) cols.episode_id = patch.episodeId || null;
  const json = { fallbacks: 'fallbacks', variants: 'variants', audioTracks: 'audio_tracks', subtitleTracks: 'subtitle_tracks', audioFormats: 'audio_formats' };
  for (const [k, col] of Object.entries(json)) if (patch[k] !== undefined) cols[col] = toJson(patch[k]);
  // A new location (or container) invalidates whatever was verified about the old one.
  const relocated = (patch.source !== undefined && patch.source !== m.source) || (patch.kind !== undefined && patch.kind !== m.kind)
    || (patch.variants !== undefined && toJson(patch.variants) !== m.variants);
  if (relocated) Object.assign(cols, { verified_at: null, resolutions: '[]', video_codecs: '[]', verify_report: '{}' });
  if (!Object.keys(cols).length) return { row: m, notified: 0, relocated: false };
  cols.updated_at = now();
  const keys = Object.keys(cols);
  // A status, role or placement change can take the last ready video away from a published title.
  keepPlayable(db, m.title_id, () => db.run(`UPDATE media SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => cols[k]), id));
  const row = getMediaRow(db, id);
  const becameReady = row.status === 'ready' && (m.status !== 'ready' || m.episode_id !== row.episode_id || m.role !== row.role);
  const notified = becameReady ? notifyNewEpisode(db, row) : 0;
  touchTitle(db, m.title_id);
  return { row, notified, relocated };
}

export function deleteMedia(db, id) {
  const m = getMediaRow(db, id);
  keepPlayable(db, m.title_id, () => {
    db.run('DELETE FROM media WHERE id = ?', id);
    touchTitle(db, m.title_id);
  });
  return m;
}

/** Stores a successful verification (fields from media-verify.js) or just the failure report. */
export function applyVerification(db, id, result) {
  const m = getMediaRow(db, id);
  const ts = now();
  if (!result.ok) {
    db.run('UPDATE media SET verify_report = ?, updated_at = ? WHERE id = ?', toJson(result.report), ts, id);
    return getMediaRow(db, id);
  }
  const f = result.fields;
  const cols = {
    resolutions: toJson(f.resolutions || []),
    video_codecs: toJson(f.videoCodecs || []),
    verified_at: ts,
    verify_report: toJson(result.report),
    updated_at: ts,
  };
  if (f.audioTracks) cols.audio_tracks = toJson(f.audioTracks);
  if (f.subtitleTracks) {
    // Keep side-loaded WebVTT tracks; replace the ones the manifest declares.
    const sideLoaded = parseJson(m.subtitle_tracks, []).filter((t) => t.src && !t.inManifest);
    cols.subtitle_tracks = toJson([...sideLoaded, ...f.subtitleTracks]);
  }
  if (f.audioFormats) cols.audio_formats = toJson(f.audioFormats);
  if (f.hdr !== undefined) cols.hdr = f.hdr;
  if (f.durationS) cols.duration_s = f.durationS;
  const keys = Object.keys(cols);
  db.run(`UPDATE media SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => cols[k]), id);
  return getMediaRow(db, id);
}

// ───────────────────────────── Taxonomy ─────────────────────────────

export const taxonomySchema = v.object({
  genres: v.array(v.string().min(1).max(40)).max(80).unique(),
  collections: v.array(v.object({
    id: v.string().pattern(/^[a-z0-9][a-z0-9-]{0,59}$/, 'Use lowercase letters, numbers and hyphens.'),
    name: v.string().min(1).max(80),
    description: v.string().max(300).optional(),
  })).max(60),
});

const prettify = (tag) => tag.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

export function getTaxonomy(db, stored) {
  const genreCounts = new Map();
  const tagCounts = new Map();
  for (const r of db.all('SELECT genres, tags FROM titles')) {
    for (const g of parseJson(r.genres, [])) genreCounts.set(g, (genreCounts.get(g) || 0) + 1);
    for (const t of parseJson(r.tags, [])) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
  }
  const genres = stored?.genres || [...genreCounts.keys()].sort((a, b) => a.localeCompare(b));
  const collections = stored?.collections || [...tagCounts.keys()].sort().map((id) => ({ id, name: prettify(id), description: '' }));
  return {
    genres,
    collections,
    usage: { genres: Object.fromEntries(genreCounts), collections: Object.fromEntries(tagCounts) },
    customised: !!stored,
  };
}

