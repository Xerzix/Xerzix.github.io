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

**TitleSummary**: `{ id, type: 'movie'|'series', title, originalTitle, tagline, synopsis, year, releaseDate, runtimeMin, ageRating, ratingSource: 'official'|'advisory', minAge, genres[], tags[], moods[], keywords[], countries[], originalLanguage, directors[], cast[] (names), awards[], poster, backdrop, posterSrcset?, backdropSrcset?, artworkSource: 'lumina'|'tmdb'|'upload'|'manual'|null, availability: 'stream'|'catalog', palette[], resolutions[] (verified heights, desc), quality: '4K'|'HD'|'SD'|null, hdr, audioLanguages[], subtitleLanguages[], hasSubtitles, audioFormats[], seasonCount, episodeCount, playable, hasTrailer, memberRating: {average, count}|null, featured, editorialRank, status, addedAt, publishedAt }`

**TitleDetail**: TitleSummary plus `{ credits: {directors[], cast[{name, role?}], crew[{name, job}]}, license: {name, url?, attribution, source?}, trailerMediaId, creator: {id|null, name}|null (`id` is the creator's account id to follow; null once creator access is removed), seasons: [{ number, name, synopsis, year, episodes: [Episode] }] }`

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
| GET | `/api/discover` | `{sections: [{id, title, description?, items: [{title, reason?}], creators?: [{id, name}]}]}` (personalised discovery page; `creators` on the creator-spotlight section lists the followable creators named in the row) |

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
| POST | `/api/auth/register` `{username, email, password, displayName?, avatar?, remember?, acceptTerms: true}` | public, rate limited | session payload; creates the account and its first profile and adds it to this device's identities · 409 `USERNAME_TAKEN` (unique, case-insensitive, enforced by the database) · 409 `EMAIL_TAKEN` · 409 `IDENTITY_LIMIT` (this device already lists five identities) · 422 `avatar` when another identity on this device uses that picture |
|---|---|---|---|
| POST | `/api/auth/login` `{identifier (username or email), password, totp?, remember?}` (`email` is still accepted) | public, rate limited | session payload; adds the account to this device's identities (`remember` keeps it switchable without a password for 30 days) · 409 `IDENTITY_LIMIT` · 401 `INVALID_CREDENTIALS` · 401 `TOTP_REQUIRED` · 401 `INVALID_TOTP` (`reused: true` when the code was already accepted once — each code works once) · 423 `ACCOUNT_LOCKED` · 403 `ACCOUNT_SUSPENDED` |
| POST | `/api/auth/logout` | account | 204; the identity stays on this device but needs its password next time |
| POST | `/api/auth/forgot` `{email}` | public | 202 always (no account enumeration) |
| POST | `/api/auth/reset` `{token, password}` | public | 200; revokes every session |
| POST | `/api/auth/elevate` `{password, totp?}` | account | `{elevatedUntil}`. While a restricted profile is active (see Profiles) the confirmation lasts at most 5 minutes and covers one parental-control change |
| PATCH | `/api/account` `{displayName?, username?, avatar?, email?, currentPassword (required for email)}` | account | `{account}` · 409 `USERNAME_TAKEN` · 422 `avatar` when another identity on this device uses it |
| POST | `/api/account/password` `{currentPassword, newPassword}` | account | `{ok}`; revokes other sessions |
| GET / DELETE | `/api/account/sessions` · `/api/account/sessions/:id` · DELETE `/api/account/sessions` (all others) | account | `{items: [{id, current, userAgent, ip, createdAt, lastSeenAt}]}` |
| POST | `/api/account/2fa/setup` (elevated) → `{secret, otpauthUrl}` · `/2fa/enable {code}` · `/2fa/disable {password, code}` | account | |
| DELETE | `/api/account` `{password, confirm: 'DELETE'}` | account | 204; deletes all personal data |
| GET | `/api/account/export` | account | JSON download of personal data |
| GET | `/api/account/plan` | account | `{mode, plan, billing, cancellable}` |

While a restricted profile is active, `PATCH /api/account`, the sessions list and revocations, `2fa/setup`, `GET /api/account/export` and `PUT /api/notifications/preferences` answer `403 PARENTAL_CONTROL` unless a grown-up has just confirmed the account password; endpoints that take the password in the request itself are unaffected. Display names and profile names are NFC-normalised, with control, zero-width and bidi-control characters removed and spaces collapsed.

