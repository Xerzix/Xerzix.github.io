// Built-in profile pictures: small illustrated tiles drawn from the garden motifs.
import { h } from '../core/dom.js';

const MOTIFS = {
  sakura: 'M32 29c-3.6-5.2-4.6-10.4-2.3-16 1.3 1.5 2.9 2.3 4.7 2.3 1.3-1.6 1.6-3.6 1-5.7 5.2 3.6 6 10.6-3.4 19.4zM32 33c-6 1.8-11.4 1-15.8-3.1 1.8-.5 3.1-1.8 3.9-3.4-1-1.8-2.9-2.9-4.9-3.1 6-2.3 12.5 1 16.8 9.6zM32 33c6 1.8 11.4 1 15.8-3.1-1.8-.5-3.1-1.8-3.9-3.4 1-1.8 2.9-2.9 4.9-3.1-6-2.3-12.5 1-16.8 9.6zM32 33c-2.3 5.7-6.5 9.3-12.5 10.4.8 1.8.8 3.4 0 4.9 1.8 1 3.9 1 5.7.3-2.3 6.2 2.3 7.8 8.3-6.2zM32 33c2.3 5.7 6.5 9.3 12.5 10.4-.8 1.8-.8 3.4 0 4.9-1.8 1-3.9 1-5.7.3 2.3 6.2-2.3 7.8-8.3-6.2z',
  lantern: 'M24 12h16M26 12v5M38 12v5M20 19h24l-2.4 24H22.4zM25 43l1.4 5h11.2l1.4-5M32 48v6M22 27h20M22 35h20',
  moon: 'M44 38.5A16 16 0 0 1 23.5 18a16 16 0 1 0 20.5 20.5z',
  maple: 'M32 12l3.5 9 7-4-2 9.5 9-1-6 7 6 3.5-9.5 2 1.5 8-7.5-5-2 9.5-2-9.5-7.5 5 1.5-8-9.5-2 6-3.5-6-7 9 1-2-9.5 7 4zM32 45v9',
  koi: 'M14 36c6-10 18-14 28-10l8-6-2 9c3 2 3 5 0 7l2 9-8-6c-10 4-22 0-28-3zM40 30.5v.1M27 29c2 3 2 6 0 9',
  crane: 'M12 40c10-2 16-8 22-18 2-3 6-6 10-5l6 1-5 3c-2 1-3 3-3 5 0 8-8 14-20 15M34 22c-4-6-12-8-18-6 6 1 10 4 12 9M40 38l-4 12M46 17.5v.1',
  wave: 'M8 42c6-10 14-14 22-10-4 2-4 7 0 8 5 1 9-4 8-9 8 4 12 10 18 12M8 50c8-4 14-4 20 0s12 4 20 0 10-4 12-2',
  fuji: 'M6 48l18-24c2-3 5-3 7-1l3 3 3-3c2-2 5-2 7 1l14 24zM22 30l4 4 4-3 4 4 4-4 4 3M46 16a4 4 0 1 0 0 .1',
  torii: 'M10 18c8 2 36 2 44 0l-2 5H12zM14 28h36M20 23v30M44 23v30M31 28v-5h2v5',
  bamboo: 'M24 8v48M40 8v48M24 20h0M24 34h0M40 16h0M40 30h0M40 44h0M24 20c4-3 8-4 12-2M40 30c-4-3-8-3-12 0',
  fox: 'M14 14l10 10h16l10-10-2 18c0 10-7 18-16 20-9-2-16-10-16-20zM25 34l4 2M39 34l-4 2M30 44h4',
  snow: 'M32 10v44M13 21l38 22M13 43l38-22M27 13l5 5 5-5M27 51l5-5 5 5M12 29l7 1-2 6M52 35l-7-1 2-6',
};

export const AVATARS = [
  { id: 'sakura', name: 'Sakura', colors: ['#5b1a2f', '#c9607f'], motif: 'sakura', fill: true },
  { id: 'lantern', name: 'Lantern', colors: ['#3b1d0c', '#d98b2b'], motif: 'lantern' },
  { id: 'moon', name: 'Moon', colors: ['#0f1a2e', '#4a5f88'], motif: 'moon', fill: true },
  { id: 'maple', name: 'Maple', colors: ['#4a1a0c', '#e36a2f'], motif: 'maple', fill: true },
  { id: 'koi', name: 'Koi', colors: ['#0e2a33', '#2e6f8e'], motif: 'koi' },
  { id: 'crane', name: 'Crane', colors: ['#2a2622', '#8f8a80'], motif: 'crane' },
  { id: 'wave', name: 'Wave', colors: ['#0b1c33', '#3d6fa3'], motif: 'wave' },
  { id: 'fuji', name: 'Fuji', colors: ['#1d2233', '#6b7bb0'], motif: 'fuji' },
  { id: 'torii', name: 'Torii', colors: ['#2a0b10', '#b52b49'], motif: 'torii' },
  { id: 'bamboo', name: 'Bamboo', colors: ['#0f2416', '#4c8a55'], motif: 'bamboo' },
  { id: 'fox', name: 'Kitsune', colors: ['#331608', '#e0833a'], motif: 'fox' },
  { id: 'snow', name: 'Snow', colors: ['#1a2230', '#9fb3cc'], motif: 'snow' },
];

let gradientSeq = 0;

/** Renders an avatar tile. `size` in px (the CSS class can override). */
export function avatar(id, { size, label, className = 'lm-avatar' } = {}) {
  const a = AVATARS.find((x) => x.id === id) || AVATARS[0];
  const gid = `av-${a.id}-${++gradientSeq}`;
  const svg = h('svg', { xmlns: 'http://www.w3.org/2000/svg', viewBox: '0 0 64 64', 'aria-hidden': 'true', focusable: 'false' },
    h('defs', null, h('linearGradient', { id: gid, x1: 0, y1: 0, x2: 1, y2: 1 }, h('stop', { offset: 0, 'stop-color': a.colors[0] }), h('stop', { offset: 1, 'stop-color': a.colors[1] }))),
    h('rect', { width: 64, height: 64, fill: `url(#${gid})` }),
    h('circle', { cx: 50, cy: 12, r: 18, fill: '#ffffff', opacity: 0.07 }),
    h('path', {
      d: MOTIFS[a.motif],
      fill: a.fill ? '#fdf3f0' : 'none',
      stroke: a.fill ? 'none' : '#fdf3f0',
      'stroke-width': a.fill ? undefined : 2.6,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      opacity: 0.92,
    }),
  );
  return h('span', { class: className, style: size ? { width: `${size}px`, height: `${size}px` } : undefined, role: label ? 'img' : undefined, 'aria-label': label }, svg);
}
