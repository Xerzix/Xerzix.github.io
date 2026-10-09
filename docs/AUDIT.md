# Phase 1 — Project Audit

_Audit of the repository as it existed at commit `a40ce08` (before the Lumina redesign)._

## 1. What the project was

| Area | Finding |
| --- | --- |
| Hosting | GitHub Pages user site (`xerzix.github.io`). Static files only: no server, no build step. |
| Frontend framework | None. Vanilla HTML, CSS and JavaScript. `watch.html` and `media.html` load the Tailwind Play CDN at runtime. |
| Files | `index.html` (1,000 lines, including about 450 lines of inline script), `script.js` (1,878), `style.css` (6,346), `watch.html` (664), `media.html` (1,046), `stream.html` (980). |
| Backend | None. |
| Database | None. All state lives in `localStorage`: `watchLater`, `watchProgress_*`, `watchTime_*`, `lastClicked_*`, `lastWatched-*`, `luminaSettings`, `accentColor`, and about a dozen `hide*` and feature flags. |
| Authentication | None in practice. `checkToken()` could compare a typed token against a **public** JSON file on GitHub and store the matching name in `localStorage`. The modal call was already disabled. |
| Metadata | TMDB v3 API (Bearer token **hard-coded three times** in client code) and OMDb (API key **hard-coded** in client code). |
| Video playback | `watch.html` and `media.html` call Cloudflare Workers at `*.rspxyum.workers.dev`. Those workers scrape a third-party embed page, pull an `/rcp/` path out of it and load `cloudnestra.com/rcp/...` in an iframe. The site then controls that iframe with `postMessage(..., '*')`. |
| Routing | Separate HTML pages with query strings (`watch.html?id=tt…`, `media.html?id=…&season=…&episode=…`, `stream.html?imdb=…`). |
| Deployment config | None beyond GitHub Pages defaults. No CI, no tests, no package manifest. |

### Features that genuinely worked
- Browse TMDB discover results by type, year and genre. Trending row. Genre chips.
- Search across movies and TV (TMDB search plus a local relevance-scoring pass).
- "Continue Watching" built from saved progress, ordered by most recent activity.
- "Watch Later" bookmarks.
- Previous/next episode navigation and a season/episode picker (`stream.html`).
- Settings: glass (translucent) mode, six accent colours, show/hide individual home rows, auto-play-next and save-progress flags, clear watch history, simple local statistics.
- A draggable developer console on the TV player.

### Features that did not work
- **10 settings toggles called functions that do not exist:** `toggleExtraAccentMods`, `toggleEnhancedAnimations`, `toggleDynamicBlur`, `togglePreload`, `toggleSkipIntro`, `toggleTheaterMode`, `toggleSmartRecommendations`, `toggleWatchParty`, `exportSettings` and `importSettings`.
- Watch Party, Community and Authentication showed "coming soon" alerts.
- The Community modal displayed fabricated figures ("101.7K+ members", "28.6K+ posts").

## 2. Security and reliability findings

1. **Hard-coded credentials in public client code.** The TMDB read token and the OMDb key are in `script.js`, `media.html`, `stream.html` and `watch.html`. They are in public git history, so they should be **rotated**.
2. **DOM XSS.** API strings (titles, overviews, posters) are interpolated into `innerHTML` and into inline `onclick="…('${title}')"` handlers. Only single quotes are escaped.
3. **Untrusted third-party iframes** with no sandbox, controlled with `postMessage('*')`. The embed hosts are ad-supported scraper sites.
4. **No authentication or authorization of any kind.** The "token" list is world-readable.
5. **Accessibility:** `user-scalable=no, maximum-scale=1` disables zoom, and `user-select: none` is applied globally. Most controls are `div`/`span` elements with `onclick` and no keyboard support. There are no focus styles.
6. **Performance:** every card makes 2–3 sequential network calls (TMDB external IDs plus OMDb). `setInterval` re-renders "Continue Watching" every 3 seconds.

## 3. The streaming source: a decision

The only working playback path loads **unlicensed copies of commercial films and series** through scraper embed hosts. The site's own notice says so: *"Lumina displays content from third-party sources and does not host or control any media"*.