## Identities ("Who's watching?")
An identity is a separate account (own username, password and data). A browser is recognised by the HttpOnly `lumina_device` cookie (random token; the server stores its SHA-256) and lists at most five identities; the database enforces the limit (`device_identities.slot` 0–4, unique per device).
| GET | `/api/identities` | public | `{max: 5, freeSlots, identities: [{id, slot, username, displayName, avatar, active, remembered, suspended}]}` — only identities used on this browser, only these public fields |
|---|---|---|---|
| POST | `/api/identities/switch` `{accountId, password?, totp?, remember?}` | public, rate limited | session payload for the chosen account: the current session is deleted and a new one created. 401 `PASSWORD_REQUIRED` unless the identity was remembered on this device · 401 `INVALID_CREDENTIALS` / `TOTP_REQUIRED` / `INVALID_TOTP` · 423 `ACCOUNT_LOCKED` (failures count towards the account lockout) · 404 `IDENTITY_NOT_FOUND` when the account is not on this device |
| DELETE | `/api/identities/:accountId` | public, rate limited | the updated list; takes the identity off this browser only (the account is kept). Removing the signed-in identity also signs it out here |

## Profiles (account)
| GET | `/api/profiles` | `{profiles: Profile[], max}` |
|---|---|---|
| POST | `/api/profiles` `{name, avatar, isKids?, maxAge?, uiLanguage?, …}` | `{profile}` · 409 `PROFILE_LIMIT` `{max}` |
| PATCH | `/api/profiles/:id` (`pin` is required when the profile has a PIN and is not the verified active profile) | `{profile}` |
| DELETE | `/api/profiles/:id` `{pin?}` | 204; the last profile cannot be deleted |
| POST | `/api/profiles/:id/select` `{pin?}` | `{profile}` · 403 `PIN_REQUIRED` / `PIN_INVALID` |
| PUT | `/api/profiles/:id/pin` `{pin: '1234'|null, currentPin?}` | `{profile}` |
| PUT | `/api/profiles/:id/preferences` `{preferences: partial}` | `{profile}` (deep-merged) |

Parental controls: a profile is *restricted* when it is a kids profile or has a maturity limit (`maxAge`). While one is the session's active profile, creating or deleting profiles, editing other profiles, setting PINs and any maturity change answer `403 PARENTAL_CONTROL` — the profile's own PIN does not count. A grown-up's `POST /api/auth/elevate` allows one such change, after which the confirmation ends; selecting a restricted profile also ends any confirmation the session had.

## Community
| GET | `/api/titles/:id/reviews?sort=helpful|newest|highest|lowest&page` | public | `{items: Review[], summary: {average, count, distribution: {1..5}}, mine: Review|null, total, page, pageSize}` |
|---|---|---|---|
| POST | `/api/titles/:id/reviews` `{rating 1-5, body?, containsSpoilers?}` | profile, rate limited | `{review}` · 409 when one exists |
| PATCH / DELETE | `/api/reviews/:id` | author only | `{review}` / 204 |
| PUT / DELETE | `/api/reviews/:id/helpful` | account (not the author) | `{helpfulCount, voted}` |
| GET / POST | `/api/reviews/:id/comments` `{body}` | public / profile | `{items: Comment[]}` / `{comment}` |
| DELETE | `/api/comments/:id` | author | 204 |
| POST | `/api/reports` `{targetType:'review'|'comment'|'collection', targetId, reason, details?}` (for a shared collection `targetId` may be its share token — the shared view never exposes the id) | account, rate limited | `{ok, autoHidden}` |
| GET / POST / DELETE | `/api/blocks` `{reviewId}` · `/api/blocks/:id` | account | blocked authors are hidden from your review lists |

