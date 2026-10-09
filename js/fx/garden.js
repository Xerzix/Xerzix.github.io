// The Lumina garden: a layered temple scene drawn in SVG (sky, mountains, mist, temple hall,
// five-storey pagoda, vermilion bridge, reflecting pond, stone lanterns, illuminated path,
// wooden walkway and framing cherry branches). Colours come from CSS variables so each
// environment re-tints the same scene. Layers carry a depth factor for parallax.
import { h, prefersReducedMotion } from '../core/dom.js';

export const ENVIRONMENTS = [
  { id: 'sakura', name: 'Cherry Blossom Garden', particles: 'petals', description: 'Dusk light, drifting sakura petals.' },
  { id: 'moonlit', name: 'Moonlit Temple', particles: 'fireflies', description: 'A full moon, fireflies over still water.' },
  { id: 'autumn', name: 'Autumn Garden', particles: 'leaves', description: 'Maple leaves in golden evening light.' },
  { id: 'snow', name: 'Snow-Covered Pavilion', particles: 'snow', description: 'Soft snowfall on quiet roofs.' },
  { id: 'lantern', name: 'Lantern-Lit Courtyard', particles: 'embers', description: 'Warm lanterns and rising embers.' },
  { id: 'none', name: 'No environment', particles: 'none', description: 'A plain background for focus.' },
];

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const layer = (depth, ...children) => h('g', { 'data-depth': String(depth), style: { '--d': depth } }, ...children);

function quadPoint(p0, p1, p2, t) {
  const u = 1 - t;
  return [u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]];
}

/** Roof with upturned eaves, centred on cx, eave line at y. */
function roofPath(cx, y, w, top, rise = 20) {
  const l = cx - w / 2;
  const r = cx + w / 2;
  return `M${l} ${y - 7} Q${l + 26} ${y + 3} ${l + 50} ${y + 4} L${r - 50} ${y + 4} Q${r - 26} ${y + 3} ${r} ${y - 7}
          L${r - 6} ${y - 9} Q${cx + top / 2 + 18} ${y - 8} ${cx + top / 2} ${y - rise} L${cx - top / 2} ${y - rise} Q${cx - top / 2 - 18} ${y - 8} ${l + 6} ${y - 9} Z`;
}

function snowCap(cx, y, w, top, rise = 20) {
  const l = cx - w / 2;
  const r = cx + w / 2;
  return `M${l + 6} ${y - 9} Q${cx - top / 2 - 18} ${y - 8} ${cx - top / 2} ${y - rise} L${cx + top / 2} ${y - rise} Q${cx + top / 2 + 18} ${y - 8} ${r - 6} ${y - 9}`;
}

function templeHall() {
  const g = h('g', { class: 'lm-temple' });
  // Platform, steps and body
  g.append(
    h('rect', { x: 150, y: 626, width: 330, height: 12, fill: 'var(--env-structure)' }),
    h('rect', { x: 285, y: 636, width: 60, height: 8, fill: 'var(--env-structure)' }),
    h('rect', { x: 190, y: 556, width: 250, height: 72, fill: 'var(--env-structure)' }),
  );
  // Glowing shoji screens
  for (let i = 0; i < 5; i++) {
    g.append(h('rect', { x: 202 + i * 47, y: 568, width: 38, height: 50, fill: 'var(--env-light)', opacity: i === 2 ? 0.62 : 0.4, class: 'lm-window' }));
    g.append(h('path', { d: `M${221 + i * 47} 568v50M${202 + i * 47} 585h38M${202 + i * 47} 601h38`, stroke: 'var(--env-structure)', 'stroke-width': 2, opacity: 0.7 }));
  }
  // Columns
  for (let i = 0; i < 6; i++) g.append(h('rect', { x: 196 + i * 47, y: 556, width: 4, height: 72, fill: 'var(--env-structure)' }));
  // Lower and upper roofs
  g.append(h('path', { d: roofPath(315, 556, 470, 190, 46), fill: 'var(--env-structure)' }));
  g.append(h('rect', { x: 240, y: 484, width: 150, height: 30, fill: 'var(--env-structure)' }));
  g.append(h('path', { d: roofPath(315, 488, 250, 70, 36), fill: 'var(--env-structure)' }));
  g.append(h('path', { d: 'M270 452h90', stroke: 'var(--env-structure)', 'stroke-width': 5, 'stroke-linecap': 'round' }));
  // Snow caps
  g.append(h('path', { class: 'env-only env-snow', d: snowCap(315, 556, 470, 190, 46), fill: 'none', stroke: 'var(--env-foliage)', 'stroke-width': 5, 'stroke-linecap': 'round', opacity: 0.85 }));
  g.append(h('path', { class: 'env-only env-snow', d: snowCap(315, 488, 250, 70, 36), fill: 'none', stroke: 'var(--env-foliage)', 'stroke-width': 4, 'stroke-linecap': 'round', opacity: 0.85 }));
  // Rim light along the eaves
  g.append(h('path', { d: 'M86 552 Q110 560 130 560 L500 560 Q520 560 544 552', fill: 'none', stroke: 'var(--env-light)', 'stroke-width': 1.2, opacity: 0.35 }));
  return g;
}

