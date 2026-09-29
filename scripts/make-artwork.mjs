// Generates Lumina-style key art (posters 2:3 and backdrops 16:9) as SVG for the seed
// catalog. The art is original and abstract — it does not reproduce any studio artwork.
// Backdrops carry no text (the interface sets titles in HTML over them).
//   node scripts/make-artwork.mjs
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'assets', 'art');
mkdirSync(OUT, { recursive: true });

const seed = JSON.parse(readFileSync(join(ROOT, 'data', 'seed', 'catalog.seed.json'), 'utf8'));
const GOLD = '#C6A46A';
const SERIF = "'Cormorant Garamond','Iowan Old Style','Palatino Linotype',Georgia,'Times New Roman',serif";
const SANS = "Inter,'Helvetica Neue',Arial,sans-serif";

function rng(s) {
  let x = 0;
  for (const c of s) x = (x * 31 + c.charCodeAt(0)) >>> 0;
  return () => {
    x = (x + 0x6d2b79f5) >>> 0;
    let t = x;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const f = (n) => Number(n.toFixed(1));

function mountains(r, { w, h, base, peaks, amp, color, opacity = 1 }) {
  let d = `M0 ${h} L0 ${base}`;
  const step = w / peaks;
  for (let i = 0; i <= peaks; i++) {
    const x = i * step;
    const y = base - amp * (0.4 + r() * 0.6);
    d += ` L${f(x - step / 2)} ${f(y)} L${f(x)} ${f(base - amp * 0.15 * r())}`;
  }
  d += ` L${w} ${h} Z`;
  return `<path d="${d}" fill="${color}" opacity="${opacity}"/>`;
}

function hills(r, { w, h, base, amp, color, waves = 3 }) {
  let d = `M0 ${h} L0 ${base}`;
  const seg = w / waves;
  for (let i = 0; i < waves; i++) {
    const x0 = i * seg;
    d += ` Q${f(x0 + seg / 2)} ${f(base - amp * (0.6 + r() * 0.8))} ${f(x0 + seg)} ${f(base + (r() - 0.5) * amp * 0.3)}`;
  }
  return `${d} L${w} ${h} Z`.replace(/^/, `<path fill="${color}" d="`).concat('"/>');
}

function blossoms(r, cx, cy, n, spread, colors) {
  let s = '';
  for (let i = 0; i < n; i++) {
    const a = r() * Math.PI * 2;
    const d = Math.pow(r(), 0.7) * spread;
    s += `<circle cx="${f(cx + Math.cos(a) * d)}" cy="${f(cy + Math.sin(a) * d * 0.75)}" r="${f(2.5 + r() * 7)}" fill="${colors[Math.floor(r() * colors.length)]}" opacity="${f(0.45 + r() * 0.5)}"/>`;
  }
  return s;
}

const MAPLE = [[0, -1], [0.16, -0.62], [0.44, -0.78], [0.36, -0.38], [0.84, -0.5], [0.66, -0.14], [0.96, 0.04], [0.5, 0.22], [0.56, 0.5], [0.14, 0.34], [0.05, 0.58], [0.03, 0.98], [-0.03, 0.98], [-0.05, 0.58], [-0.14, 0.34], [-0.56, 0.5], [-0.5, 0.22], [-0.96, 0.04], [-0.66, -0.14], [-0.84, -0.5], [-0.36, -0.38], [-0.44, -0.78], [-0.16, -0.62]];

function mapleLeaf(x, y, s, rot, color, op = 0.9) {
  const d = MAPLE.map(([px, py], i) => `${i ? 'L' : 'M'}${f(px * s)} ${f(py * s)}`).join('');
  return `<path d="${d}Z" fill="${color}" opacity="${op}" transform="translate(${f(x)} ${f(y)}) rotate(${f(rot)})"/>`;
}

function petal(x, y, s, rot, color, op = 0.85) {
  return `<path d="M0 ${s}C${-s * 0.95} ${s * 0.35} ${-s * 0.8} ${-s * 0.75} ${-s * 0.18} ${-s * 0.95}L0 ${-s * 0.72}L${s * 0.18} ${-s * 0.95}C${s * 0.8} ${-s * 0.75} ${s * 0.95} ${s * 0.35} 0 ${s}Z" fill="${color}" opacity="${op}" transform="translate(${f(x)} ${f(y)}) rotate(${f(rot)})"/>`;
}

function roof(cx, y, w, top, rise, color) {
  const l = cx - w / 2;
  const r = cx + w / 2;
  return `<path fill="${color}" d="M${l} ${y - 7}Q${l + 26} ${y + 3} ${l + 50} ${y + 4}L${r - 50} ${y + 4}Q${r - 26} ${y + 3} ${r} ${y - 7}L${r - 6} ${y - 9}Q${cx + top / 2 + 18} ${y - 8} ${cx + top / 2} ${y - rise}L${cx - top / 2} ${y - rise}Q${cx - top / 2 - 18} ${y - 8} ${l + 6} ${y - 9}Z"/>`;
}

function gear(cx, cy, r, teeth, color, op = 1) {
  let d = '';
  const n = teeth * 2;
  for (let i = 0; i < n; i++) {
    const a1 = (i / n) * Math.PI * 2;
    const a2 = ((i + 1) / n) * Math.PI * 2;
    const rr = i % 2 === 0 ? r : r * 0.84;
    d += `${i ? 'L' : 'M'}${f(cx + Math.cos(a1) * rr)} ${f(cy + Math.sin(a1) * rr)}L${f(cx + Math.cos(a2) * rr)} ${f(cy + Math.sin(a2) * rr)}`;
  }
  return `<path d="${d}Z" fill="${color}" opacity="${op}"/><circle cx="${cx}" cy="${cy}" r="${f(r * 0.32)}" fill="#120c08" opacity="${op}"/>`;
}

// ── Motifs: draw into a W×H frame. `focusX` shifts the main subject (backdrops keep the left dark). ──
const MOTIFS = {
  sintel(r, W, H, p, focusX) {
    const moonX = W * focusX;
    let s = `<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1b2530"/><stop offset=".6" stop-color="${p[1]}"/><stop offset="1" stop-color="#0d1318"/></linearGradient>
      <radialGradient id="moon"><stop offset="0" stop-color="${p[3]}" stop-opacity=".55"/><stop offset="1" stop-color="${p[3]}" stop-opacity="0"/></radialGradient></defs>
      <rect width="${W}" height="${H}" fill="url(#sky)"/>
      <circle cx="${moonX}" cy="${H * 0.34}" r="${H * 0.36}" fill="url(#moon)"/>
      <circle cx="${moonX}" cy="${H * 0.34}" r="${H * 0.14}" fill="${p[3]}" opacity=".92"/>`;
    // A great wing sweeping across the moon
    const wx = moonX - H * 0.3;
    const wy = H * 0.3;
    const u = H / 900;
    s += `<path fill="#141a20" opacity=".9" d="M${f(wx)} ${f(wy + 60 * u)} C${f(wx + 120 * u)} ${f(wy - 80 * u)} ${f(wx + 300 * u)} ${f(wy - 60 * u)} ${f(wx + 420 * u)} ${f(wy - 120 * u)} C${f(wx + 380 * u)} ${f(wy - 20 * u)} ${f(wx + 330 * u)} ${f(wy + 10 * u)} ${f(wx + 300 * u)} ${f(wy + 60 * u)} C${f(wx + 260 * u)} ${f(wy + 20 * u)} ${f(wx + 220 * u)} ${f(wy + 40 * u)} ${f(wx + 190 * u)} ${f(wy + 80 * u)} C${f(wx + 160 * u)} ${f(wy + 40 * u)} ${f(wx + 110 * u)} ${f(wy + 50 * u)} ${f(wx + 80 * u)} ${f(wy + 90 * u)} C${f(wx + 60 * u)} ${f(wy + 60 * u)} ${f(wx + 30 * u)} ${f(wy + 60 * u)} ${f(wx)} ${f(wy + 60 * u)}Z"/>`;
    s += mountains(r, { w: W, h: H, base: H * 0.72, peaks: 5, amp: H * 0.22, color: '#2c3a47', opacity: 0.95 });
    s += mountains(r, { w: W, h: H, base: H * 0.84, peaks: 7, amp: H * 0.14, color: '#1a232c' });
    // Snowfall and a small figure with a red scarf
    for (let i = 0; i < 90; i++) s += `<circle cx="${f(r() * W)}" cy="${f(r() * H)}" r="${f(0.8 + r() * 2.2)}" fill="#f4f1ea" opacity="${f(0.3 + r() * 0.5)}"/>`;
    const fx = W * (focusX - 0.08);
    const fy = H * 0.84;
    s += `<g transform="translate(${f(fx)} ${f(fy)}) scale(${f(u * 1.4)})"><path d="M0 0 L-9 -40 Q0 -52 9 -40 Z" fill="#0b0f13"/><circle cx="0" cy="-50" r="7" fill="#0b0f13"/><path d="M-4 -42 Q-24 -40 -36 -30" stroke="${p[2]}" stroke-width="4" fill="none" stroke-linecap="round"/></g>`;
    return s;
  },
  'big-buck-bunny'(r, W, H, p, focusX) {
    const u = H / 900;
    let s = `<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6fa7c9"/><stop offset=".55" stop-color="${p[3]}"/><stop offset="1" stop-color="#e9f3dc"/></linearGradient></defs>
      <rect width="${W}" height="${H}" fill="url(#sky)"/>
      <circle cx="${f(W * focusX + 120 * u)}" cy="${f(H * 0.22)}" r="${f(80 * u)}" fill="${p[1]}" opacity=".95"/>`;
    s += hills(r, { w: W, h: H, base: H * 0.66, amp: H * 0.12, color: '#9cc26a', waves: 3 });
    s += hills(r, { w: W, h: H, base: H * 0.78, amp: H * 0.1, color: p[0], waves: 4 });
    s += hills(r, { w: W, h: H, base: H * 0.9, amp: H * 0.06, color: p[2], waves: 5 });
    // A big, round, gentle rabbit on the middle hill
    const bx = W * focusX;
    const by = H * 0.7;
    s += `<g transform="translate(${f(bx)} ${f(by)}) scale(${f(u)})">
      <ellipse cx="-34" cy="-230" rx="20" ry="72" fill="#e8e3da" transform="rotate(-12 -34 -230)"/><ellipse cx="34" cy="-226" rx="20" ry="70" fill="#e8e3da" transform="rotate(14 34 -226)"/>
      <ellipse cx="-34" cy="-228" rx="9" ry="52" fill="#f0b8c0" transform="rotate(-12 -34 -228)"/><ellipse cx="34" cy="-224" rx="9" ry="50" fill="#f0b8c0" transform="rotate(14 34 -224)"/>
      <ellipse cx="0" cy="-60" rx="120" ry="110" fill="#e8e3da"/><circle cx="0" cy="-150" r="70" fill="#efeae1"/>
      <circle cx="-24" cy="-160" r="8" fill="#2a2420"/><circle cx="24" cy="-160" r="8" fill="#2a2420"/><ellipse cx="0" cy="-138" rx="10" ry="7" fill="#e79aa6"/></g>`;
    // Butterflies and flowers
    for (let i = 0; i < 6; i++) {
      const x = r() * W;
      const y = H * (0.3 + r() * 0.3);
      const c = ['#f2c14e', '#e9748a', '#ffffff', '#9ad0f5'][i % 4];
      s += `<g transform="translate(${f(x)} ${f(y)}) rotate(${f(r() * 40 - 20)}) scale(${f(u)})"><ellipse cx="-9" cy="0" rx="10" ry="14" fill="${c}"/><ellipse cx="9" cy="0" rx="10" ry="14" fill="${c}"/><rect x="-1.5" y="-10" width="3" height="20" fill="#2a2420"/></g>`;
    }
    for (let i = 0; i < 70; i++) s += `<circle cx="${f(r() * W)}" cy="${f(H * (0.8 + r() * 0.2))}" r="${f(2 + r() * 4)}" fill="${['#ffffff', '#f2c14e', '#e98aa6'][i % 3]}" opacity=".85"/>`;
    return s;
  },
  'tears-of-steel'(r, W, H, p, focusX) {
    const u = H / 900;
    let s = `<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0c161c"/><stop offset=".7" stop-color="${p[0]}"/><stop offset="1" stop-color="#0a1116"/></linearGradient>
      <radialGradient id="eye"><stop offset="0" stop-color="${p[2]}" stop-opacity=".9"/><stop offset=".45" stop-color="${p[2]}" stop-opacity=".25"/><stop offset="1" stop-color="${p[2]}" stop-opacity="0"/></radialGradient></defs>
      <rect width="${W}" height="${H}" fill="url(#sky)"/>`;
    const ex = W * focusX;
    const ey = H * 0.38;
    s += `<circle cx="${ex}" cy="${ey}" r="${f(260 * u)}" fill="url(#eye)"/>`;
    for (const k of [150, 110, 72]) s += `<circle cx="${ex}" cy="${ey}" r="${f(k * u)}" fill="none" stroke="${p[2]}" stroke-width="${f(3 * u)}" opacity="${f(k / 220)}"/>`;
    s += `<circle cx="${ex}" cy="${ey}" r="${f(26 * u)}" fill="${p[2]}"/>`;
    // Canal houses with stepped gables
    let x = -10;
    while (x < W) {
      const w = (60 + r() * 60) * u;
      const hgt = (220 + r() * 160) * u;
      const top = H * 0.86 - hgt;
      s += `<path fill="#081015" d="M${f(x)} ${H} L${f(x)} ${f(top + 40 * u)} L${f(x + w * 0.2)} ${f(top + 40 * u)} L${f(x + w * 0.2)} ${f(top + 18 * u)} L${f(x + w * 0.35)} ${f(top + 18 * u)} L${f(x + w * 0.5)} ${f(top)} L${f(x + w * 0.65)} ${f(top + 18 * u)} L${f(x + w * 0.8)} ${f(top + 18 * u)} L${f(x + w * 0.8)} ${f(top + 40 * u)} L${f(x + w)} ${f(top + 40 * u)} L${f(x + w)} ${H}Z"/>`;
      for (let wi = 0; wi < 3; wi++) if (r() > 0.55) s += `<rect x="${f(x + w * (0.2 + wi * 0.22))}" y="${f(top + (80 + r() * 100) * u)}" width="${f(10 * u)}" height="${f(16 * u)}" fill="${p[2]}" opacity=".7"/>`;
      x += w + 4 * u;
    }
    // Canal reflection and rain
    s += `<rect y="${f(H * 0.86)}" width="${W}" height="${f(H * 0.14)}" fill="#050a0d"/>`;
    for (let i = 0; i < 12; i++) s += `<rect x="${f(r() * W)}" y="${f(H * 0.87 + r() * H * 0.1)}" width="${f((40 + r() * 120) * u)}" height="${f(2 * u)}" fill="${p[2]}" opacity="${f(0.15 + r() * 0.3)}"/>`;
    for (let i = 0; i < 140; i++) {
      const rx = r() * W;
      const ry = r() * H;
      s += `<path d="M${f(rx)} ${f(ry)} l${f(-8 * u)} ${f(26 * u)}" stroke="${p[3]}" stroke-width="1" opacity="${f(0.12 + r() * 0.2)}"/>`;
    }
    return s;
  },
  'elephants-dream'(r, W, H, p, focusX) {
    const u = H / 900;
    let s = `<defs><radialGradient id="glow" cx="${focusX}" cy=".45" r=".6"><stop offset="0" stop-color="${p[3]}" stop-opacity=".55"/><stop offset="1" stop-color="${p[2]}" stop-opacity="0"/></radialGradient></defs>
      <rect width="${W}" height="${H}" fill="${p[2]}"/><rect width="${W}" height="${H}" fill="url(#glow)"/>`;
    for (let i = 0; i < 9; i++) s += gear(W * (focusX - 0.3 + r() * 0.6), H * (0.1 + r() * 0.8), (60 + r() * 150) * u, 10 + Math.floor(r() * 10), i % 2 ? p[1] : p[0], 0.35 + r() * 0.5);
    for (let i = 0; i < 14; i++) {
      const y0 = r() * H;
      s += `<path d="M-20 ${f(y0)} C${f(W * 0.3)} ${f(y0 + (r() - 0.5) * 300 * u)} ${f(W * 0.6)} ${f(y0 + (r() - 0.5) * 300 * u)} ${W + 20} ${f(y0 + (r() - 0.5) * 200 * u)}" stroke="#1a110b" stroke-width="${f((3 + r() * 6) * u)}" fill="none" opacity=".8"/>`;
    }
    // A lit doorway at the vanishing point
    const dx = W * focusX;
    s += `<rect x="${f(dx - 24 * u)}" y="${f(H * 0.52)}" width="${f(48 * u)}" height="${f(90 * u)}" fill="${p[3]}" opacity=".95"/><path d="M${f(dx - 5 * u)} ${f(H * 0.52 + 90 * u)} l-3 ${f(-26 * u)} l6 0 z" fill="#1a110b"/>`;
    return s;
  },
  hanami(r, W, H, p, focusX) {
    const u = H / 900;
    let s = `<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#140910"/><stop offset=".6" stop-color="#3a1627"/><stop offset="1" stop-color="#0c0709"/></linearGradient>
      <radialGradient id="moon"><stop offset="0" stop-color="#f6e3d6" stop-opacity=".5"/><stop offset="1" stop-color="#f6e3d6" stop-opacity="0"/></radialGradient></defs>
      <rect width="${W}" height="${H}" fill="url(#sky)"/>
      <circle cx="${f(W * focusX)}" cy="${f(H * 0.4)}" r="${f(300 * u)}" fill="url(#moon)"/><circle cx="${f(W * focusX)}" cy="${f(H * 0.4)}" r="${f(110 * u)}" fill="#f6e3d6" opacity=".9"/>`;
    // Temple roofline
    const cx = W * focusX;
    s += `<g transform="translate(0 ${f(H * 0.08)})">${roof(cx, H * 0.8, 520 * u, 200 * u, 50 * u, '#0a0508')}${roof(cx, H * 0.72, 280 * u, 80 * u, 36 * u, '#0a0508')}<rect x="${f(cx - 140 * u)}" y="${f(H * 0.72 + 4 * u)}" width="${f(280 * u)}" height="${f(40 * u)}" fill="#0a0508"/></g>`;
    s += `<rect y="${f(H * 0.92)}" width="${W}" height="${f(H * 0.08)}" fill="#070405"/>`;
    // Sakura branch from the top corner
    s += `<path d="M${f(W + 20)} ${f(-20)} Q${f(W * 0.7)} ${f(H * 0.15)} ${f(W * (focusX - 0.25))} ${f(H * 0.22)}" stroke="#2a1418" stroke-width="${f(14 * u)}" fill="none" stroke-linecap="round"/>`;
    for (let i = 0; i < 6; i++) s += blossoms(r, W * (focusX - 0.2 + i * 0.12), H * (0.12 + r() * 0.12), 30, 50 * u, ['#f6c1cf', '#f1a7bd', '#d8708f']);
    for (let i = 0; i < 40; i++) s += petal(r() * W, r() * H, (6 + r() * 8) * u, r() * 360, ['#f6c1cf', '#f1a7bd'][i % 2], 0.4 + r() * 0.5);
    return s;
  },
  'koyo-autumn-pavilion'(r, W, H, p, focusX) {
    const u = H / 900;
    let s = `<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1a0c07"/><stop offset=".55" stop-color="#5a2a12"/><stop offset=".62" stop-color="${p[1]}"/><stop offset="1" stop-color="#120905"/></linearGradient></defs>
      <rect width="${W}" height="${H}" fill="url(#sky)"/>`;
    const cx = W * focusX;
    const water = H * 0.64;
    const pav = `${roof(cx, water - 90 * u, 360 * u, 120 * u, 44 * u, '#140905')}<rect x="${f(cx - 110 * u)}" y="${f(water - 86 * u)}" width="${f(220 * u)}" height="${f(70 * u)}" fill="#140905"/><rect x="${f(cx - 100 * u)}" y="${f(water - 76 * u)}" width="${f(200 * u)}" height="${f(40 * u)}" fill="#ffc36b" opacity=".45"/>${roof(cx, water - 150 * u, 200 * u, 60 * u, 34 * u, '#140905')}<rect x="${f(cx - 150 * u)}" y="${f(water - 16 * u)}" width="${f(300 * u)}" height="${f(16 * u)}" fill="#140905"/>`;
    s += pav;
    s += `<rect y="${f(water)}" width="${W}" height="${f(H - water)}" fill="#0f0704"/><g opacity=".32" transform="translate(0 ${f(water * 2)}) scale(1 -1)">${pav}</g>`;
    for (let i = 0; i < 70; i++) s += mapleLeaf(r() * W, r() * H, (8 + r() * 16) * u, r() * 360, [p[0], p[1], '#c9471f', '#f0a23b'][i % 4], 0.5 + r() * 0.45);
    return s;
  },
  'garden-hours'(r, W, H, p, focusX) {
    const u = H / 900;
    let s = `<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#070a12"/><stop offset=".7" stop-color="${p[0]}"/><stop offset="1" stop-color="#05070b"/></linearGradient>
      <radialGradient id="glow"><stop offset="0" stop-color="${p[2]}" stop-opacity=".6"/><stop offset=".4" stop-color="${p[2]}" stop-opacity=".15"/><stop offset="1" stop-color="${p[2]}" stop-opacity="0"/></radialGradient></defs>
      <rect width="${W}" height="${H}" fill="url(#sky)"/>`;
    for (let i = 0; i < 70; i++) s += `<circle cx="${f(r() * W)}" cy="${f(r() * H * 0.5)}" r="${f(0.6 + r() * 1.4)}" fill="#f4f1e6" opacity="${f(0.3 + r() * 0.6)}"/>`;
    s += `<circle cx="${f(W * (focusX + 0.18))}" cy="${f(H * 0.2)}" r="${f(46 * u)}" fill="#f4f1e6" opacity=".85"/>`;
    // A stone lantern, lit
    const lx = W * focusX;
    const ly = H * 0.8;
    const stone = '#2a2b31';
    s += `<circle cx="${f(lx)}" cy="${f(ly - 170 * u)}" r="${f(220 * u)}" fill="url(#glow)"/>
      <g transform="translate(${f(lx)} ${f(ly)}) scale(${f(u * 2.1)})"><rect x="-24" y="-6" width="48" height="10" rx="2" fill="${stone}"/><rect x="-7" y="-40" width="14" height="36" fill="${stone}"/><rect x="-20" y="-48" width="40" height="9" rx="2" fill="${stone}"/><rect x="-15" y="-76" width="30" height="28" fill="${stone}"/><rect x="-9" y="-71" width="18" height="18" fill="${p[2]}"/><path d="M-34 -76 Q-18 -82 -10 -98 L10 -98 Q18 -82 34 -76 Z" fill="${stone}"/><circle cx="0" cy="-104" r="6" fill="${stone}"/></g>`;
    s += `<rect y="${f(H * 0.8)}" width="${W}" height="${f(H * 0.2)}" fill="#05070b"/>`;
    // Each season in the air: petals, fireflies, snow, embers
    for (let i = 0; i < 18; i++) s += petal(r() * W * 0.5, r() * H * 0.8, (5 + r() * 6) * u, r() * 360, p[1], 0.6);
    for (let i = 0; i < 40; i++) s += `<circle cx="${f(W * 0.5 + r() * W * 0.5)}" cy="${f(r() * H * 0.8)}" r="${f(1.5 + r() * 2.5)}" fill="#ffffff" opacity="${f(0.3 + r() * 0.5)}"/>`;
    return s;
  },
};

function titleLines(title, maxChars) {
  const words = title.split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > maxChars && cur) {
      lines.push(cur);
      cur = w;
    } else cur = `${cur} ${w}`.trim();
  }
  if (cur) lines.push(cur);
  return lines;
}

