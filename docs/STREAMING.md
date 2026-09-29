# Streaming architecture and what production 4K needs

## What is implemented in this repository

| Stage | Implementation | Where |
|---|---|---|
| Ingest | Resumable, chunked uploads. Type is checked by magic bytes, then a SHA-256 is taken, the file is probed and optionally malware-scanned. Files are stored outside the web root. | `server/routes/uploads.js`, `server/services/uploads.js` |
| Probe | `ffprobe` when configured, otherwise a pure-JS MP4/MOV parser | `server/services/media/probe.js` |
| Transcode | ffmpeg produces an HLS ladder: H.264 High + AAC, aligned 2 s GOPs, 4 s segments, VOD playlists, one audio group. **Rungs never exceed the source height**, so a 1080p master can never be labelled 4K. | `server/services/media/transcoder.js`, `worker.js` |
| Job queue | SQLite-backed `transcode_jobs` table. The worker runs in-process (`TRANSCODE_IN_PROCESS`) or on its own (`npm run worker`). | `server/services/media/queue.js` |
| Verification | Resolutions and tracks come from the produced or remote master playlist. Admins can re-verify any media; `npm run media:verify` does the same for the seed catalog. | `server/services/admin/media-verify.js`, `scripts/verify-media.mjs` |
| Delivery | Public media (`media/…`) is served as static files with Range support. Private media is served through HMAC-signed, expiring, directory-scoped URLs (`/media/private/<dir>/…?exp&sig`). Manifests are rewritten so every segment carries the grant. | `server/services/storage.js`, `server/app.js` |
| Playback | hls.js (vendored) with MSE, native HLS on Safari/iOS, and progressive files with manual variants. ABR is on. The quality menu lists only renditions present in the stream. The player adds subtitles, audio tracks, resume, skip intro/credits, next episode, PiP, fullscreen and telemetry. | `js/player/` |
| Telemetry | Per-session startup time, rebuffering, bitrate, maximum height, dropped frames and errors are recorded. These *measured* statistics are shown separately from members' *reported* quality issues. | `server/routes/playback.js` |

The Lumina Originals in `media/originals/` show the whole pipeline end to end. `npm run media:sample` renders them frame by frame from the garden scene and encodes a master. It then builds the ladder and writes the renditions it actually produced back into the catalog. Hanami is rendered at a true 3840×2160, so it is the only title with a 2160p rung. The Blender Foundation films stream from their public hosts, and they show no resolution badge until `npm run media:verify` has read their manifests.

## Why "4K" is more than a button

A 4K option is shown only when a 2160p rendition exists and was verified. The master playlist written by the transcoder is the source of truth for this.

## Production requirements for 4K streaming

### 1. Source and encoding
- **Mezzanine masters:** ProRes 422 HQ, DNxHR HQX, or high-bitrate H.264/HEVC, at the delivery resolution or higher. The pipeline never upscales, so a 1080p master stays 1080p.
- **Codecs:**
  - H.264 is universal, but 2160p needs level 5.1 and roughly 12–20 Mbps for live-action.
  - HEVC (H.265) and AV1 cut 4K bitrates by 30–50%. HEVC is required for HDR10 on Apple devices; AV1 is increasingly supported on TVs and Chrome.
  - A typical production ladder has an H.264 set for compatibility plus an HEVC and/or AV1 set for 4K/HDR, selected per device using `CODECS` in the master playlist.
- **Ladder** (per-title encoding tunes these rates):

  | Rung | Bitrate range |
  |---|---|
  | 2160p | 12–16 Mbps (HEVC/AV1 ~8–12) |
  | 1440p | 8 Mbps |
  | 1080p | 5–6 Mbps |
  | 720p | 3 Mbps |
  | 480p | 1.2 Mbps |
  | 360p | 0.6 Mbps |

