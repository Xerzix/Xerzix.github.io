// Opening sequence, shown once per device (and on demand from Settings):
//   Stage 1 (0–2.2 s)  a temple emerges from darkness as petals begin to fall
//   Stage 2 (2.2–4.6 s) the LUMINA wordmark resolves with a velvet-red glow
//   Stage 3            WELCOME TO LUMINA with an "Enter Lumina" button
// Skippable at any moment (button, Esc). Reduced motion jumps straight to stage 3.
import { h, prefersReducedMotion } from '../core/dom.js';
import { store } from '../core/storage.js';
import { buildScene } from './garden.js';
import { ParticleField } from './petals.js';
import { logoMark } from '../ui/icons.js';

const SEEN_KEY = 'introSeen';
const VERSION = 1;

export function introSeen() {
  return store.get(SEEN_KEY) === VERSION;
}

/** Plays the intro. Resolves when the visitor enters Lumina. */
export function playIntro({ force = false } = {}) {
  if (!force && introSeen()) return Promise.resolve();
  return new Promise((resolve) => {
    const reduced = prefersReducedMotion();
    const canvas = h('canvas', { 'aria-hidden': 'true' });
    const enter = h('button', { class: 'lm-btn lm-btn--primary lm-btn--lg lm-intro__enter', type: 'button' }, h('span', null, 'Enter Lumina'));
    const skip = h('button', { class: 'lm-btn lm-btn--glass lm-btn--sm lm-intro__skip', type: 'button' }, h('span', null, 'Skip intro'));
    const word = h('span', { class: 'lm-intro__word', 'aria-hidden': 'true' }, ...'LUMINA'.split('').map((ch, i) => h('span', { style: { transitionDelay: `${i * 120}ms` } }, ch)));
    const root = h('div', { class: 'lm-intro', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Welcome to Lumina', 'data-stage': '0' },
      h('div', { class: 'lm-intro__scene' }, buildScene({ detail: window.innerWidth < 720 ? 'lite' : 'full', idPrefix: 'intro', seed: 23 })),
      canvas,
      h('div', { class: 'lm-intro__veil' }),
      skip,
      h('div', { class: 'lm-intro__center' },
        h('div', { class: 'lm-intro__logo' }, logoMark('lm-intro__mark'), word, h('span', { class: 'lm-intro__kana', lang: 'ja', 'aria-hidden': 'true' }, 'ルミナ')),
        h('div', { class: 'lm-intro__welcome' },
          h('h1', null, 'WELCOME TO LUMINA'),
          h('p', null, 'An entirely new world of entertainment.'),
          enter)));
    document.body.append(root);
    document.body.style.overflow = 'hidden';

    const field = new ParticleField(canvas);
    field.setKind('petals');
    field.setIntensity(0.75);
    field.start();

    const timers = [];
    const stage = (n) => {
      root.dataset.stage = String(n);
      if (n === 3) {
        skip.hidden = true;
        setTimeout(() => enter.focus(), 400);
      }
    };
    if (reduced) {
      stage(3);
    } else {
      requestAnimationFrame(() => stage(1));
      timers.push(setTimeout(() => {
        stage(2);
        field.gustNow(1.2);
      }, 2200));
      timers.push(setTimeout(() => stage(3), 4600));
      setTimeout(() => skip.focus(), 50);
    }

    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      timers.forEach(clearTimeout);
      store.set(SEEN_KEY, VERSION);
      root.classList.add('is-done');
      document.body.style.overflow = '';
      document.removeEventListener('keydown', onKey);
      setTimeout(() => {
        field.destroy();
        root.remove();
      }, 750);
      resolve();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') finish();
      if (e.key === 'Tab') {
        // Keep focus inside the intro while it is open.
        const focusables = [skip, enter].filter((b) => !b.hidden && getComputedStyle(b).visibility !== 'hidden');
        if (!focusables.length) return;
        e.preventDefault();
        const i = focusables.indexOf(document.activeElement);
        focusables[(i + 1) % focusables.length].focus();
      }
    };
    document.addEventListener('keydown', onKey);
    skip.addEventListener('click', finish);
    enter.addEventListener('click', finish);
  });
}
