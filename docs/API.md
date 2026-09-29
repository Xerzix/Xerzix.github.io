# Lumina HTTP API

JSON over HTTPS, same-origin, cookie session. The browser client lives in `js/api/client.js`: every endpoint below has a matching `api.<area>.<method>()` there. Preview mode (static hosting) implements the catalog and library subset in `js/api/static-backend.js`.

## Conventions

- **Mutations** (POST, PUT, PATCH, DELETE) must send the `X-Lumina-Request: 1` header. When the `Origin` header is present, it must be the site's own origin. Requests that break either rule get `403 CSRF_REJECTED`.
- **Errors** return `{ "error": { "code": "STRING", "message": "Human readable", "fields"?: { "name": "problem" }, "retryAfter"?: seconds } }`.
  Common codes: `UNAUTHENTICATED` 401, `FORBIDDEN` 403, `REAUTH_REQUIRED` 403, `PROFILE_REQUIRED` 409, `NOT_FOUND` 404, `VALIDATION_FAILED` 422, `RATE_LIMITED` 429, `CONFLICT` 409, `PROFILE_LIMIT` 409, `PROFILE_RESTRICTED` 403, `INTERNAL` 500 (includes a `requestId` only).
- **Timestamps** are ISO-8601 UTC strings.
- **Paging:** `?page=1&pageSize=24` returns `{ items, total, page, pageSize }`.
- **Guards** (see `server/auth/session.js`):
  - *public*: no guard.
  - *account*: `requireAuth`.
  - *profile*: `requireProfile`. Uses the active profile (`ctx.profile`) and never a profile id supplied by the client.
  - *creator*: `requireCreator`.
  - *staff*: `requireStaff`, which means moderator or admin **plus** a recent re-authentication.
  - *admin*: `requireAdmin`, which means admin plus a recent re-authentication.
- **Validation:** every write validates with `server/lib/validate.js`. Unknown keys are dropped.

## Shapes

**TitleSummary**: `{ id, type: 'movie'|'series', title, originalTitle, tagline, synopsis, year, releaseDate, runtimeMin, ageRating, ratingSource: 'official'|'advisory', minAge, genres[], tags[], moods[], keywords[], countries[], originalLanguage, directors[], cast[] (names), awards[], poster, backdrop, palette[], resolutions[] (verified heights, desc), quality: '4K'|'HD'|'SD'|null, hdr, audioLanguages[], subtitleLanguages[], hasSubtitles, audioFormats[], seasonCount, episodeCount, playable, hasTrailer, memberRating: {average, count}|null, featured, editorialRank, status, addedAt, publishedAt }`

**TitleDetail**: TitleSummary plus `{ credits: {directors[], cast[{name, role?}], crew[{name, job}]}, license: {name, url?, attribution, source?}, trailerMediaId, creator: {name}|null, seasons: [{ number, name, synopsis, year, episodes: [Episode] }] }`

**Episode**: `{ id, seasonNumber, number, name, synopsis, runtimeMin, still, airDate, hasMedia }`

**Playback**: `{ titleId, title: TitleSummary, episode: Episode|null, media: { id, kind: 'hls'|'dash'|'progressive', src, fallbacks: [{kind, src}], variants: [{height, src, bitrateKbps?}], resolutions[], verified, audioTracks: [{lang, label, kind, default}], subtitleTracks: [{lang, label, kind: 'subtitles'|'captions', src, default}], audioFormats[], hdr, durationS, introStart, introEnd, creditsStart }, next: Episode|null, previous: Episode|null, resumeAt }`

**Profile**: `{ id, name, avatar, isKids, maxAge|null, hasPin, uiLanguage, audioLanguage, subtitleLanguage, subtitlesDefault, autoplayNext, autoplayPreviews, preferences: {appearance, subtitles, playback, home, privacy}, createdAt }` (defaults in `server/services/dto.js`).