- **HDR:** HDR10 or Dolby Vision needs 10-bit HEVC or AV1, color metadata passed through, and device capability detection. The `hdr` field exists on media but isn't produced by the bundled transcoder.
- **Audio:** AAC stereo is implemented. 5.1/Atmos needs E-AC-3 renditions in extra `EXT-X-MEDIA` audio groups. Dubbed languages are additional audio renditions and are listed only when they have actually been supplied.
- **Capacity:** software-encoding one feature film to a full 4K multi-codec ladder takes hours of CPU time. Production uses a managed transcoder (AWS Elemental MediaConvert, Google Transcoder API, Mux, Bitmovin, Cloudflare Stream) or a GPU/fleet worker pool. Only `server/services/media/worker.js` needs replacing for this; the database contract stays the same.

### 2. Storage
- Masters, renditions and uploads belong in object storage (S3, GCS, R2 or Azure Blob), not on the app server's disk. `server/services/storage.js` is the single seam: keep `storagePath`/`signedUrl` semantics and switch the implementation to presigned object-store URLs or CDN tokens.
- **Size estimate** (varies with content complexity), for 2 hours at 2160p/12 Mbps plus the lower rungs (~25 Mbps summed):
  - **2 h × 3600 s × 25 Mbit/s ÷ 8 ≈ 22.5 GB per title** for a single-codec ladder.
  - Add the master (often 100 GB or more) and any HEVC/AV1 duplicates.
- **Lifecycle policies:**
  - Move masters to archive storage after encoding.
  - Delete abandoned uploads (this repo already expires incomplete uploads after 72 h).
  - Keep only the renditions devices actually request.

### 3. Delivery (CDN)
- Put a CDN in front of the segments and manifests. Segments are immutable, so cache them for a long time; cache VOD playlists for a moderate time.
- **Bandwidth is the dominant running cost.** A viewer who watches 2 hours at 2160p/12 Mbps pulls about **10.8 GB**.
  - Monthly egress ≈ viewers × hours × average bitrate.
  - Example: 10,000 viewers × 10 h/month × 8 Mbps average ≈ 360 TB/month.
  - Multiply by your CDN's per-GB rate for the actual cost.
  - Capping resolution by plan or by device, as Data Saver already does, is the main cost lever.
- Access control: use signed URLs or signed cookies with short lifetimes, scoped to a title directory (the pattern implemented here), plus token authentication at the CDN edge.
- **DRM:** studio-licensed 4K content generally requires Widevine L1, PlayReady SL3000 or FairPlay with hardware-backed decryption. This needs a DRM licence service (a multi-DRM vendor), CENC/CBCS packaging, and EME in the player (hls.js supports EME/FairPlay configuration). DRM is **not implemented here**. Openly licensed and creator-owned content does not need it.

### 4. Monitoring and targets
Targets are for representative devices at the 75th percentile. Measure them with the player telemetry this repo records, aggregated per title and device class:

| Metric | Target |
|---|---|
| Time to first frame | < 2 s on broadband, < 4 s on 4G |
| Rebuffering ratio | < 0.5 % of watch time |
| Playback failure rate | < 0.5 % of sessions |
| Average delivered bitrate | Tracked per device class. Watch for ABR stuck at low rungs. |
| Home page (Lighthouse, mid-range mobile) | LCP < 2.5 s, CLS < 0.1, INP < 200 ms |

These are targets, not measured results. Measure them on real devices before quoting them.

## Checklist to go from this repository to production 4K
1. Object storage plus CDN, with `server/services/storage.js` switched to presigned or edge-token URLs.
2. A managed or GPU transcoding service behind `server/services/media/worker.js`, with HEVC/AV1 and HDR ladders.
3. DRM (only if licensed content requires it).
4. Multi-instance deployment:
   - PostgreSQL instead of SQLite (the SQL is portable).
   - Redis for rate limiting and watch-party pub/sub.
   - Workers scaled separately from the web tier.
5. Real device QA matrix: Smart TVs, Safari/iOS, Android, Chromecast and AirPlay.
6. Cost dashboards from CDN logs, cross-checked against the player telemetry estimates in the admin dashboard.