function poster(t) {
  const W = 600;
  const H = 900;
  const r = rng(t.id);
  const motif = MOTIFS[t.id];
  const lines = titleLines(t.title.toUpperCase(), 13);
  const size = lines.length > 1 ? 50 : t.title.length > 10 ? 54 : 64;
  const eyebrow = (t.tags || []).includes('lumina-original') ? 'A LUMINA ORIGINAL' : `${t.year} · ${t.type === 'series' ? 'SERIES' : 'FILM'}`;
  const baseY = H - 120 - (lines.length - 1) * (size + 6);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(t.title)} — Lumina key art">
<title>${esc(t.title)}</title>
${motif(r, W, H, t.palette, 0.5)}
<rect width="${W}" height="${H}" fill="url(#vig)"/>
<defs><linearGradient id="vig" x1="0" y1="0" x2="0" y2="1"><stop offset=".55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".78"/></linearGradient></defs>
<rect x="18" y="18" width="${W - 36}" height="${H - 36}" fill="none" stroke="${GOLD}" stroke-opacity=".38" stroke-width="1.2"/>
<text x="${W / 2}" y="64" text-anchor="middle" font-family="${SANS}" font-size="15" font-weight="600" letter-spacing="5" fill="${GOLD}">${esc(eyebrow)}</text>
${lines.map((l, i) => `<text x="${W / 2}" y="${baseY + i * (size + 6)}" text-anchor="middle" font-family="${SERIF}" font-size="${size}" font-weight="600" letter-spacing="${size > 55 ? 8 : 5}" fill="#F8F5F2">${esc(l)}</text>`).join('\n')}
${t.originalTitle ? `<text x="${W / 2}" y="${baseY + lines.length * (size + 6) + 4}" text-anchor="middle" font-family="'Shippori Mincho','Hiragino Mincho ProN','Yu Mincho',serif" font-size="26" letter-spacing="10" fill="${GOLD}">${esc(t.originalTitle)}</text>` : ''}
${t.tagline ? `<text x="${W / 2}" y="${H - 48}" text-anchor="middle" font-family="${SERIF}" font-style="italic" font-size="19" fill="#d9d2cf" fill-opacity=".9">${esc(t.tagline)}</text>` : ''}
</svg>
`;
}

function backdrop(t) {
  const W = 1920;
  const H = 1080;
  const r = rng(`${t.id}-backdrop`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(t.title)} — backdrop art">
<title>${esc(t.title)}</title>
${MOTIFS[t.id](r, W, H, t.palette, 0.66)}
</svg>
`;
}

let n = 0;
for (const t of seed.titles) {
  if (!MOTIFS[t.id]) {
    console.warn(`No motif for ${t.id}; skipping`);
    continue;
  }
  writeFileSync(join(OUT, `${t.id}-poster.svg`), poster(t));
  writeFileSync(join(OUT, `${t.id}-backdrop.svg`), backdrop(t));
  n++;
}
console.log(`Wrote key art for ${n} titles to assets/art/`);