**Account**: `{ id, email, displayName, role: 'member'|'moderator'|'admin', isCreator, status, totpEnabled, emailVerified, maxProfiles, createdAt }`

## Session & health
| Method | Path | Guard | Response |
|---|---|---|---|
| GET | `/api/health` | public | `{status, service:'lumina', uptimeS}` |
| GET | `/api/session` | public | `{mode:'server', account, profile, profileCount, elevated, plan, features, limits:{maxProfiles}}` |

## Catalog (public; parental limits apply when a profile is active)
| GET | `/api/home` | `{featured: TitleSummary[], rows: [{id, title, subtitle?, href?, variant?, items: [{title: TitleSummary, progress?, episode?, positionS?, durationS?, reason?, upNext?}]}]}` |
|---|---|---|
| GET | `/api/titles?type&genres&tags&sort&page&pageSize…` | paged TitleSummary search without a query |
| GET | `/api/titles/:id` | TitleDetail |
| GET | `/api/titles/:id/similar` | `{items: TitleSummary[]}` |
| GET | `/api/genres` | `{genres: [{name, count}]}` |
| GET | `/api/search?q&type&genres&tags&yearFrom&yearTo&runtimeMin&runtimeMax&ageRatings&language&subtitles&country&resolution&minRating&recent&sort&page&pageSize` | `{query, sort, total, page, pageSize, items: TitleSummary+{match}, facets: {type, genres, languages, subtitles, decades, ageRatings, resolutions}, didYouMean}` |
| GET | `/api/search/suggest?q` | `{suggestions: [{kind:'title'|'person'|'genre', id?, label, sub, poster?}]}` |
| GET | `/api/playback/:titleId?episodeId&role=trailer` | Playback (402 `ENTITLEMENT_REQUIRED` in paid modes, 404 `MEDIA_UNAVAILABLE`) |
| GET | `/api/discover` | `{sections: [{id, title, description?, items: [{title}]}]}` (personalised discovery page) |

## Library (profile)
| GET | `/api/library/summary` | `{watchlistIds[], progress: {[titleId]: {episodeId, positionS, durationS, completed, updatedAt}}, ratings: {[titleId]: 1-5}}` |
|---|---|---|
| GET | `/api/library/watchlist` | `{items: [{titleId, addedAt, sortOrder, title}]}` |
| PUT / DELETE | `/api/library/watchlist/:titleId` | `{ok}` |
| PUT | `/api/library/watchlist-order` `{titleIds[]}` | `{ok}` |
| GET | `/api/library/continue` | `{items: [{titleId, episodeId, positionS, durationS, episode, title}]}` |
| GET | `/api/library/title-progress/:titleId` | `{items: [{titleId, episodeId, positionS, durationS, completed, updatedAt}]}` |
| PUT | `/api/library/progress` `{titleId, episodeId?, positionS, durationS?, completed?, watchedDelta?}` | `{completed, positionS, durationS, updatedAt}` |
| POST | `/api/library/watched` `{titleId, episodeId?}`; DELETE `/api/library/watched/:titleId` | `{ok}` |
| GET | `/api/library/history?page` | `{items: [{id, titleId, episodeId, episode, watchedAt, seconds, title}], total, page, pageSize}` |
| DELETE | `/api/library/history/:id` · DELETE `/api/library/history` (clear) | `{ok}` |
| GET | `/api/library/stats` | `{enabled, totalSeconds, titlesWatched, episodesWatched, moviesWatched, completedSeries: [TitleSummary], topGenres: [{genre, seconds}], recent: [{title, watchedAt}], favorites: [TitleSummary], monthly: [{month:'YYYY-MM', seconds}]}` |
| GET / POST | `/api/collections` · `{name, description, visibility:'private'|'unlisted'}` | `{items: [{id, name, description, visibility, itemCount, previews: TitleSummary[], shareUrl?}]}` / `{collection}` |
| GET / PATCH / DELETE | `/api/collections/:id` | `{collection: {..., items: [{titleId, addedAt, position, note, title}]}}` |
| PUT / DELETE | `/api/collections/:id/items/:titleId` | `{ok}` |
| GET | `/api/shared/collections/:token` (public) | `{collection}` (unlisted only; owner shown as profile name) |
| GET / PUT / DELETE | `/api/follows` · `/api/follows/:type/:id` (`series`\|`creator`\|`genre`) | `{items:[{type, id, createdAt}]}` / `{ok}` |

