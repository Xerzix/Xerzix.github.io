# Lumina architecture and conventions

## Layout
```
index.html            SPA shell (served from the repository root; also works on GitHub Pages)
admin.html            Separate administration app (staff only)
css/                  tokens.css → base.css → components.css → catalog.css → app.css → garden.css → feature sheets
js/main.js            entry → js/app.js (route table, guards, appearance, garden)
js/core/              framework-free helpers; files marked "shared" also run on the server
  dom.js              h() element builder (never parses HTML), a11y helpers
  router.js           hash router; views export default async render(ctx) → Node
  session.js          session + library cache (My List ids, progress) + toggleList()
  bus.js store.js format.js i18n.js ratings.js text.js
  search.js similarity.js home-rows.js contrast.js   (shared with the server)
js/api/client.js      api.<area>.<method>(); ApiError, ServerRequiredError
js/api/static-backend.js  Preview mode (static hosting) backend
js/ui/                components.js card.js carousel.js hero.js header.js footer.js icons.js avatars.js panels/
js/views/             one module per route
js/player/            LuminaPlayer (hls.js / native HLS / progressive)
js/fx/                garden.js (SVG scene), petals.js (particles), intro.js
js/vendor/            vendored hls.js (npm run vendor:sync)
server/               Node ≥ 22.13, zero runtime dependencies
  index.js app.js config.js
  lib/                http.js (App/Context), validate.js, errors.js, security.js, crypto.js, static.js, log.js
  auth/session.js     session cookies + guards: requireAuth, requireProfile, requireCreator, requireStaff, requireAdmin
  db/                 index.js (node:sqlite wrapper), migrations/NNN_*.sql, cli.js
  services/           business logic (catalog, library, dto, audit, notifications, storage, mailer, entitlements, …)
  routes/             auto-loaded: export default function register(app, { db, services, config })
  seed/               catalog seed + Preview snapshot export
data/                 seed/catalog.seed.json (source), catalog.json (public snapshot for Preview mode)
media/                public Lumina Originals (HLS ladders)
content/legal/        draft legal documents (HTML fragments, trusted, same-origin)
tests/                unit/, server/ (node:test), e2e/ (Playwright)
```

## Backend conventions
- Route modules export `default function register(app, { db, services, config })`. A handler receives `ctx`: `ctx.params`, `ctx.query`, `await ctx.body()`, `ctx.account` (row), `ctx.profile` (row), `ctx.session`, `ctx.ip`. It returns a value (sent as JSON) or `undefined` (204). To fail, throw `HttpError` or one of the helpers in `lib/errors.js`.
- Put guards before the handler: `app.post('/api/x', requireProfile, rateLimit('x', {max, windowMs}), handler)`.
- **Validate every body** with `v.parse(schema, await ctx.body())`. Never trust ids that identify the caller. Use `ctx.account.id` and `ctx.profile.id`.
- **Authorization happens in SQL.** For example, `UPDATE reviews … WHERE id = ? AND account_id = ?`. Then check `changes`.
- Map rows to DTOs before returning them. Never return `password_hash`, `pin_hash`, `totp_secret` or `token_hash`.
- Wrap multi-statement writes in `db.tx(() => …)`, which is synchronous.
- **Schema changes are new migration files.** Each feature area owns a numbered range:
  - 010–019: accounts
  - 020–029: community and creators
  - 030–039: administration and notifications
  - 040–049: playback
  - 050–059: discovery
  - 060–069: Velvia

  Never edit an applied migration.
- Log with `log.info/warn/error(msg, fields)`. Never log secrets, tokens, passwords or request bodies.
- Every privileged action calls `audit(db, ctx, 'area.action', { targetType, targetId, details })`.
- Services shared between route modules: `services.catalog`, `services.library`. Any other module should import what it needs directly and create its own service (`services.reviews ??= new ReviewService(db)` keeps one instance).

## Frontend conventions
- **Never use `innerHTML` with data.** Build DOM with `h()`. Strings become text nodes automatically. `href`/`src` go through a URL safety check. The only trusted HTML is the same-origin legal content.
- A view is `export default async function render(ctx)`. `ctx` provides `params`, `query` (URLSearchParams), `setTitle`, `onDestroy(fn)`, `signal` (aborted on navigation) and `navigate`. The view returns one root Node, normally `h('div', { class: 'lm-page lm-container' }, …)`, with exactly one `<h1>`.
- Talk to the backend only through `api.*`. In Preview mode, catch `ServerRequiredError` (or rely on the `server: true` route flag) and render `serverRequired(feature)`.
- Use the component library (`js/ui/components.js`, `card.js`, `carousel.js`) and the CSS classes documented in `docs/DESIGN_SYSTEM.md`. Do not introduce new colours. Use tokens (`var(--lm-…)`).
- **Accessibility:**
  - Every interactive element is a real `<button>` or `<a>`.
  - Visible labels, or `aria-label` for icon-only buttons.
  - Dialogs use `openModal()`.
  - Announce async results with `announce()` or toasts.
  - Respect `prefersReducedMotion()`.
- For every loading, empty and error path, use the `loading()`, `emptyState()` and `errorState(err, { retry })` components.

## Security model (summary)
- Passwords use scrypt (N=2^15, r=8, p=1). Profile PINs use the same hashing. TOTP secrets are encrypted with AES-256-GCM.
- Sessions use random 256-bit tokens in an HttpOnly, SameSite=Lax cookie (Secure in production). Only a SHA-256 of each token is stored. Expiry slides with activity.
- CSRF protection: the `X-Lumina-Request` header plus an Origin check on every mutation.
- Staff routes require a role **and** a re-authentication within the last 15 minutes. Admins can be required to use TOTP (`ADMIN_REQUIRE_2FA=true`).
- Private media is served through HMAC-signed, expiring URLs. Uploads are stored outside the web root, validated by magic bytes and probed. Malware scanning is available through `UPLOAD_SCAN_COMMAND`.
- CSP: `script-src 'self'` (no inline scripts). Media origins come from an allowlist (`MEDIA_ORIGINS`).