function pagoda(cx = 1300, base = 640) {
  const g = h('g', { class: 'lm-pagoda' });
  g.append(h('rect', { x: cx - 90, y: base - 6, width: 180, height: 12, fill: 'var(--env-structure)' }));
  let y = base - 44;
  let w = 250;
  const tiers = 5;
  const roofs = [];
  for (let i = 0; i < tiers; i++) {
    const bodyW = w * 0.46;
    const bodyTop = y;
    const bodyBottom = i === 0 ? base - 6 : y + 38;
    g.append(h('rect', { x: cx - bodyW / 2, y: bodyTop, width: bodyW, height: bodyBottom - bodyTop, fill: 'var(--env-structure)' }));
    g.append(h('rect', { x: cx - 7, y: bodyTop + 10, width: 14, height: Math.max(12, bodyBottom - bodyTop - 18), fill: 'var(--env-light)', opacity: 0.45 - i * 0.05, class: 'lm-window' }));
    roofs.push({ y, w, top: bodyW * 0.72 });
    y -= 58;
    w -= 34;
  }
  for (const r of roofs) {
    g.append(h('path', { d: roofPath(cx, r.y, r.w, r.top, 20), fill: 'var(--env-structure)' }));
    g.append(h('path', { class: 'env-only env-snow', d: snowCap(cx, r.y, r.w, r.top, 20), fill: 'none', stroke: 'var(--env-foliage)', 'stroke-width': 3.5, 'stroke-linecap': 'round', opacity: 0.85 }));
  }
  // Spire (sōrin) with rings and finial
  const top = roofs[tiers - 1].y - 20;
  g.append(h('rect', { x: cx - 2.5, y: top - 86, width: 5, height: 86, fill: 'var(--env-structure)' }));
  for (let i = 0; i < 7; i++) g.append(h('rect', { x: cx - 9 + i * 0.6, y: top - 14 - i * 9, width: 18 - i * 1.2, height: 3, rx: 1.5, fill: 'var(--env-structure)' }));
  g.append(h('circle', { cx, cy: top - 92, r: 5, fill: 'var(--env-structure)' }));
  return g;
}

function bridge() {
  const g = h('g', { class: 'lm-bridge' });
  const deckTop = [[520, 712], [800, 600], [1080, 712]];
  const railTop = [[534, 690], [800, 572], [1066, 690]];
  const wood = 'color-mix(in srgb, var(--lm-accent) 62%, #050303)';
  g.append(h('path', { d: `M520 712 Q800 600 1080 712 L1080 724 Q800 616 520 724 Z`, fill: wood }));
  g.append(h('path', { d: `M534 690 Q800 572 1066 690`, fill: 'none', stroke: wood, 'stroke-width': 5, 'stroke-linecap': 'round' }));
  g.append(h('path', { d: `M534 690 Q800 572 1066 690`, fill: 'none', stroke: 'var(--env-light)', 'stroke-width': 1, opacity: 0.35 }));
  for (let i = 0; i <= 12; i++) {
    const t = i / 12;
    const [x1, y1] = quadPoint(...railTop, t);
    const [x2, y2] = quadPoint(...deckTop, t);
    g.append(h('path', { d: `M${x1} ${y1}L${x2} ${y2 - 2}`, stroke: wood, 'stroke-width': i % 3 === 0 ? 5 : 2.5 }));
  }
  // Posts into the water
  for (const x of [560, 690, 910, 1040]) {
    const [, y] = quadPoint(...deckTop, (x - 520) / 560);
    g.append(h('rect', { x: x - 4, y: y + 10, width: 8, height: 740 - y, fill: wood }));
  }
  g.append(h('path', { class: 'env-only env-snow', d: 'M534 688 Q800 570 1066 688', fill: 'none', stroke: 'var(--env-foliage)', 'stroke-width': 2.5, opacity: 0.8 }));
  return g;
}

