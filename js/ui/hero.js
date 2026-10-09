// The featured cinematic banner: crossfading backdrops with a slow push-in, optional muted
// trailer previews, auto-rotation with a pause control (WCAG 2.2.2), dots and keyboard access.
import { h, prefersReducedMotion } from '../core/dom.js';
import { session, library } from '../core/session.js';
import { api } from '../api/client.js';
import { icon } from './icons.js';
import { button, linkButton } from './components.js';
import { titleMeta, listButton, playHref } from './card.js';

const ROTATE_MS = 9000;
const PREVIEW_DELAY_MS = 3500;

export function hero(items, { autoRotate = true, previews = true } = {}) {
  if (!items.length) return h('div');
  let index = 0;
  let timer = 0;
  let previewTimer = 0;
  let paused = !autoRotate || prefersReducedMotion() || items.length < 2;
  let userPaused = false;

  const slides = items.map((t, i) => h('div', { class: ['lm-hero__slide', i === 0 && 'is-active'], 'aria-hidden': 'true' },
    h('img', { src: t.backdrop || t.poster, srcset: (t.backdrop ? t.backdropSrcset : t.posterSrcset) || undefined, sizes: '100vw', alt: '', decoding: 'async', fetchpriority: i === 0 ? 'high' : 'low', loading: i === 0 ? 'eager' : 'lazy' })));
  const content = h('div', { class: 'lm-hero__content' });
  const dots = h('div', { class: 'lm-hero__dots', role: 'group', 'aria-label': 'Featured titles' });
  const pauseBtn = h('button', { class: 'lm-icon-btn', type: 'button' });
  const controls = h('div', { class: 'lm-hero__controls' },
    items.length > 1 ? pauseBtn : null,
    items.length > 1 ? dots : null);
  const root = h('section', { class: 'lm-hero', 'aria-roledescription': 'carousel', 'aria-label': 'Featured on Lumina' },
    h('div', { class: 'lm-hero__slides' }, ...slides),
    h('div', { class: 'lm-hero__shade' }),
    content,
    controls);

  items.forEach((t, i) => {
    dots.append(h('button', { class: 'lm-hero__dot', type: 'button', 'aria-label': `Show ${t.title}`, 'aria-current': String(i === 0), onClick: () => { show(i); userPaused = true; setPaused(true); } }));
  });

  function renderContent(t) {
    const progress = library.progressFor(t.id);
    const resuming = progress && !progress.completed && progress.positionS > 15;
    const inner = h('div', { class: 'lm-hero__inner', 'aria-live': 'polite' },
      h('div', { class: 'lm-eyebrow lm-hero__eyebrow' }, (t.tags || []).includes('lumina-original') ? 'A Lumina Original' : t.type === 'series' ? 'Series' : 'Featured film'),
      h('h2', { class: 'lm-hero__title' }, t.title, t.originalTitle && t.originalTitle !== t.title ? h('span', { class: 'lm-hero__original', lang: 'ja' }, t.originalTitle) : null),
      titleMeta(t, { extended: true }),
      h('div', { class: 'lm-meta' }, (t.genres || []).map((g) => h('span', { class: 'lm-tag' }, g))),
      h('p', { class: 'lm-hero__synopsis' }, t.synopsis),
      h('div', { class: 'lm-hero__actions' },
        linkButton(resuming ? 'Resume' : 'Play', playHref(t), { variant: 'primary', size: 'lg', icon: 'play' }),
        listButton(t, { size: 'lg', variant: 'glass', label: true }),
        linkButton('More Information', `#/title/${encodeURIComponent(t.id)}`, { variant: 'glass', size: 'lg', icon: 'info' })));
    content.replaceChildren(inner);
  }

  function stopPreview() {
    clearTimeout(previewTimer);
    root.querySelectorAll('.lm-hero__slide video').forEach((v) => {
      v.pause();
      v.remove();
    });
  }

  async function startPreview(i) {
    const t = items[i];
    const prefs = session.profile?.preferences;
    const allowed = previews && t.hasTrailer && session.profile?.autoplayPreviews !== false && !prefs?.playback?.dataSaver && !prefersReducedMotion();
    if (!allowed) return;
    try {
      const info = await api.catalog.playback(t.id, { role: 'trailer' });
      if (index !== i) return;
      const video = h('video', { muted: true, playsinline: true, loop: true, preload: 'auto', 'aria-hidden': 'true' });
      video.muted = true;
      if (info.media.kind === 'hls' && !video.canPlayType('application/vnd.apple.mpegurl')) {
        const { default: Hls } = await import('../vendor/hls.min.mjs');
        if (!Hls.isSupported()) return;
        const hls = new Hls({ capLevelToPlayerSize: true, maxBufferLength: 10 });
        hls.loadSource(info.media.src);
        hls.attachMedia(video);
        video.addEventListener('emptied', () => hls.destroy(), { once: true });
      } else {
        video.src = info.media.src;
      }
      slides[i].append(video);
      video.addEventListener('playing', () => video.classList.add('is-playing'), { once: true });
      await video.play().catch(() => video.remove());
    } catch {
      /* previews are optional */
    }
  }

  function show(i) {
    stopPreview();
    slides[index].classList.remove('is-active');
    dots.children[index]?.setAttribute('aria-current', 'false');
    index = (i + items.length) % items.length;
    slides[index].classList.add('is-active');
    dots.children[index]?.setAttribute('aria-current', 'true');
    renderContent(items[index]);
    previewTimer = setTimeout(() => startPreview(index), PREVIEW_DELAY_MS);
    schedule();
  }

  function schedule() {
    clearTimeout(timer);
    if (!paused) timer = setTimeout(() => show(index + 1), ROTATE_MS);
  }

  function setPaused(v) {
    paused = v;
    pauseBtn.replaceChildren(icon(paused ? 'play' : 'pause'));
    pauseBtn.setAttribute('aria-label', paused ? 'Resume featured rotation' : 'Pause featured rotation');
    schedule();
  }

  pauseBtn.addEventListener('click', () => {
    userPaused = !paused;
    setPaused(!paused);
  });
  // Pause while the pointer or keyboard focus is inside the banner.
  root.addEventListener('pointerenter', () => { if (!userPaused && autoRotate) { paused = true; schedule(); } });
  root.addEventListener('pointerleave', () => { if (!userPaused && autoRotate && !prefersReducedMotion()) { paused = false; schedule(); } });
  root.addEventListener('focusin', () => { paused = true; schedule(); });
  root.addEventListener('focusout', (e) => { if (!root.contains(e.relatedTarget) && !userPaused && autoRotate && !prefersReducedMotion()) { paused = false; schedule(); } });
  const onVisibility = () => (document.hidden ? clearTimeout(timer) : schedule());
  document.addEventListener('visibilitychange', onVisibility);

  renderContent(items[0]);
  setPaused(paused);
  previewTimer = setTimeout(() => startPreview(0), PREVIEW_DELAY_MS);

  root.destroy = () => {
    clearTimeout(timer);
    stopPreview();
    document.removeEventListener('visibilitychange', onVisibility);
  };
  return root;
}
