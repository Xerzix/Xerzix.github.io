// Particle field for the garden environments: sakura petals, maple leaves, snow, fireflies
// and lantern embers. Sprites are pre-rendered once; each frame only draws images.
//
// Performance safeguards:
//  • device pixel ratio capped at 1.5 and particle budget scaled by screen area
//  • adaptive quality: sustained slow frames reduce the particle count automatically
//  • stops completely when the tab is hidden, when the video player is open, when
//    animation is switched off, or when reduced motion is preferred
import { prefersReducedMotion } from '../core/dom.js';

const TAU = Math.PI * 2;

const KINDS = {
  petals: { count: 70, colors: ['#f6c1cf', '#f1a7bd', '#e98aa6', '#fbd9e2', '#d8708f'], size: [7, 15], fall: [22, 55], sway: [18, 46], spin: 1.2, flip: 1.6, sprite: 'petal' },
  leaves: { count: 44, colors: ['#e36a2f', '#c9471f', '#f0a23b', '#b8321c', '#d98b2b'], size: [12, 22], fall: [30, 70], sway: [26, 60], spin: 1.6, flip: 1.9, sprite: 'leaf' },
  snow: { count: 120, colors: ['#ffffff', '#eef3fa', '#dfe8f5'], size: [2, 6], fall: [18, 48], sway: [8, 26], spin: 0, flip: 0, sprite: 'snow' },
  fireflies: { count: 34, colors: ['#ffe9a3', '#fff2c4', '#d9f5a6'], size: [3, 6], fall: [-6, 6], sway: [12, 36], spin: 0, flip: 0, sprite: 'glow', float: true },
  embers: { count: 46, colors: ['#ffb45e', '#ff8a3d', '#ffd08a'], size: [2, 5], fall: [-40, -14], sway: [10, 30], spin: 0, flip: 0, sprite: 'glow', float: true },
};

export const ENV_PARTICLES = { sakura: 'petals', moonlit: 'fireflies', autumn: 'leaves', snow: 'snow', lantern: 'embers', none: null };