function stoneLantern(x, y, s = 1, id) {
  const g = h('g', { transform: `translate(${x} ${y}) scale(${s})` });
  const stone = 'color-mix(in srgb, var(--env-structure) 70%, #3b3432)';
  g.append(
    h('circle', { cx: 0, cy: -58, r: 70, fill: `url(#${id}-glow)`, class: 'lm-lantern-glow' }),
    h('rect', { x: -24, y: -6, width: 48, height: 10, rx: 2, fill: stone }),
    h('rect', { x: -7, y: -40, width: 14, height: 36, fill: stone }),
    h('rect', { x: -20, y: -48, width: 40, height: 9, rx: 2, fill: stone }),
    h('rect', { x: -15, y: -76, width: 30, height: 28, fill: stone }),
    h('rect', { x: -9, y: -71, width: 18, height: 18, fill: 'var(--env-light)', opacity: 0.9, class: 'lm-lantern-glow' }),
    h('path', { d: 'M-34 -76 Q-18 -82 -10 -98 L10 -98 Q18 -82 34 -76 Z', fill: stone }),
    h('circle', { cx: 0, cy: -104, r: 6, fill: stone }),
    h('path', { class: 'env-only env-snow', d: 'M-32 -78 Q-18 -84 -10 -99 L10 -99 Q18 -84 32 -78', fill: 'none', stroke: 'var(--env-foliage)', 'stroke-width': 3, opacity: 0.85 }),
  );
  return g;
}

function blossomBranch(r, { from, ctrl, to, clusters, width = 12 }, detail) {
  const g = h('g', { class: 'lm-branch' });
  const bark = 'color-mix(in srgb, var(--env-structure) 60%, #2a1a1a)';
  g.append(h('path', { d: `M${from[0]} ${from[1]} Q${ctrl[0]} ${ctrl[1]} ${to[0]} ${to[1]}`, fill: 'none', stroke: bark, 'stroke-width': width, 'stroke-linecap': 'round' }));
  const twigs = [];
  for (let i = 0; i < clusters; i++) {
    const t = 0.25 + (i / clusters) * 0.75;
    const [x, y] = quadPoint(from, ctrl, to, t);
    const len = 40 + r() * 90;
    const ang = (r() > 0.5 ? -1 : 1) * (0.5 + r() * 0.9) - Math.PI / 2 * (r() > 0.7 ? 0 : 0.3);
    const tx = x + Math.cos(ang) * len;
    const ty = y + Math.sin(ang) * len * 0.8;
    g.append(h('path', { d: `M${x} ${y} Q${(x + tx) / 2 + (r() - 0.5) * 20} ${(y + ty) / 2 - 10} ${tx} ${ty}`, fill: 'none', stroke: bark, 'stroke-width': Math.max(2, width * 0.35), 'stroke-linecap': 'round' }));
    twigs.push([tx, ty], [x, y]);
  }
  const blossoms = h('g', { class: 'lm-blossoms' });
  const per = detail === 'lite' ? 14 : 30;
  for (const [cx, cy] of twigs) {
    for (let i = 0; i < per; i++) {
      const a = r() * Math.PI * 2;
      const d = Math.pow(r(), 0.7) * 46;
      blossoms.append(h('circle', {
        cx: (cx + Math.cos(a) * d).toFixed(1),
        cy: (cy + Math.sin(a) * d * 0.75).toFixed(1),
        r: (2.5 + r() * 6).toFixed(1),
        fill: r() > 0.35 ? 'var(--env-foliage)' : 'var(--env-foliage-2)',
        opacity: (0.45 + r() * 0.5).toFixed(2),
      }));
    }
  }
  g.append(blossoms);
  return g;
}

/**
 * Builds the scene. detail: 'full' | 'lite' (fewer blossoms, for small screens and the intro).
 * idPrefix keeps gradient ids unique when the scene appears twice (background + intro).
 */
