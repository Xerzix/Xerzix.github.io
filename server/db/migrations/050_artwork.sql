-- Artwork and catalog availability (050–059).
--
-- availability: 'stream' titles need ready media before they can be published and played;
-- 'catalog' titles are metadata-only (poster, synopsis, credits) and never show a Play button.
-- Metadata and artwork stay separate from media: a poster says nothing about streaming rights.
ALTER TABLE titles ADD COLUMN availability TEXT NOT NULL DEFAULT 'stream' CHECK (availability IN ('stream', 'catalog'));

-- The TMDB entry a title was matched to (by title + release year, or set by staff).
ALTER TABLE titles ADD COLUMN tmdb_id INTEGER;
ALTER TABLE titles ADD COLUMN tmdb_type TEXT CHECK (tmdb_type IN ('movie', 'tv'));

-- Where the poster/backdrop came from and the responsive sizes available:
-- {source: 'lumina'|'tmdb'|'upload'|'manual', posterSet: [{url, w}], backdropSet: [{url, w}],
--  tmdb: {posterPath, backdropPath, matchedTitle, matchedYear, syncedAt}, locked: bool}
ALTER TABLE titles ADD COLUMN artwork TEXT NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS idx_titles_tmdb ON titles(tmdb_type, tmdb_id);

-- Cached metadata-provider responses (TMDB allows caching), so a sync does not ask twice.
CREATE TABLE IF NOT EXISTS metadata_cache (
  key        TEXT PRIMARY KEY,   -- provider + request path, without credentials
  body       TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);

-- Replace the generated placeholder key art from the first seed. Lumina Originals get key art
-- made from frames of the films themselves; the open movies lose their invented SVG art and
-- show the Lumina fallback until their real posters are synced from TMDB. Only rows that still
-- point at the original placeholder files are touched, so staff edits are kept.
UPDATE titles SET
  poster = 'assets/art/originals/hanami-poster-720.jpg',
  backdrop = 'assets/art/originals/hanami-backdrop-1920.jpg',
  artwork = '{"source":"lumina","locked":true,"posterSet":[{"url":"assets/art/originals/hanami-poster-360.jpg","w":360},{"url":"assets/art/originals/hanami-poster-720.jpg","w":720}],"backdropSet":[{"url":"assets/art/originals/hanami-backdrop-960.jpg","w":960},{"url":"assets/art/originals/hanami-backdrop-1920.jpg","w":1920}]}'
WHERE id = 'hanami' AND poster = 'assets/art/hanami-poster.svg';

UPDATE titles SET
  poster = 'assets/art/originals/koyo-autumn-pavilion-poster-720.jpg',
  backdrop = 'assets/art/originals/koyo-autumn-pavilion-backdrop-1920.jpg',
  artwork = '{"source":"lumina","locked":true,"posterSet":[{"url":"assets/art/originals/koyo-autumn-pavilion-poster-360.jpg","w":360},{"url":"assets/art/originals/koyo-autumn-pavilion-poster-720.jpg","w":720}],"backdropSet":[{"url":"assets/art/originals/koyo-autumn-pavilion-backdrop-960.jpg","w":960},{"url":"assets/art/originals/koyo-autumn-pavilion-backdrop-1920.jpg","w":1920}]}'
WHERE id = 'koyo-autumn-pavilion' AND poster = 'assets/art/koyo-autumn-pavilion-poster.svg';

UPDATE titles SET
  poster = 'assets/art/originals/garden-hours-poster-720.jpg',
  backdrop = 'assets/art/originals/garden-hours-backdrop-1920.jpg',
  artwork = '{"source":"lumina","locked":true,"posterSet":[{"url":"assets/art/originals/garden-hours-poster-360.jpg","w":360},{"url":"assets/art/originals/garden-hours-poster-720.jpg","w":720}],"backdropSet":[{"url":"assets/art/originals/garden-hours-backdrop-960.jpg","w":960},{"url":"assets/art/originals/garden-hours-backdrop-1920.jpg","w":1920}]}'
WHERE id = 'garden-hours' AND poster = 'assets/art/garden-hours-poster.svg';

UPDATE titles SET poster = NULL, backdrop = NULL, tmdb_type = 'movie', artwork = '{}'
WHERE id IN ('sintel', 'big-buck-bunny', 'tears-of-steel', 'elephants-dream')
  AND poster = 'assets/art/' || id || '-poster.svg';