function makeSprite(kind, color, size, blur = 0) {
  const pad = Math.ceil(size * 0.6 + blur * 2);
  const c = document.createElement('canvas');
  c.width = c.height = size * 2 + pad * 2;
  const g = c.getContext('2d');
  g.translate(c.width / 2, c.height / 2);
  if (blur) g.filter = `blur(${blur}px)`;
  if (kind === 'petal') {
    // A sakura petal: rounded teardrop with the characteristic notch at the tip.
    const s = size;
    const grad = g.createLinearGradient(0, -s, 0, s);
    grad.addColorStop(0, '#fff4f7');
    grad.addColorStop(0.45, color);
    grad.addColorStop(1, color);
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(0, s);
    g.bezierCurveTo(-s * 0.95, s * 0.35, -s * 0.8, -s * 0.75, -s * 0.18, -s * 0.95);
    g.lineTo(0, -s * 0.72);
    g.lineTo(s * 0.18, -s * 0.95);
    g.bezierCurveTo(s * 0.8, -s * 0.75, s * 0.95, s * 0.35, 0, s);
    g.fill();
    g.globalAlpha = 0.35;
    g.strokeStyle = '#ffffff';
    g.lineWidth = Math.max(0.6, s * 0.06);
    g.beginPath();
    g.moveTo(0, s * 0.8);
    g.lineTo(0, -s * 0.4);
    g.stroke();
  } else if (kind === 'leaf') {
    // Five-lobed maple leaf.
    const s = size;
    g.fillStyle = color;
    g.beginPath();
    for (let i = 0; i <= 10; i++) {
      const a = -Math.PI / 2 + (i / 10) * TAU;
      const r = i % 2 === 0 ? s : s * 0.45;
      const x = Math.cos(a) * r;
      const y = Math.sin(a) * r * 0.95;
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.closePath();
    g.fill();
    g.strokeStyle = 'rgba(60,20,10,.45)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(0, s * 1.2);
    g.lineTo(0, -s * 0.6);
    g.stroke();
  } else if (kind === 'snow') {
    const grad = g.createRadialGradient(0, 0, 0, 0, 0, size);
    grad.addColorStop(0, color);
    grad.addColorStop(0.55, 'rgba(255,255,255,.75)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.arc(0, 0, size, 0, TAU);
    g.fill();
  } else {
    // Soft glow (fireflies, embers)
    const grad = g.createRadialGradient(0, 0, 0, 0, 0, size * 2.4);
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(0.18, color);
    grad.addColorStop(0.45, `${color}66`);
    grad.addColorStop(1, `${color}00`);
    g.fillStyle = grad;
    g.beginPath();
    g.arc(0, 0, size * 2.4, 0, TAU);
    g.fill();
  }
  return c;
}

const rand = (a, b) => a + Math.random() * (b - a);

export class ParticleField {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{ front?: boolean }} options  front: sparse, larger, blurred particles drawn over content
   */
  constructor(canvas, { front = false } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.front = front;
    this.kind = null;
    this.intensity = 0.6;
    this.particles = [];
    this.sprites = [];
    this.running = false;
    this.paused = false;
    this.raf = 0;
    this.last = 0;
    this.time = 0;
    this.perf = navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4 ? 0.6 : 1;
    if (navigator.deviceMemory && navigator.deviceMemory <= 4) this.perf = Math.min(this.perf, 0.6);
    this.frameEma = 16;
    this.slowFor = 0;
    this.fastFor = 0;
    this.gust = 0;
    this.scrollWind = 0;
    this.lastScrollY = window.scrollY;
    this.onResize = () => this.resize();
    this.onScroll = () => {
      const dy = window.scrollY - this.lastScrollY;
      this.lastScrollY = window.scrollY;
      this.scrollWind = Math.max(-1.5, Math.min(1.5, this.scrollWind + dy * 0.012));
    };
    this.onVisibility = () => (document.hidden ? this.halt() : this.resume());
    window.addEventListener('resize', this.onResize, { passive: true });
    window.addEventListener('scroll', this.onScroll, { passive: true });
    document.addEventListener('visibilitychange', this.onVisibility);
    this.resize();
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.fit();
  }

  /** Target particle count for the current kind, screen size, intensity and performance. */
  budget() {
    if (!this.kind) return 0;
    const cfg = KINDS[this.kind];
    if (this.front) return this.intensity > 0.05 && this.kind !== 'snow' ? Math.round(1 + this.intensity * 2) : 0;
    const area = Math.min(1.6, (this.w * this.h) / (1920 * 1080));
    return Math.round(cfg.count * this.intensity * this.perf * Math.max(0.35, area));
  }

  setKind(kind) {
    if (kind === this.kind) return;
    this.kind = kind && KINDS[kind] ? kind : null;
    this.particles = [];
    this.sprites = [];
    if (this.kind) {
      const cfg = KINDS[this.kind];
      const blur = this.front ? 2.5 : 0;
      const scale = this.front ? 2.1 : 1;
      for (const color of cfg.colors) {
        for (const s of [0.7, 1, 1.35]) this.sprites.push(makeSprite(cfg.sprite, color, Math.round(((cfg.size[0] + cfg.size[1]) / 2) * s * scale), blur));
      }
    }
    this.fit(true);
  }

  setIntensity(v) {
    this.intensity = Math.max(0, Math.min(1, v));
    this.fit();
  }

  /** Adds or removes particles to match the budget. */
  fit(scatter = false) {
    const target = this.budget();
    while (this.particles.length < target) this.particles.push(this.spawn(scatter || this.particles.length < target / 2));
    if (this.particles.length > target) this.particles.length = target;
  }

  spawn(anywhere) {
    const cfg = KINDS[this.kind];
    const depth = this.front ? rand(0.9, 1) : rand(0.35, 1);
    const upward = cfg.fall[1] < 0;
    return {
      x: this.front ? rand(-0.2, 0.4) * this.w : rand(-0.1, 1.1) * this.w,
      y: this.front ? rand(-0.1, 0.3) * this.h : anywhere ? rand(0, this.h) : upward ? this.h + 30 : -30,
      depth,
      sprite: this.sprites[Math.floor(Math.random() * this.sprites.length)],
      fall: rand(cfg.fall[0], cfg.fall[1]) * (0.5 + depth * 0.5) * (this.front ? 1.6 : 1),
      sway: rand(cfg.sway[0], cfg.sway[1]),
      swayFreq: rand(0.3, 0.9),
      phase: rand(0, TAU),
      rot: rand(0, TAU),
      spin: rand(-cfg.spin, cfg.spin),
      flip: rand(0, TAU),
      flipSpeed: rand(0.4, 1) * cfg.flip,
      alpha: this.front ? rand(0.35, 0.55) : rand(0.45, 0.95) * (0.55 + depth * 0.45),
      scale: (this.front ? 1 : 0.55 + depth * 0.55) * rand(0.8, 1.15),
      twinkle: cfg.float ? rand(0.6, 1.6) : 0,
      // Foreground petals only drift past occasionally.
      wait: this.front ? rand(anywhere ? 1 : 4, anywhere ? 8 : 14) : 0,
    };
  }

  start() {
    if (this.running) return;
    this.running = true;
    if (prefersReducedMotion()) {
      this.drawStatic();
      return;
    }
    this.last = performance.now();
    this.raf = requestAnimationFrame((t) => this.tick(t));
  }

  /** Stops animating and clears the canvas (player open, animation off). */
  halt() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.paused = true;
    this.ctx.clearRect(0, 0, this.w, this.h);
  }

  resume() {
    if (!this.running || !this.paused || document.hidden) return;
    this.paused = false;
    if (prefersReducedMotion()) {
      this.drawStatic();
      return;
    }
    this.last = performance.now();
    this.raf = requestAnimationFrame((t) => this.tick(t));
  }

  stop() {
    this.running = false;
    this.halt();
  }

  /** A short burst of wind, e.g. when navigating between pages. */
  gustNow(strength = 1) {
    this.gust = Math.min(3, this.gust + strength);
  }

  /** Reduced motion: a handful of petals resting in place, no animation. */
  drawStatic() {
    this.ctx.clearRect(0, 0, this.w, this.h);
    if (this.front || !this.kind) return;
    const n = Math.min(12, this.particles.length);
    for (let i = 0; i < n; i++) {
      const p = this.particles[i];
      this.drawParticle(p, Math.cos(p.flip));
    }
  }

  drawParticle(p, flipScale) {
    const s = p.sprite;
    const { ctx } = this;
    ctx.save();
    ctx.globalAlpha = p.alpha;
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    ctx.scale(p.scale * (0.35 + Math.abs(flipScale) * 0.65), p.scale);
    ctx.drawImage(s, -s.width / 2, -s.height / 2);
    ctx.restore();
  }

  tick(now) {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.time += dt;
    this.monitor(dt * 1000);

    const cfg = KINDS[this.kind];
    const { ctx } = this;
    ctx.clearRect(0, 0, this.w, this.h);
    if (!cfg) {
      this.raf = requestAnimationFrame((t) => this.tick(t));
      return;
    }
    // Wind: a slow base breeze, periodic gusts, navigation gusts and scroll response.
    const t = this.time;
    const breeze = 18 + Math.sin(t * 0.13) * 14 + Math.sin(t * 0.37 + 1.3) * 9 + Math.max(0, Math.sin(t * 0.07)) * 26;
    this.gust *= Math.pow(0.35, dt);
    this.scrollWind *= Math.pow(0.2, dt);
    const wind = breeze + this.gust * 90;
    const lift = this.scrollWind * 60;

    for (const p of this.particles) {
      if (p.wait > 0) {
        p.wait -= dt;
        continue;
      }
      const sway = Math.sin(t * p.swayFreq + p.phase) * p.sway;
      if (cfg.float) {
        p.x += (sway * 0.6 + wind * 0.15 * p.depth) * dt;
        p.y += (p.fall + Math.cos(t * p.swayFreq * 1.3 + p.phase) * 12 - lift * 0.3) * dt;
        p.alpha = (0.35 + 0.65 * Math.abs(Math.sin(t * p.twinkle + p.phase))) * (0.5 + p.depth * 0.5);
      } else {
        p.x += (wind * p.depth + sway) * dt;
        p.y += (p.fall - lift * p.depth) * dt;
        p.rot += p.spin * dt;
        p.flip += p.flipSpeed * dt;
      }
      const m = 40;
      if (p.y > this.h + m || p.y < -m * 2 || p.x > this.w + m * 2 || p.x < -m * 3) {
        Object.assign(p, this.spawn(false));
        if (!cfg.float && Math.random() < 0.35) {
          // Enter from the upwind edge so the field never thins out on one side.
          p.x = -30;
          p.y = rand(0, this.h * 0.7);
        }
      }
      this.drawParticle(p, cfg.flip ? Math.cos(p.flip) : 1);
    }
    this.raf = requestAnimationFrame((ts) => this.tick(ts));
  }

  /** Adaptive quality: sustained slow frames shed particles; sustained fast frames restore them. */
  monitor(frameMs) {
    this.frameEma = this.frameEma * 0.92 + frameMs * 0.08;
    if (this.frameEma > 24) {
      this.slowFor += frameMs;
      this.fastFor = 0;
      if (this.slowFor > 1500 && this.perf > 0.25) {
        this.perf = Math.max(0.25, this.perf * 0.75);
        this.slowFor = 0;
        this.fit();
      }
    } else if (this.frameEma < 14) {
      this.fastFor += frameMs;
      this.slowFor = 0;
      if (this.fastFor > 6000 && this.perf < 1) {
        this.perf = Math.min(1, this.perf + 0.1);
        this.fastFor = 0;
        this.fit();
      }
    }
  }

  destroy() {
    this.stop();
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('scroll', this.onScroll);
    document.removeEventListener('visibilitychange', this.onVisibility);
  }
}