Lumina's brief requires authorized media: rights confirmation, "secure access to authorized media", and "do not imply that a movie has a language track that has not been … legally made available". That pipeline cannot meet those requirements and is also a security liability (item 3 above). **The new platform does not use it.** Specifically:

- The new app plays only media from its own catalog. That media is served from Lumina storage, from a configured CDN, or from openly licensed public sources, and every item carries its licence and attribution metadata.
- `watch.html`, `media.html` and `stream.html` were **left untouched** in the repository. The new app does not link to them. Removing them, and rotating the TMDB and OMDb credentials they contain, is recommended but is the owner's decision.
- TMDB is kept as a legitimate, **server-side, metadata-only** integration. Administrators can pre-fill title metadata from TMDB when they add licensed content. The token comes from an environment variable and is never sent to the browser.

## 4. What was retained, and how

| Legacy behaviour | Where it lives now |
| --- | --- |
| Continue Watching, ordered by most recent activity | Per-profile progress table, `Continue Watching` row |
| Watch Later bookmarks | Per-profile **My List**, plus custom collections |
| Local relevance scoring for search (exact > prefix > whole word > contains > all words > partial) | Ported into the shared search engine `js/core/search.js`, with typo tolerance and filters added |
| Type, year and genre filters and genre chips | Search filters and the Genres page |
| Glass mode | "Translucent surfaces" appearance option |
| Accent colour presets | The full theme system (presets plus a custom colour picker with contrast checks) |
| Hide individual home rows | Home layout settings |
| Auto-play next and save-progress flags | Playback settings, stored per profile |
| Clear watch history | Library → History (single entries or all) |
| Local statistics | Private viewing-statistics dashboard |
| Developer console | Player "Stats for nerds" diagnostics overlay |
| Announcement panel | Platform announcements delivered through notifications |
| Inter typeface | Kept for UI text and paired with a serif display face |

The old `index.html` UI, `script.js` and `style.css` were used only by the old home page. They are superseded by the new application and were removed. Their contents remain in git history.

## 5. What had to change

- **Architecture.** A static site cannot provide accounts, server-side authorization, reviews, uploads or moderation. The redesign adds a **zero-runtime-dependency Node.js server** (`node:http` + built-in `node:sqlite`) with migrations. The frontend stays build-free: vanilla ES modules, served from the repository root.
- **GitHub Pages keeps working.** When no API is reachable, the frontend runs in **Preview mode**. It supports browsing, search, detail pages and playback of the openly licensed catalog, with the watchlist and progress stored on the device. Account, community, creator and admin features clearly state that they need the Lumina server. Nothing is simulated.
- **Security baseline.** Passwords hashed with scrypt, HttpOnly session cookies, CSRF header and Origin checks, rate limiting, CSP and security headers, schema validation on every write, role-based access control with re-authentication and optional TOTP for administrators, signed media URLs, magic-byte validation of uploads.

## 6. Features that need external infrastructure

| Feature | Needs | Integration boundary in this repo |
| --- | --- | --- |
| Production 4K streaming | Object storage, transcoding capacity, CDN, bandwidth budget | `server/services/media/*`, `docs/STREAMING.md` |
| Transcoding | `ffmpeg`/`ffprobe` on the host (local worker), or a cloud transcoder | `FFMPEG_PATH`, `FFPROBE_PATH` |
| Password-reset email | A transactional mail provider | `MAIL_TRANSPORT=webhook` plus `MAIL_WEBHOOK_URL` (a dev log transport is built in) |
| Velvia AI conversation | An LLM provider (Anthropic or any OpenAI-compatible API) | `VELVIA_PROVIDER`, `VELVIA_API_KEY`. A built-in catalog-grounded engine is used when no provider is configured. |
| Malware scanning of uploads | ClamAV or a scanning API | `UPLOAD_SCAN_COMMAND` |
| TMDB metadata import | A TMDB API token | `TMDB_API_TOKEN` |
| Payments and subscriptions | A payment provider plus legal review | `server/services/entitlements.js` (free tier only; no payment collection) |
| Multi-instance watch parties | A pub/sub service (Redis or similar) | In-memory, single-instance implementation |