## Auth & account
| POST | `/api/auth/register` `{email, password, displayName, acceptTerms: true}` | public, rate limited | session payload; creates the first profile |
|---|---|---|---|
| POST | `/api/auth/login` `{email, password, totp?}` | public, rate limited | session payload · 401 `INVALID_CREDENTIALS` · 401 `TOTP_REQUIRED` · 423 `ACCOUNT_LOCKED` · 403 `ACCOUNT_SUSPENDED` |
| POST | `/api/auth/logout` | account | 204 |
| POST | `/api/auth/forgot` `{email}` | public | 202 always (no account enumeration) |
| POST | `/api/auth/reset` `{token, password}` | public | 200; revokes every session |
| POST | `/api/auth/elevate` `{password, totp?}` | account | `{elevatedUntil}` |
| PATCH | `/api/account` `{displayName?, email?, currentPassword (required for email)}` | account | `{account}` |
| POST | `/api/account/password` `{currentPassword, newPassword}` | account | `{ok}`; revokes other sessions |
| GET / DELETE | `/api/account/sessions` · `/api/account/sessions/:id` · DELETE `/api/account/sessions` (all others) | account | `{items: [{id, current, userAgent, ip, createdAt, lastSeenAt}]}` |
| POST | `/api/account/2fa/setup` (elevated) → `{secret, otpauthUrl}` · `/2fa/enable {code}` · `/2fa/disable {password, code}` | account | |
| DELETE | `/api/account` `{password, confirm: 'DELETE'}` | account | 204; deletes all personal data |
| GET | `/api/account/export` | account | JSON download of personal data |
| GET | `/api/account/plan` | account | `{mode, plan, billing, cancellable}` |

## Profiles (account)
| GET | `/api/profiles` | `{profiles: Profile[], max}` |
|---|---|---|
| POST | `/api/profiles` `{name, avatar, isKids?, maxAge?, uiLanguage?, …}` | `{profile}` · 409 `PROFILE_LIMIT` `{max}` |
| PATCH | `/api/profiles/:id` (`pin` is required when the profile has a PIN and is not the verified active profile) | `{profile}` |
| DELETE | `/api/profiles/:id` `{pin?}` | 204; the last profile cannot be deleted |
| POST | `/api/profiles/:id/select` `{pin?}` | `{profile}` · 403 `PIN_REQUIRED` / `PIN_INVALID` |
| PUT | `/api/profiles/:id/pin` `{pin: '1234'|null, currentPin?}` | `{profile}` |
| PUT | `/api/profiles/:id/preferences` `{preferences: partial}` | `{profile}` (deep-merged) |

## Community
| GET | `/api/titles/:id/reviews?sort=helpful|newest|highest|lowest&page` | public | `{items: Review[], summary: {average, count, distribution: {1..5}}, mine: Review|null, total, page, pageSize}` |
|---|---|---|---|
| POST | `/api/titles/:id/reviews` `{rating 1-5, body?, containsSpoilers?}` | profile, rate limited | `{review}` · 409 when one exists |
| PATCH / DELETE | `/api/reviews/:id` | author only | `{review}` / 204 |
| PUT / DELETE | `/api/reviews/:id/helpful` | account (not the author) | `{helpfulCount, voted}` |
| GET / POST | `/api/reviews/:id/comments` `{body}` | public / profile | `{items: Comment[]}` / `{comment}` |
| DELETE | `/api/comments/:id` | author | 204 |
| POST | `/api/reports` `{targetType:'review'|'comment'|'collection', targetId, reason, details?}` | account, rate limited | `{ok}` |
| GET / POST / DELETE | `/api/blocks` `{reviewId}` · `/api/blocks/:id` | account | blocked authors are hidden from your review lists |

