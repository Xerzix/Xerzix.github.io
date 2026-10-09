// Responsive copies of uploaded artwork (server/services/media/artwork.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../../server/config.js';
import { artSrcset, artUploadId, artworkVariants } from '../../server/services/media/artwork.js';
import { imageSize } from '../../server/services/media/probe.js';

const onPath = (cmd) => (spawnSync(cmd, ['-version'], { stdio: 'ignore' }).status === 0 ? cmd : '');
const FFMPEG = process.env.FFMPEG_PATH || onPath('ffmpeg');
const noFfmpeg = !FFMPEG && 'ffmpeg not available (set FFMPEG_PATH)';
const ID = 'upl_abcdefghij0123456789';

test('srcset is built only from stored copies of an /media/art upload', () => {
  assert.equal(artUploadId(`/media/art/${ID}.png`), ID);
  assert.equal(artUploadId('/assets/art/sintel-poster.svg'), null);
  assert.equal(artUploadId(`/media/art/${ID}-w360.png`), null, 'a copy is not an original');
  assert.equal(artSrcset(`/media/art/${ID}.png`, { width: 1600, variants: [] }), null);
  assert.equal(artSrcset(`/media/art/${ID}.png`, null), null);
  assert.equal(
    artSrcset(`/media/art/${ID}.png`, { width: 1600, variants: [{ width: 360, url: `/media/art/${ID}-w360.png` }, { width: 720, url: `/media/art/${ID}-w720.png` }] }),
    `/media/art/${ID}-w360.png 360w, /media/art/${ID}-w720.png 720w, /media/art/${ID}.png 1600w`,
  );
});

test('no ffmpeg: no copies, nothing breaks', async () => {
  assert.deepEqual(await artworkVariants('', '/nope.png', ID, { width: 2000, ext: 'png' }), []);
});

test('ffmpeg makes smaller copies, never wider than the original', { skip: noFfmpeg, timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lumina-art-'));
  const saved = config.storageDir;
  config.storageDir = dir;
  try {
    const jpg = join(dir, 'src.jpg');
    execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=1000x1500', '-frames:v', '1', jpg]);
    const v = await artworkVariants(FFMPEG, jpg, ID, { width: 1000, ext: 'jpg' });
    assert.deepEqual(v.map((x) => x.width), [360, 720], 'no 1280 copy of a 1000-pixel original');
    for (const x of v) {
      const file = join(dir, 'public/art', x.url.split('/').pop());
      assert.ok(existsSync(file));
      assert.equal(imageSize(readFileSync(file)).width, x.width);
      assert.match(x.url, /-w\d+\.jpg$/);
    }
    const png = join(dir, 'src.png');
    execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=800x450', '-frames:v', '1', png]);
    const p = await artworkVariants(FFMPEG, png, ID, { width: 800, ext: 'png' });
    assert.deepEqual(p.map((x) => x.url), [`/media/art/${ID}-w360.png`, `/media/art/${ID}-w720.png`], 'PNG keeps a lossless format (transparency survives)');
  } finally {
    config.storageDir = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});
