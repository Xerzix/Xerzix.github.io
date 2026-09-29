// Frame-accurate renderer for Lumina Originals. Exposes window.lumina.setup(spec) and
// window.lumina.frame(tSeconds); the Node script screenshots each frame.
import { buildScene, applyEnvironment } from '/js/fx/garden.js';
import { ParticleField, ENV_PARTICLES } from '/js/fx/petals.js';

const $ = (id) => document.getElementById(id);
let spec;
let field;
let lastMs = 0;

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const ease = (x) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);
/** Opacity envelope: fades in over [a, b], holds, fades out over [c, d]. */
const env = (t, a, b, c, d) => (t < a || t > d ? 0 : t < b ? ease((t - a) / (b - a)) : t <= c ? 1 : 1 - ease((t - c) / (d - c)));

function card(html) {
  const el = document.createElement('div');
  el.className = 'card';
  el.innerHTML = html; // trusted, static strings from the render spec
  $('cards').append(el);
  return el;
}

window.lumina = {
  setup(s) {
    spec = s;
    applyEnvironment(s.environment);
    document.documentElement.dataset.motion = 'full';
    $('scene').replaceChildren(buildScene({ detail: 'full', idPrefix: 'r', seed: s.seed || 7 }));
    const dpr = s.scale || 1;
    field = new ParticleField($('petals'));
    field.monitor = () => {};
    field.resize = function resize() {
      this.w = window.innerWidth;
      this.h = window.innerHeight;
      this.canvas.width = Math.round(this.w * dpr);
      this.canvas.height = Math.round(this.h * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.fit();
    };
    field.resize();
    field.setKind(ENV_PARTICLES[s.environment]);
    field.setIntensity(s.intensity ?? 0.8);
    field.running = true;
    // Pause every CSS animation; frame() positions them explicitly.
    for (const a of document.getAnimations()) a.pause();
    this.cards = (s.cards || []).map((c) => ({ ...c, el: card(c.html) }));
    // Warm the particle field so the first frame isn't empty.
    for (let i = 0; i < 48; i++) {
      lastMs += 1000 / 24;
      field.last = lastMs - 1000 / 24;
      field.tick(lastMs);
    }
    return true;
  },
  frame(t) {
    const ms = t * 1000;
    for (const a of document.getAnimations()) a.currentTime = ms;
    // Camera: slow push-in over the whole piece.
    const k = t / spec.duration;
    $('scene').style.transform = `scale(${(1.07 - 0.07 * ease(k)).toFixed(4)}) translateY(${(-0.6 * k).toFixed(3)}%)`;
    // Fade from and to black.
    const fadeIn = spec.fadeIn ?? 2;
    const fadeOut = spec.fadeOut ?? 1.5;
    $('black').style.opacity = String(1 - Math.min(clamp01(t / fadeIn), clamp01((spec.duration - t) / fadeOut)));
    // Scene brightness ramp (the temple "emerges").
    const lift = spec.emerge ? 0.25 + 0.75 * ease(clamp01(t / spec.emerge)) : 1;
    $('scene').style.filter = `brightness(${lift.toFixed(3)})`;
    for (const c of this.cards) c.el.style.opacity = String(env(t, ...c.at));
    for (const g of spec.gusts || []) if (Math.abs(t - g) < 1 / 48) field.gustNow(1.2);
    lastMs = 10_000 + ms;
    field.last = lastMs - 1000 / 24;
    field.tick(lastMs);
    return true;
  },
};