Review: `{ id, titleId, rating, body, containsSpoilers, status, author: {name, avatar}, isMine, helpfulCount, votedHelpful, commentCount, createdAt, updatedAt, edited }`

## Playback quality & telemetry
| POST | `/api/quality-reports` `{titleId, episodeId?, category, description?, device?, connectionMbps?, selectedResolution?, diagnostics?}` | account, rate limited |
|---|---|---|
| GET | `/api/titles/:id/quality` | public: `{window:'90d', reports: {count, distinctReporters, categories:[{category,count}], sufficient}, measured: {sessions, rebufferRatio, avgBitrateKbps, errorRate, medianStartupMs, sufficient}}`. Reported (subjective) and measured (player telemetry) data are always kept apart. |
| POST | `/api/playback/sessions` `{sessionId, mediaId, titleId, episodeId?, secondsWatched, startupMs?, rebufferCount, rebufferSeconds, avgBitrateKbps?, maxHeight?, droppedFrames?, bytesEstimate?, errorCount}` | public (account attached when signed in) |
| POST | `/api/playback/errors` `{mediaId, titleId, episodeId?, code, message, fatal, details?}` | public, rate limited |

## Velvia Suggestions
| GET | `/api/velvia/status` | `{provider, available, model, grounded: true}` |
|---|---|---|
| POST | `/api/velvia/chat` `{messages: [{role:'user'|'assistant', content}], context: {titleId?, compareIds?[]}, options: {useHistory: bool}}` | `{reply, recommendations: [{titleId, reason, title: TitleSummary}], clarifyingQuestion?, suggestions: string[], provider, fallback: bool}`. Only catalog titles can be recommended; the server drops any id that is not in the catalog. |

## Creators & uploads
| GET | `/api/creators/me` | account | `{isCreator, application|null}` |
|---|---|---|---|
| POST | `/api/creators/applications` `{legalName, contactEmail, company?, website?, portfolio?, country?, bio}` | account | `{application}` |
| GET / POST | `/api/creators/submissions` | creator | `{items}` / `{submission}` (draft) |
| GET / PATCH / DELETE | `/api/creators/submissions/:id` | owner (admins use the admin API) | `{submission, files, events}` |
| POST | `/api/creators/submissions/:id/attest` `{rights: {copyrightOwner, distributionRights, territories[], restrictions?, musicCleared, footageCleared, documentationNotes?}, confirm: true}` | owner | `{submission}` |
| POST | `/api/creators/submissions/:id/submit` · `/respond {message}` | owner | `{submission}` |
| DELETE | `/api/creators/submissions/:id/files/:fileId` | owner (draft or info_required) | 204 |
| GET | `/api/creators/titles` | creator | published titles from the creator's submissions, with stats |
| POST | `/api/uploads` `{filename, size, mime, purpose:'submission', submissionId, role}` | creator | `{id, offset: 0, chunkSize, expiresAt}` |
| HEAD / GET | `/api/uploads/:id` | owner | `Upload-Offset` header / `{offset, size, status}` |
| PATCH | `/api/uploads/:id` (`Content-Type: application/offset+octet-stream`, `Upload-Offset`) | owner | 204 + `Upload-Offset`. When complete, the file is validated (type, size, magic bytes, media probe) and attached. |
| DELETE | `/api/uploads/:id` | owner | 204 |

Submission statuses: `draft → uploading → submitted → under_review → info_required ↔ submitted → approved → published`, or `rejected`. Only the admin API moves a submission past `submitted`. Nothing is published automatically.

