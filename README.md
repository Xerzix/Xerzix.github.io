# Lumina

**A streaming garden for film and television.** Lumina is a premium streaming platform with a Japanese temple-garden identity: a black and velvet-red interface, animated cherry-blossom environments, a cinematic opening, and **Velvia Suggestions**, a movie concierge grounded in the catalog.

- **Runs two ways**
  - **With the Lumina server:** full platform — accounts, five profiles per account, reviews, creator uploads, administration, notifications and watch parties.
  - **On static hosting (GitHub Pages) as *Preview mode*:** browse, search, detail pages and playback of the open catalog, with My List, progress and appearance kept on the device. Account features say plainly that they need the server.
- **Build-free:** vanilla ES modules and CSS custom properties.
- **Zero runtime npm dependencies on the server:** Node's built-in `node:http` and `node:sqlite`. `@anthropic-ai/sdk` is optional and loaded only when Velvia is configured to use Claude.

## Quick start

```bash
# Node 22.13+ (node:sqlite)
npm install                 # dev tools (Playwright for e2e, hls.js for vendoring) + optional Anthropic SDK
npm start                   # http://localhost:8080  (creates var/lumina.db and seeds the catalog)
npm run admin:create -- you@example.com   # prompts for a password; creates an administrator
```

Open http://localhost:8080. The intro plays on the first visit only; Settings → About can replay it. The admin dashboard is at `/admin.html`: sign in as an admin, then confirm your password.

For **Preview mode**, serve the repository root with any static file server (GitHub Pages does this). The frontend detects that `/api` is missing and switches modes on its own.

## Scripts

| Command | What it does |
|---|---|
| `npm start` / `npm run dev` | Start the server (`dev` restarts on file changes) |
| `npm test` | Unit + server integration tests (node:test) |
| `npm run test:e2e` | Browser tests with Playwright (Chromium) |
| `npm run db:migrate` / `db:seed` | Apply migrations / seed an empty catalog |
| `npm run admin:create -- <email>` | Create or promote an administrator |
| `npm run catalog:export` | Write `data/catalog.json` (the Preview-mode snapshot) from the database |
| `npm run media:sample` | Render and encode the Lumina Originals (needs `FFMPEG_PATH`) |
| `npm run media:verify [-- --write]` | Read the stream manifests of seed titles and record their real renditions |
| `npm run art:build` | Regenerate the key-art SVGs |
| `npm run worker` | Run the transcoding worker as a separate process |
| `npm run vendor:sync` | Copy hls.js from node_modules into `js/vendor/` |
| `npm run perf:baseline` | Measure LCP, CLS and click latency of the home and title pages (desktop and throttled phone) |

## Configuration
Every setting comes from environment variables or a `.env` file (see **`.env.example`**, which documents each one). Production needs at least:

```
NODE_ENV=production
SESSION_SECRET=<openssl rand -hex 32>
PUBLIC_URL=https://your-domain
```

Optional integrations (each degrades gracefully when absent):

| Variable | Enables |
|---|---|
| `VELVIA_PROVIDER=anthropic` + `VELVIA_API_KEY` | Claude-powered conversation for Velvia. The built-in catalog engine is used otherwise, and as the fallback. |
| `MAIL_TRANSPORT=webhook` + `MAIL_WEBHOOK_URL` | Password-reset and security email. In development, mail goes to the server log. |
| `FFMPEG_PATH`, `FFPROBE_PATH` | Transcoding creator uploads into HLS ladders, and detailed media probing |
| `UPLOAD_SCAN_COMMAND` | Malware scanning of uploads (e.g. ClamAV) |
| `TMDB_API_TOKEN` | Admin-only metadata import from TMDB |

## Database
SQLite through `node:sqlite`, stored in `var/lumina.db`, with WAL mode and foreign keys on. Migrations are the numbered SQL files in `server/db/migrations/`. They are applied automatically at startup, or with `npm run db:migrate`. To change the schema, add a new file; never edit an applied one. For multiple instances, port the SQL to PostgreSQL (the queries are standard).

## Documentation
- `docs/AUDIT.md`: phase 1 audit of the original site and the decisions it led to
- `docs/ARCHITECTURE.md`: layout and code conventions
- `docs/DESIGN_SYSTEM.md`: tokens and components
- `docs/API.md`: HTTP API reference
- `docs/STREAMING.md`: media pipeline and **what production 4K requires**
- `docs/SECURITY.md`: security model and production checklist
- `docs/MONETIZATION.md`: how subscriptions or ads would plug in (none are active)

## Status and next steps
*Last updated 2026-10-09.*

**Built and covered by tests**
- Discovery: home rows, personalised Discover, browse, genres, typo-tolerant search with filters (including country and language by name), My List, history and collections.
- Player: HLS with adaptive quality, subtitles, resume, watch parties, and playback-quality reports.
- Accounts: profiles and parental controls, two-factor sign-in, sessions, appearance and accessibility settings.
- Velvia Suggestions: built-in catalog engine, with an optional Claude provider.
- Community: reviews, creator applications and submissions, resumable uploads and the transcoding pipeline.
- Admin dashboard: notifications (including follows of series, genres and creators), curated genres and editorial collections, and draft legal pages.

**Tests:** `npm test` passes 300 of 308 tests. The other 8 are ffmpeg integration tests, which are skipped unless `FFMPEG_PATH` is set. `npm run test:e2e` passes 57 of 57 in Chromium.

**Known gaps**
- **Phone page load misses its target.** Measured LCP is about 6 s on an emulated mid-range phone, against a 2.5 s target. Text assets are served uncompressed and 13 stylesheets load up front. Measurements and causes are in `docs/STREAMING.md` §4.
- **Streaming metrics are not measured.** Time to first frame and rebuffering need real devices and the production telemetry. This test Chromium cannot decode H.264.
- **External services are not connected:** email delivery, malware scanning, payments, DRM, and multi-instance pub/sub (see `docs/AUDIT.md` §6). Velvia's AI conversation needs an API key; otherwise the built-in engine answers.
- **Legal pages are drafts** awaiting legal review.
- **Legacy pages still contain hard-coded credentials.** `watch.html`, `media.html` and `stream.html` should be removed and their credentials rotated.

**Recommended next phase**
1. Turn on Brotli or gzip at the CDN, split CSS by route, then measure again on real Android and iOS devices.
2. Move media to object storage behind a CDN, using a managed transcoder (`docs/STREAMING.md` checklist).
3. Connect a mail provider and a malware scanner. Then run a security review against `docs/SECURITY.md`.
4. Move to PostgreSQL and Redis before running more than one server instance.
5. Complete the legal review, then decide on monetisation (`docs/MONETIZATION.md`).

## Content and licensing
- The seed catalog contains four **Blender Foundation open movies** (Creative Commons Attribution). They are streamed from public hosts, and each title page shows its attribution.
- It also contains **Lumina Originals**: Hanami, Kōyō and the series Garden Hours. These were rendered from Lumina's own garden artwork by `npm run media:sample`. Hanami is a true 3840×2160 master and is the only title offered in 4K.
- Key art is original and generated by `scripts/make-artwork.mjs`.
- Fonts (Cormorant Garamond, Inter) are self-hosted under the SIL Open Font License.
- hls.js is Apache-2.0.

The pages in `content/legal/` are **drafts for legal review**, not documents in effect.

## Legacy files
`watch.html`, `media.html` and `stream.html` are from the site's previous version. They play third-party embeds from unlicensed sources and contain hard-coded API credentials. Lumina does not use or serve them. **Removing them and rotating those credentials is recommended**; see `docs/AUDIT.md`.
