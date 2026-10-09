# Security model

## Threats considered
- **Account takeover:** credential stuffing, weak passwords, stolen sessions.
- **Cross-site attacks:** XSS through catalog or user content, CSRF, clickjacking.
- **Broken access control:**
  - reading other profiles' history or other creators' submissions;
  - editing others' reviews;
  - reaching admin functions;
  - leaking unpublished or private media.
- **Malicious uploads:** wrong types, oversized files, path traversal, malware.
- **Abuse:** spam reviews, report flooding, brute force, AI-cost abuse.
- **Secret leakage:** keys in client code, and logs containing personal data.

## Controls

| Area | Control | Where |
|---|---|---|
| Passwords | scrypt (N=2^15, r=8, p=1, 64-byte key, per-user salt), timing-safe comparison, dummy hashing for unknown emails. Minimum 10 characters, common-password list, must not contain the email's local part. | `server/lib/crypto.js`, accounts service |
| Brute force | Per-IP and per-email rate limits, account lockout after repeated failures (counted atomically in the database, so parallel guesses all count), PIN-attempt limits | `server/lib/security.js`, auth and profile routes |
| Sessions | 256-bit random tokens; only SHA-256 hashes are stored. Cookies are HttpOnly, SameSite=Lax, and Secure in production. Expiry slides with activity. Users can list and revoke sessions. Every session is revoked on password reset. | `server/auth/session.js` |
| Staff access | Role-based (member / moderator / admin) plus a re-authentication ("sudo") window of `ELEVATED_MINUTES`. `ADMIN_REQUIRE_2FA` can require TOTP. The last admin cannot be removed or demoted. | `requireStaff`, `requireAdmin` |
| 2FA | TOTP (RFC 6238); secrets are encrypted at rest with AES-256-GCM (key derived from `SESSION_SECRET` via HKDF). Each code is accepted once: the last accepted time step is stored and older or equal steps are refused (RFC 6238 §5.2). | `server/lib/crypto.js`, accounts service |
| CSRF | Every mutation needs the custom `X-Lumina-Request` header, and any `Origin` present must match the site | `csrfGuard` |
| XSS | The DOM is built with `h()`, so strings always become text nodes. `href`/`src` go through a URL check (no `javascript:`). The only HTML is same-origin legal content, and it is sanitised. A unit test fails the build if `innerHTML` and similar calls appear in app code. | `js/core/dom.js`, `tests/unit/static-security.test.js` |
| CSP & headers | `script-src 'self'` (no inline scripts), `object-src 'none'`, `frame-ancestors 'none'`, a media-origin allowlist, nosniff, a strict referrer policy, COOP/CORP, and HSTS in production | `server/lib/security.js` |
| Authorization | Library data is scoped to the session's active profile, never to a client-supplied id. Writes filter by owner in SQL (`WHERE id = ? AND account_id = ?`). DTO mappers strip secrets. | routes and services |
| Parental controls | Per-profile `max_age` is enforced on the server for catalog, search, playback, home rows and Velvia. PINs protect profile entry and settings. While a kids or maturity-limited profile is active, profile management, maturity changes and account settings need the account password; each confirmation covers one change and ends when a restricted profile is selected. | `CatalogService`, profiles |
| Uploads | Stored outside the web root under random keys, with no path traversal (`safeJoin`). Types are checked by magic bytes, sizes are limited per role, and each offset is checked on resume. SHA-256 is recorded. Malware scanning runs through `UPLOAD_SCAN_COMMAND`. Private files are served only through expiring HMAC-signed URLs. | uploads service, `storage.js` |
| Static files | Only allowlisted top-level paths are served. `server/`, `var/`, `tests/`, `docs/`, `node_modules/`, dotfiles and `package.json` all return 404 (a test covers this). The allowlist is checked on the resolved file location, and `safeJoin` rejects any `.`/`..`/dotfile segment or NUL byte in the raw (already percent-decoded) path before normalising, so encoded traversal such as `/css/..%2fvar%2flumina.db` returns 404. Malformed request targets (`//`, broken percent-encoding) get a 400 and never reach the router, so a single bad request cannot crash the process. | `server/lib/static.js`, `server/lib/http.js` |
| Content moderation | Spam heuristics hold suspicious reviews for review. Content is auto-hidden after 3 independent reports. There is a moderation queue, suspensions (which revoke sessions) and an audit log of every staff action. | community and admin services |
| Secrets | Secrets come only from the environment or `.env` (gitignored). No API key is sent to the browser. Velvia provider keys stay server-side. | `server/config.js` |
| Logging | Structured JSON, never containing passwords, tokens or request bodies. Errors return a request id instead of a stack trace. | `server/lib/log.js`, `server/lib/http.js` |
| Privacy | Viewing history leaves the server only when the user opts in to history-based Velvia suggestions. Data export and account deletion are implemented. | account routes |

## Legacy code notice
The pre-Lumina files `watch.html`, `media.html` and `stream.html` remain in the repository untouched. They embed third-party players from unlicensed sources, and they contain **hard-coded TMDB and OMDb credentials**. Those credentials are in public git history, so rotate them. The Lumina server never serves these files; GitHub Pages still does. Removing them is recommended (see `docs/AUDIT.md`).

## Production checklist
- Set `NODE_ENV=production`, a strong `SESSION_SECRET` and `PUBLIC_URL`, and terminate TLS in front of the app (`TRUST_PROXY=true` behind a proxy).
- Enable `ADMIN_REQUIRE_2FA=true`. Create admins with `npm run admin:create`.
- Configure a mail transport, an upload scanner, backups of `var/` (database and storage), and log shipping.
- For multiple instances, move the rate limiter and watch-party rooms to Redis, and SQLite to PostgreSQL.
- Run `npm test` and `npm run test:e2e` in CI.