## Notifications (account)
| GET | `/api/notifications?page` | `{items: [{id, type, title, body, link, createdAt, readAt}], unread, total}` (includes active announcements) |
|---|---|---|
| GET | `/api/notifications/unread-count` | `{unread}` |
| POST | `/api/notifications/:id/read` · `/api/notifications/read-all` · DELETE `/api/notifications/:id` | `{ok}` |
| GET / PUT | `/api/notifications/preferences` | `{newEpisodes, genreReleases, creatorReleases, submissionUpdates, reviewReplies, announcements}` (optional types only) |

## Watch parties (profile; single-instance, in-memory)
| POST | `/api/parties` `{titleId, episodeId?}` | `{code, party}` |
|---|---|---|
| GET | `/api/parties/:code` · POST `/join` · POST `/leave` · DELETE (host ends) | `{party: {code, host, titleId, episodeId, state: {playing, position, updatedAt}, members: [{name, avatar}], allowGuestControl}}` |
| POST | `/api/parties/:code/control` `{action:'play'|'pause'|'seek'|'episode', position, episodeId?}` | host, or guests when allowed |
| POST | `/api/parties/:code/chat` `{text}` | member |
| GET | `/api/parties/:code/events` | Server-Sent Events: `state`, `chat`, `members`, `ended` |

## Administration (staff; admin-only rows are marked)
All admin routes are under `/api/admin/*`. Every mutation writes an audit log entry.
- `GET /api/admin/overview`: counts, open queues, health summary
- Titles: `GET/POST /api/admin/titles`, `GET/PATCH/DELETE /api/admin/titles/:id`, `POST /api/admin/titles/:id/publish|unpublish`, seasons and episodes (`POST /api/admin/titles/:id/seasons`, `PATCH/DELETE /api/admin/seasons/:id`, `POST /api/admin/titles/:id/episodes`, `PATCH/DELETE /api/admin/episodes/:id`)
- Media: `GET/POST /api/admin/media`, `PATCH/DELETE /api/admin/media/:id`, `POST /api/admin/media/:id/verify` (the server reads the manifest or file and records the real renditions and tracks), `POST /api/admin/media/:id/transcode`
- Artwork: `POST /api/admin/artwork` (image upload through the uploads API with `purpose:'artwork'`)
- TMDB (metadata only): `GET /api/admin/tmdb/search?q&type`, `GET /api/admin/tmdb/:type/:id`
- Taxonomy: `GET/PUT /api/admin/taxonomy` (genres and editorial collections)
- Creators: `GET /api/admin/creator-applications?status`, `POST /api/admin/creator-applications/:id/decision {decision, note}`
- Submissions: `GET /api/admin/submissions?status`, `GET /api/admin/submissions/:id`, `POST /api/admin/submissions/:id/status {status, message}`, `POST /api/admin/submissions/:id/publish`, `GET /api/admin/submissions/:id/files/:fileId/url` (signed, short-lived)
- Moderation: `GET /api/admin/reports?status`, `POST /api/admin/reports/:id/resolve {action: dismiss|hide|remove|suspend_author, note}`, `GET /api/admin/reviews?status&q`, `PATCH /api/admin/reviews/:id {status, note}`, `GET /api/admin/moderation/history`
- Users *(role changes are admin only)*: `GET /api/admin/users?q&role&status`, `GET/PATCH /api/admin/users/:id {role?, status?, suspendedReason?, suspendedUntil?, maxProfiles?, isCreator?}`, `POST /api/admin/users/:id/revoke-sessions`
- Platform: `GET /api/admin/health`, `GET /api/admin/logs?level&limit&q`, `GET /api/admin/playback-errors`, `GET /api/admin/quality-reports`, `GET /api/admin/audit?actor&action&page`, `GET/PUT /api/admin/settings` *(admin)*, `GET/POST /api/admin/announcements`, `DELETE /api/admin/announcements/:id`, `GET /api/admin/usage` (storage in use, estimated bandwidth from playback telemetry)

Private media: `/media/private/<key>?exp&sig` returns an HMAC-signed, expiring, directory-scoped grant (`server/services/storage.js`).
