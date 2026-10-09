// Artwork upload for the title editor. Sends a poster or backdrop image through the resumable
// uploads API with purpose 'artwork' (staff only). The server checks the file's real type and
// dimensions, runs the malware scanner when one is configured, and publishes the image at
// /media/art/<upload id>.<ext>. This control then fills the field with that site path; the
// title itself changes only when the editor is saved.
import { h, announce } from '../core/dom.js';
import { api } from '../api/client.js';
import { bytes } from '../core/format.js';
import { button } from '../ui/components.js';
import { completeReceivedUpload, maxBytesFor, uploadRequirements } from '../ui/uploader.js';
import { adminApi } from './api.js';

const ACCEPT = '.png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp';
const IMAGE_NAME = /\.(png|jpe?g|webp)$/i;
const FALLBACK_CHUNK = 4 * 1024 * 1024;

/**
 * An "Upload poster" style button with a status line.
 * `control` is the text input that stores the image path; `onUploaded` runs after it is filled.
 */
export function artworkUpload({ role, label, control, onUploaded }) {
  const input = h('input', { type: 'file', accept: ACCEPT, class: 'visually-hidden', tabindex: '-1', 'aria-hidden': 'true' });
  const status = h('span', { class: 'adm-artupload__status', role: 'status' });
  const btn = button(`Upload ${label.toLowerCase()}`, { variant: 'ghost', size: 'sm', icon: 'upload', onClick: () => input.click() });

  // Choosing a file is not an edit of the title; only a finished upload fills the field.
  for (const type of ['input', 'change']) input.addEventListener(type, (e) => e.stopPropagation());
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    input.value = '';
    if (file) upload(file);
  });

  const say = (text, tone) => {
    status.textContent = text;
    status.dataset.tone = tone || '';
  };

  async function upload(file) {
    if (!IMAGE_NAME.test(file.name)) {
      say('Choose a PNG, JPEG or WebP image.', 'error');
      return;
    }
    const max = maxBytesFor(await uploadRequirements(), 'image');
    if (max && file.size > max) {
      say(`This image is ${bytes(file.size)}; artwork can be at most ${bytes(max)}.`, 'error');
      return;
    }
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    let uploadId = null;
    let finished = false;
    try {
      say('Starting the upload…');
      const created = await adminApi.artwork.createUpload({ filename: file.name, size: file.size, mime: file.type || undefined, purpose: 'artwork', role });
      uploadId = created.id;
      const chunk = Math.max(1, Math.min(created.chunkSize || FALLBACK_CHUNK, created.maxChunkSize || FALLBACK_CHUNK));
      let offset = created.offset || 0;
      while (offset < file.size) {
        say(`Uploading ${file.name}… ${Math.floor((offset / file.size) * 100)}%`);
        offset = await api.uploads.sendChunk(uploadId, offset, file.slice(offset, Math.min(file.size, offset + chunk)));
      }
      say('Checking the image…');
      const st = await completeReceivedUpload(uploadId);
      finished = true;
      if (st.status !== 'complete' || !st.url) throw new Error(st.error || 'The image could not be verified.');
      // Stored as a site path (like assets/art/…) so it resolves from the app and the dashboard.
      control.value = st.url.replace(/^\/+/, '');
      control.dispatchEvent(new Event('change', { bubbles: true }));
      say(`Uploaded ${file.name}${st.width && st.height ? ` (${st.width} × ${st.height})` : ''}. Save the title to use it.`, 'ok');
      announce(`${label} uploaded. Save the title to use it.`);
      onUploaded?.(st);
    } catch (err) {
      say(err?.message || 'The upload failed.', 'error');
      announce(`${label} upload failed. ${err?.message || ''}`);
      // Release an unfinished upload so it does not count against the account's open uploads.
      if (uploadId && !finished) api.uploads.abort(uploadId).catch(() => {});
    } finally {
      btn.disabled = false;
      btn.removeAttribute('aria-busy');
    }
  }

  return h('div', { class: 'adm-artupload' }, btn, input, status);
}