Review: `{ id, titleId, rating, body, containsSpoilers, status, author: {name, avatar}, isMine, fromYourAccount, helpfulCount, votedHelpful, commentCount, createdAt, updatedAt, edited, editedAt }` (`fromYourAccount`: written by another profile of the viewer's account — no helpful votes, reports or blocks). The list also returns `sort` and `commentsEnabled`.

Moderation: reviews and replies are scored by spam heuristics (links, shouting, repeated characters, blocklist, the same text reused by the account, more than 5 posts in 10 minutes); a held post has `status: 'pending'`, is visible only to its author and is audited as `moderation.auto_hold`. A target with 3 distinct open reports is hidden pending moderator review (`moderation.auto_hide`; a shared collection is made private, which withdraws its link, and its owner is notified). Deleting a hidden or removed post keeps a record (`moderation_history`: a hash of the text, never the text): for 365 days the account's next review of that title, reply on that review, or the same text anywhere is held as `pending` for a moderator. Blocking (`POST /api/blocks`) only accepts a visible review.

## Playback quality & telemetry
| POST | `/api/quality-reports` `{titleId, episodeId?, category, description?, device?, connectionMbps?, selectedResolution?, diagnostics?}` | account, rate limited |
|---|---|---|
| GET | `/api/titles/:id/quality` | public: `{window:'90d', reports: {count, distinctReporters, categories:[{category,count}], sufficient}, measured: {viewers, sessions, threshold, rebufferRatio, avgBitrateKbps, errorRate, medianStartupMs, sufficient}}`. Reported (subjective) and measured (player telemetry) data are always kept apart. Measured figures use signed-in members' sessions only, each member counted once (`sufficient` = at least 10 members). |
| POST | `/api/playback/sessions/open` `{mediaId, titleId, episodeId?}` | public, rate limited 30/min. `{sessionId, issuedAt}`: a signed viewing-session id bound to the media, the account (if any) and the issue time |
| POST | `/api/playback/sessions` `{sessionId, mediaId, titleId, episodeId?, secondsWatched, startupMs?, rebufferCount, rebufferSeconds, avgBitrateKbps?, maxHeight?, droppedFrames?, bytesEstimate?, errorCount}` | public (account attached when signed in). Only ids issued by `/open` to the same viewer and media are accepted (`404 SESSION_NOT_FOUND`); values are bounded by the time since issue and the media's verified renditions |
| POST | `/api/playback/errors` `{mediaId, titleId, episodeId?, code, message, fatal, details?}` | public, rate limited |

## Velvia Suggestions
| GET | `/api/velvia/status` | `{provider, available, model, grounded: true}` |
|---|---|---|
| POST | `/api/velvia/chat` `{messages: [{role:'user'|'assistant', content}] (1–20, ≤ 2000 chars each, last from the user), context: {titleId?, compareIds?[] (≤ 3)}, options: {useHistory: bool}}` | public (a profile personalises), rate limited 20/min per account or IP. `{reply, recommendations: [{titleId, reason, title: TitleSummary, closest?}], clarifyingQuestion, suggestions: string[], provider: 'local'|'anthropic'|'openai-compatible' (the one that answered), fallback: bool, notice? (when fallback), intent, comparison?: {titleIds, titles, rows: [{key, label, values}]}, notInCatalog?: string[]}`. Only catalog titles the profile may see can be recommended; the server drops any other id. `closest: true` marks a labelled closest option when nothing matches exactly. |

## Creators & uploads
| GET | `/api/creators/me` | account | `{isCreator, application|null}` |
|---|---|---|---|
| GET | `/api/creators/requirements` | public | `{uploads: {maxVideoBytes, maxImageBytes, maxDocumentBytes, maxSubtitleBytes, chunkBytes, maxChunkBytes, expireHours}, roles, extensions, transcoding: {available}}` |
| POST | `/api/creators/applications` `{legalName, contactEmail, company?, website?, portfolio?, country?, bio}` | account | `{application}` |
| GET / POST | `/api/creators/submissions` | creator | `{items}` / `{submission}` (draft) |
| GET / PATCH / DELETE | `/api/creators/submissions/:id` | owner (admins use the admin API) | `{submission, files, events}` |
| POST | `/api/creators/submissions/:id/attest` `{rights: {copyrightOwner, distributionRights, territories[], restrictions?, musicCleared, footageCleared, documentationNotes?}, confirm: true}` | owner | `{submission}` |
| POST | `/api/creators/submissions/:id/submit` · `/respond {message}` | owner | `{submission}` · `/respond`: 409 `UPLOADS_IN_PROGRESS` while an upload for the submission is still running |
| DELETE | `/api/creators/submissions/:id/files/:fileId` | owner (draft or info_required) | 204 |
| GET | `/api/creators/titles` | creator | published titles from the creator's submissions, with stats |
| POST | `/api/uploads` `{filename, size, mime?, purpose:'submission'|'artwork', submissionId?, role}` | creator (submission, own draft/info_required) · staff (artwork) | `{id, offset: 0, size, chunkSize, maxChunkSize, expiresAt}` · 413 `FILE_TOO_LARGE` · 422 `UNSUPPORTED_FILE_TYPE` · 409 `SUBMISSION_LOCKED` / `TOO_MANY_UPLOADS` |
| HEAD / GET | `/api/uploads/:id` | owner | `Upload-Offset` + `Upload-Length` headers / `{id, purpose, submissionId, role, filename, size, offset, status: in_progress|processing|complete|rejected|aborted|expired, error, fileId?, url?, width?, height?}` |
| PATCH | `/api/uploads/:id` (`Content-Type: application/offset+octet-stream`, `Upload-Offset`) | owner | 204 + `Upload-Offset`. 409 `OFFSET_MISMATCH` (`error.offset` = the server offset), 413 `CHUNK_TOO_LARGE`, 409 `UPLOAD_BUSY` while another chunk or the final check runs. When the last byte arrives the file is validated by content (magic bytes), hashed (SHA-256), probed (with ffprobe configured, a video it cannot read is refused; a rotated video reports its displayed size) and scanned, then attached; refusals are 422 `UPLOAD_REJECTED` / `UPLOAD_INFECTED` / `DUPLICATE_FILE`. An empty PATCH at the final offset re-runs an interrupted check. |
| DELETE | `/api/uploads/:id` | owner | 204 · 409 `UPLOAD_COMPLETE` / `UPLOAD_BUSY` (final check running) |
| GET | `/media/art/:file` | public | staff-uploaded artwork from storage `public/art/` only (`upl_<id>.png|jpg|webp`), cached immutable |

Submission statuses: `draft → uploading → submitted → under_review → info_required ↔ submitted → approved → published`, or `rejected`. Only the admin API moves a submission past `submitted`. Nothing is published automatically.

## Notifications (account)
| GET | `/api/notifications?unread=1&beforeAt&beforeId` (or `?page`) | `{items: [{id, type, title, body, link, createdAt, readAt}], unread, total, remaining}` (includes active announcements; newest first; `beforeAt`/`beforeId` = the last item shown, so later pages never skip rows). A kids or maturity-limited profile sees only notifications sent to that profile (plus replies to its own reviews), never account, moderation or creator notices; read, read-all, delete and the unread count use the same scope |
|---|---|---|
| GET | `/api/notifications/unread-count` | `{unread}` |
| POST | `/api/notifications/:id/read` · `/api/notifications/read-all` · DELETE `/api/notifications/:id` | `{ok}` |
| GET / PUT | `/api/notifications/preferences` | `{newEpisodes, genreReleases, creatorReleases, submissionUpdates, reviewReplies, announcements}` (optional types only) |

## Watch parties (profile; single-instance, in-memory)
| POST | `/api/parties` `{titleId, episodeId?}` | `{code, party}` |
|---|---|---|
| GET | `/api/parties/:code` · POST `/join` · POST `/leave` (→ `{ok, ended}`) · DELETE (host ends) | `{party: {code, host, titleId, episodeId, state: {playing, position, updatedAt, episodeId, serverTime}, members: [{name, avatar, isHost, online, isYou}], memberCount, maxMembers, allowGuestControl, you: {isMember, isHost, canControl, canChat}, createdAt}}`. Kids profiles cannot create parties (`403 PROFILE_RESTRICTED`), can join only parties hosted from their own account, and are removed if hosting passes to another account |
| PATCH | `/api/parties/:code` `{allowGuestControl}` | host only → `{party}` |
| POST | `/api/parties/:code/control` `{action:'play'|'pause'|'seek'|'episode', position, episodeId?}` | host, or guests when allowed → `{state}` |
| POST | `/api/parties/:code/chat` `{text}` (≤ 500 chars, 5 per 10 s, 20 per minute) | member → `{message}`. `403 PROFILE_RESTRICTED` on kids profiles; messages that are empty once invisible characters are removed are refused |
| GET | `/api/parties/:code/events` | member, rate limited 30/min per account. Server-Sent Events: `state`, `chat` (recent history first, flagged `history: true`; kids profiles receive system messages only), `members`, `ended` `{reason}` (`restricted` when a kids profile is taken out), `replaced` (a member's fourth stream replaces the oldest, which should not reconnect); heartbeat comment every 20 s. `503 PARTY_CAPACITY` when the server's stream cap is reached |

## Administration (staff; admin-only rows are marked)
All admin routes are under `/api/admin/*`. Every mutation writes an audit log entry.
- `GET /api/admin/overview`: counts, open queues, health summary
- Titles: `GET/POST /api/admin/titles`, `GET/PATCH/DELETE /api/admin/titles/:id`, `POST /api/admin/titles/:id/publish|unpublish`, seasons and episodes (`POST /api/admin/titles/:id/seasons`, `PATCH/DELETE /api/admin/seasons/:id`, `POST /api/admin/titles/:id/episodes`, `PATCH/DELETE /api/admin/episodes/:id`)
- Media: `GET/POST /api/admin/media`, `PATCH/DELETE /api/admin/media/:id`, `POST /api/admin/media/:id/verify` (the server reads the manifest or file and records the real renditions and tracks), `POST /api/admin/media/:id/transcode`. A `storage:` source (or transcode `sourceKey`) must be under `media/`, or a video/subtitle file of an approved or published submission linked to the same title (422 otherwise). Deleting a season, episode or media row, or changing a media row, that would leave a published title with nothing playable answers `409 TITLE_WOULD_BE_UNPLAYABLE` (unpublish first). Title ids are slugs; `new` is reserved
- Artwork sync (TMDB): `GET /api/admin/artwork` (`{configured, titles: [{id, source, locked, hasPoster, hasBackdrop, tmdbId, syncedAt, lastResult}]}`), `POST /api/admin/artwork/sync` `{ids?, force?}` → `{results: [{id, status: matched|not_found|no_artwork|mismatch|skipped|error, …}], summary}`, `POST /api/admin/titles/:id/artwork` `{tmdbId?, tmdbType?, force?, unlock?}`. A title is matched only to a TMDB entry with the same title (accents, punctuation and a leading article ignored) and a year within one; no match leaves it without artwork. Lumina key art and staff-chosen artwork are locked. 503 `TMDB_NOT_CONFIGURED` without `TMDB_API_TOKEN`/`TMDB_API_KEY`; when TMDB is unreachable each title reports `error` and keeps its artwork
- Cached artwork images: `GET /media/artwork/tmdb/:size/:file` (public). Serves a TMDB image referenced by the catalog from Lumina's own cache, downloading it from TMDB's CDN once; anything not referenced, or unreachable, is a 404 (the interface shows the Lumina fallback)
- Titles have `availability: 'stream' | 'catalog'`, `tmdbId`, `tmdbType`. Catalog-only titles are listed for reference: they publish without media or a streaming licence, report `playable: false`, and `GET /api/playback/:id` answers 404 `NOT_STREAMING`
- Uploaded artwork: staff upload images through the uploads API (`POST /api/uploads` with `purpose:'artwork'`, then `PATCH` chunks); the finished upload's `url` (`media/art/upl_<id>.<ext>`) goes into the title's `poster`/`backdrop`. Poster and backdrop accept a site path or an `https` URL whose origin is in `MEDIA_ORIGINS` (anything else would be blocked by the Content-Security-Policy)
- TMDB (metadata only): `GET /api/admin/tmdb/search?q&type`, `GET /api/admin/tmdb/:type/:id`
- Taxonomy: `GET/PUT /api/admin/taxonomy` (genres and editorial collections)
- Creators: `GET /api/admin/creator-applications?status`, `POST /api/admin/creator-applications/:id/decision {decision, note}` (pending or info_required applications only; `409 INVALID_TRANSITION` once approved or rejected — creator access is then changed on the account)
- Submissions: `GET /api/admin/submissions?status`, `GET /api/admin/submissions/:id`, `POST /api/admin/submissions/:id/status {status, message}`, `POST /api/admin/submissions/:id/publish`, `GET /api/admin/submissions/:id/files/:fileId/url` (signed, short-lived)
- Moderation: `GET /api/admin/reports?status`, `POST /api/admin/reports/:id/resolve {action: dismiss|hide|remove|suspend_author, note}`, `GET /api/admin/reviews?status&q`, `PATCH /api/admin/reviews/:id {status, note}`, `GET /api/admin/moderation/history`
- Users *(role changes are admin only)*: `GET /api/admin/users?q&role&status`, `GET/PATCH /api/admin/users/:id {role?, status?, suspendedReason?, suspendedUntil?, maxProfiles?, isCreator?}`, `POST /api/admin/users/:id/revoke-sessions`
- Platform: `GET /api/admin/health`, `GET /api/admin/logs?level&limit&q`, `GET /api/admin/playback-errors`, `GET /api/admin/quality-reports`, `GET /api/admin/audit?actor&action&page`, `GET/PUT /api/admin/settings` *(admin)*, `GET/POST /api/admin/announcements`, `DELETE /api/admin/announcements/:id`, `GET /api/admin/usage` (storage in use, estimated bandwidth from playback telemetry)

Private media: `/media/private/<key>?exp&sig` returns an HMAC-signed, expiring, directory-scoped grant (`server/services/storage.js`).