export function buildScene({ detail = 'full', idPrefix = 'g', seed = 11 } = {}) {
  const r = rng(seed);
  const id = (s) => `${idPrefix}-${s}`;
  const svg = h('svg', { xmlns: 'http://www.w3.org/2000/svg', viewBox: '0 0 1600 900', preserveAspectRatio: 'xMidYMax slice', 'aria-hidden': 'true', focusable: 'false' });

  svg.append(h('defs', null,
    h('linearGradient', { id: id('sky'), x1: 0, y1: 0, x2: 0, y2: 1 },
      h('stop', { offset: '0', 'stop-color': 'var(--env-sky-top)' }),
      h('stop', { offset: '0.55', 'stop-color': 'var(--env-sky-mid)' }),
      h('stop', { offset: '1', 'stop-color': 'var(--env-sky-low)' })),
    h('radialGradient', { id: id('horizon'), cx: 0.55, cy: 0.62, r: 0.5 },
      h('stop', { offset: '0', 'stop-color': 'var(--env-light)', 'stop-opacity': '0.28' }),
      h('stop', { offset: '1', 'stop-color': 'var(--env-light)', 'stop-opacity': '0' })),
    h('radialGradient', { id: id('moon') },
      h('stop', { offset: '0', 'stop-color': 'var(--env-moon)', 'stop-opacity': '0.5' }),
      h('stop', { offset: '1', 'stop-color': 'var(--env-moon)', 'stop-opacity': '0' })),
    h('linearGradient', { id: id('mist'), x1: 0, y1: 0, x2: 0, y2: 1 },
      h('stop', { offset: '0', 'stop-color': 'var(--env-mist)', 'stop-opacity': '0' }),
      h('stop', { offset: '0.5', 'stop-color': 'var(--env-mist)' }),
      h('stop', { offset: '1', 'stop-color': 'var(--env-mist)', 'stop-opacity': '0' })),
    h('linearGradient', { id: id('water'), x1: 0, y1: 0, x2: 0, y2: 1 },
      h('stop', { offset: '0', 'stop-color': 'var(--env-water)' }),
      h('stop', { offset: '1', 'stop-color': 'var(--lm-bg)' })),
    h('radialGradient', { id: id('lantern-glow') },
      h('stop', { offset: '0', 'stop-color': 'var(--env-light)', 'stop-opacity': '0.55' }),
      h('stop', { offset: '0.35', 'stop-color': 'var(--env-light)', 'stop-opacity': '0.16' }),
      h('stop', { offset: '1', 'stop-color': 'var(--env-light)', 'stop-opacity': '0' })),
    h('linearGradient', { id: id('reflect'), x1: 0, y1: 0, x2: 0, y2: 1 },
      h('stop', { offset: '0', 'stop-color': '#fff', 'stop-opacity': '0.2' }),
      h('stop', { offset: '0.6', 'stop-color': '#fff', 'stop-opacity': '0' })),
    h('mask', { id: id('reflect-mask') }, h('rect', { x: 0, y: 700, width: 1600, height: 200, fill: `url(#${id('reflect')})` })),
  ));

  // Sky, stars, moon and horizon glow
  const stars = h('g', { class: 'lm-stars env-only env-night' });
  for (let i = 0; i < (detail === 'lite' ? 40 : 90); i++) {
    stars.append(h('circle', { cx: (r() * 1600).toFixed(0), cy: (r() * 380).toFixed(0), r: (0.5 + r() * 1.3).toFixed(1), fill: 'var(--env-moon)', opacity: (0.25 + r() * 0.6).toFixed(2) }));
  }
  svg.append(layer(0,
    h('rect', { x: -60, y: -60, width: 1720, height: 1020, fill: `url(#${id('sky')})` }),
    stars,
    h('rect', { x: -60, y: 200, width: 1720, height: 600, fill: `url(#${id('horizon')})` }),
    h('g', { class: 'env-only env-moonlit' }, h('circle', { cx: 1150, cy: 190, r: 160, fill: `url(#${id('moon')})` }), h('circle', { cx: 1150, cy: 190, r: 48, fill: 'var(--env-moon)' })),
    h('g', { class: 'env-only env-snow' }, h('circle', { cx: 420, cy: 200, r: 130, fill: `url(#${id('moon')})` }), h('circle', { cx: 420, cy: 200, r: 36, fill: 'var(--env-moon)', opacity: 0.9 })),
    h('g', { class: 'env-only env-sakura' }, h('circle', { cx: 980, cy: 470, r: 220, fill: `url(#${id('moon')})`, opacity: 0.6 }), h('circle', { cx: 980, cy: 470, r: 70, fill: 'var(--env-moon)', opacity: 0.22 })),
  ));

  // Mountains and mist
  svg.append(layer(3, h('path', { d: 'M-60 560 C 120 520 200 470 320 480 C 420 490 470 430 560 420 C 650 410 700 460 800 450 C 900 440 960 380 1060 390 C 1160 400 1220 460 1320 450 C 1420 440 1500 480 1660 470 L1660 960 L-60 960 Z', fill: 'var(--env-mountain-far)' })));
  svg.append(layer(5, h('rect', { class: 'lm-mist', x: -200, y: 440, width: 2000, height: 170, fill: `url(#${id('mist')})` })));
  svg.append(layer(7, h('path', { d: 'M-60 640 C 150 600 260 610 380 590 C 520 568 600 600 720 596 C 860 592 960 560 1100 570 C 1240 580 1360 610 1660 590 L1660 960 L-60 960 Z', fill: 'var(--env-mountain-near)' })));

  // Architecture (kept in one group so the pond can reflect it)
  const structures = h('g', { id: id('structures') }, templeHall(), pagoda(1300, 640));
  svg.append(layer(11, structures));

  // Pond with reflections and ripples
  const pond = h('g', null,
    h('rect', { x: -60, y: 690, width: 1720, height: 270, fill: `url(#${id('water')})` }),
    h('g', { mask: `url(#${id('reflect-mask')})`, opacity: 0.55 }, h('use', { href: `#${id('structures')}`, transform: 'translate(0 1380) scale(1 -1)' })),
    h('ellipse', { class: 'lm-ripple', cx: 700, cy: 790, rx: 90, ry: 9, fill: 'none', stroke: 'var(--env-light)', 'stroke-width': 1, opacity: 0.3 }),
    h('ellipse', { class: 'lm-ripple', cx: 1010, cy: 820, rx: 70, ry: 7, fill: 'none', stroke: 'var(--env-light)', 'stroke-width': 1, opacity: 0.3 }),
    h('ellipse', { class: 'lm-ripple', cx: 430, cy: 770, rx: 60, ry: 6, fill: 'none', stroke: 'var(--env-light)', 'stroke-width': 1, opacity: 0.3 }),
    h('rect', { class: 'lm-mist lm-mist--slow', x: -200, y: 670, width: 2000, height: 90, fill: `url(#${id('mist')})` }),
  );
  svg.append(layer(13, pond));
  svg.append(layer(15, bridge()));

  // Illuminated path of small ground lights leading to the hall
  const path = h('g', { class: 'lm-path-lights' });
  for (let i = 0; i < 9; i++) {
    const t = i / 8;
    const [x, y] = quadPoint([700, 920], [520, 760], [330, 650], t);
    const s = 1 - t * 0.6;
    path.append(h('circle', { cx: x, cy: y, r: 26 * s, fill: `url(#${id('lantern-glow')})`, class: 'lm-lantern-glow' }));
    path.append(h('circle', { cx: x, cy: y, r: 2.6 * s, fill: 'var(--env-light)' }));
  }
  svg.append(layer(17, path));

  // Stone lanterns (more in the lantern courtyard)
  svg.append(layer(18,
    stoneLantern(470, 712, 1, id('lantern')),
    stoneLantern(1135, 716, 1.05, id('lantern')),
    h('g', { class: 'env-only env-lantern' }, stoneLantern(900, 760, 0.8, id('lantern')), stoneLantern(1450, 740, 0.9, id('lantern')), stoneLantern(160, 745, 0.85, id('lantern'))),
  ));

  // Wooden walkway (engawa boards) entering from the lower left
  const walk = h('g', { class: 'lm-walkway' });
  const wood = 'color-mix(in srgb, var(--env-structure) 55%, #3a2618)';
  walk.append(h('path', { d: 'M-60 858 L360 756 L402 768 L-60 902 Z', fill: wood }));
  for (let i = 0; i < 12; i++) {
    const x = -40 + i * 36;
    walk.append(h('path', { d: `M${x} ${854 - i * 8.4} L${x + 14} ${888 - i * 10.4}`, stroke: 'var(--env-structure)', 'stroke-width': 1.5, opacity: 0.8 }));
  }
  walk.append(h('path', { d: 'M-60 858 L360 756', stroke: 'var(--env-light)', 'stroke-width': 1, opacity: 0.25 }));

  // Hanging paper lanterns across the courtyard (lantern environment)
  const strung = h('g', { class: 'env-only env-lantern' });
  strung.append(h('path', { d: 'M-20 120 Q800 260 1620 120', fill: 'none', stroke: 'var(--env-structure)', 'stroke-width': 2 }));
  for (let i = 1; i < 10; i++) {
    const [x, y] = quadPoint([-20, 120], [800, 260], [1620, 120], i / 10);
    strung.append(
      h('circle', { cx: x, cy: y + 34, r: 60, fill: `url(#${id('lantern-glow')})`, class: 'lm-lantern-glow' }),
      h('path', { d: `M${x} ${y}v10`, stroke: 'var(--env-structure)', 'stroke-width': 2 }),
      h('ellipse', { cx: x, cy: y + 34, rx: 15, ry: 22, fill: i % 2 ? 'color-mix(in srgb, var(--lm-accent-strong) 70%, var(--env-light))' : 'var(--env-light)', opacity: 0.9, class: 'lm-lantern-glow' }),
    );
  }

  // Framing cherry branches and foreground
  svg.append(layer(24,
    strung,
    blossomBranch(r, { from: [-40, 330], ctrl: [180, 150], to: [520, 40], clusters: 6, width: 16 }, detail),
    blossomBranch(r, { from: [1650, 250], ctrl: [1400, 120], to: [1120, -20], clusters: 5, width: 14 }, detail),
  ));
  svg.append(layer(30,
    walk,
    h('path', { d: 'M1660 960 L1660 820 C 1560 800 1480 850 1400 870 C 1320 890 1250 900 1180 960 Z', fill: 'var(--env-structure)' }),
    h('path', { class: 'env-only env-snow', d: 'M1660 822 C 1560 802 1480 852 1400 872 C 1320 892 1250 902 1180 960', fill: 'none', stroke: 'var(--env-foliage)', 'stroke-width': 4, opacity: 0.8 }),
  ));
  return svg;
}

