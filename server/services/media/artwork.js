// Responsive sizes for uploaded poster and backdrop artwork.
//   artworkVariants(ffmpegPath, srcPath, id, { width, ext })  → [{ width, url }]
//   artSrcset(url, upload)                                     → "…-w360.jpg 360w, … 1920w" | null
// When ffmpeg is configured, each upload also gets smaller copies (360, 720 and 1280 pixels
// wide, never wider than the original) so cards and phones do not download the full file.
// JPEG originals give JPEG copies; PNG and WebP originals give PNG copies so transparency is
// kept. Without ffmpeg (or if a resize fails) only the original is served, as before.
import { spawn } from 'node:child_process';
import { ensureDirFor } from '../storage.js';
import { log } from '../../lib/log.js';

export const ART_WIDTHS = [360, 720, 1280];
const ART_URL = /^\/media\/art\/(upl_[0-9a-z]{20})\.(png|jpg|webp)$/;

function run(ffmpegPath, args, timeoutMs = 30_000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'ignore'] });
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      finish(false);
    }, timeoutMs);
    proc.on('error', () => finish(false));
    proc.on('close', (code) => finish(code === 0));
  });
}

/** Writes the smaller copies next to the original in public/art/. Returns the ones made. */
export async function artworkVariants(ffmpegPath, srcPath, id, { width, ext } = {}) {
  if (!ffmpegPath || !(width > 0)) return [];
  const outExt = ext === 'jpg' ? 'jpg' : 'png';
  const out = [];
  for (const w of ART_WIDTHS) {
    if (w >= width) break;
    const file = `${id}-w${w}.${outExt}`;
    const dest = ensureDirFor(`public/art/${file}`);
    const quality = outExt === 'jpg' ? ['-q:v', '3'] : ['-compression_level', '9'];
    const ok = await run(ffmpegPath, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-i', srcPath, '-vf', `scale=${w}:-2:flags=lanczos`, '-frames:v', '1', ...quality, dest]);
    if (!ok) {
      log.warn('artwork resize failed', { upload: id, width: w });
      break;
    }
    out.push({ width: w, url: `/media/art/${file}` });
  }
  return out;
}

/** The upload id behind an /media/art/ URL, or null. */
export function artUploadId(url) {
  return typeof url === 'string' ? url.match(ART_URL)?.[1] || null : null;
}

/** A srcset for an uploaded image, from the upload's stored result ({ width, variants }). */
export function artSrcset(url, result) {
  const variants = Array.isArray(result?.variants) ? result.variants.filter((v) => v && v.width > 0 && typeof v.url === 'string') : [];
  if (!variants.length || !(result.width > 0)) return null;
  return [...variants.map((v) => `${v.url} ${v.width}w`), `${url} ${result.width}w`].join(', ');
}