/** Applies an environment to the document (palette variables and scene visibility). */
export function applyEnvironment(envId) {
  const env = ENVIRONMENTS.find((e) => e.id === envId) ? envId : 'sakura';
  document.documentElement.dataset.environment = env;
  return ENVIRONMENTS.find((e) => e.id === env);
}

/**
 * Mounts the background garden in `root` and starts parallax.
 * Returns a controller: { setParallax(bool), destroy() }.
 */
export function mountGarden(root) {
  const small = window.matchMedia('(max-width: 720px)').matches;
  const scene = h('div', { class: 'lm-garden__scene' }, buildScene({ detail: small ? 'lite' : 'full', idPrefix: 'bg' }));
  root.classList.add('lm-garden');
  root.append(scene, h('div', { class: 'lm-garden__veil' }));

  let enabled = true;
  let frame = 0;
  let px = 0;
  let py = 0;
  const update = () => {
    frame = 0;
    const scroll = Math.min(window.scrollY, 1600);
    root.style.setProperty('--gx', px.toFixed(3));
    root.style.setProperty('--gy', py.toFixed(3));
    root.style.setProperty('--gs', (-scroll / 90).toFixed(3));
  };
  const schedule = () => {
    if (!enabled || frame || prefersReducedMotion()) return;
    frame = requestAnimationFrame(update);
  };
  const onPointer = (e) => {
    if (e.pointerType !== 'mouse') return;
    px = (e.clientX / window.innerWidth - 0.5) * -2;
    py = (e.clientY / window.innerHeight - 0.5) * -1;
    schedule();
  };
  window.addEventListener('pointermove', onPointer, { passive: true });
  window.addEventListener('scroll', schedule, { passive: true });
  return {
    setParallax(on) {
      enabled = on;
      document.documentElement.dataset.parallax = on ? 'on' : 'off';
      if (!on) {
        px = py = 0;
        update();
      }
    },
    destroy() {
      window.removeEventListener('pointermove', onPointer);
      window.removeEventListener('scroll', schedule);
      cancelAnimationFrame(frame);
    },
  };
}
