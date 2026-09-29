// Lumina icon set: 24×24 line icons drawn for the interface (stroke 1.75, round joins).
// icon('play') returns an <svg> element; decorative by default (aria-hidden).
import { h } from '../core/dom.js';

const P = {
  play: 'M7 4.5v15l12.5-7.5z',
  pause: 'M8 5v14M16 5v14',
  plus: 'M12 5v14M5 12h14',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5.5M12 7.6v.1',
  close: 'M6 6l12 12M18 6L6 18',
  chevronLeft: 'M14.5 5.5L8 12l6.5 6.5',
  chevronRight: 'M9.5 5.5L16 12l-6.5 6.5',
  chevronDown: 'M5.5 9.5L12 16l6.5-6.5',
  chevronUp: 'M5.5 14.5L12 8l6.5 6.5',
  arrowRight: 'M5 12h14M13 6l6 6-6 6',
  arrowLeft: 'M19 12H5M11 6l-6 6 6 6',
  search: 'M10.5 18a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15zM16 16l4.5 4.5',
  bell: 'M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15zM10 20.5a2.2 2.2 0 0 0 4 0',
  bellOff: 'M6 16V11c0-1 .2-1.9.6-2.7M9.2 5.7A6 6 0 0 1 18 11v4M4 4l16 16M4.5 18h11M10 20.5a2.2 2.2 0 0 0 4 0',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 20.5c1.2-3.6 4.1-5.5 7.5-5.5s6.3 1.9 7.5 5.5',
  users: 'M9 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20c1-3.2 3.5-5 6.5-5s5.5 1.8 6.5 5M16 4.8a3.4 3.4 0 0 1 0 6.4M18.5 15.3c1.4.9 2.4 2.5 3 4.7',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 13.5l1.6 1.2-2 3.4-1.9-.7a7.7 7.7 0 0 1-2.2 1.3L14.6 21h-4l-.4-2.3A7.7 7.7 0 0 1 8 17.4l-2 .7-2-3.4 1.7-1.2a7.6 7.6 0 0 1 0-3l-1.7-1.2 2-3.4 2 .7a7.7 7.7 0 0 1 2.2-1.3L10.6 3h4l.4 2.3a7.7 7.7 0 0 1 2.2 1.3l1.9-.7 2 3.4-1.6 1.2a7.6 7.6 0 0 1 0 3z',
  star: 'M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8L3.5 9.7l5.9-.8z',
  sparkle: 'M12 3c.6 4.2 2.8 6.4 7 7-4.2.6-6.4 2.8-7 7-.6-4.2-2.8-6.4-7-7 4.2-.6 6.4-2.8 7-7zM19 15.5c.3 1.6 1 2.3 2.5 2.5-1.5.3-2.2 1-2.5 2.5-.3-1.5-1-2.2-2.5-2.5 1.5-.2 2.2-.9 2.5-2.5z',
  home: 'M4 10.5L12 4l8 6.5V20h-5v-6H9v6H4z',
  film: 'M4 4h16v16H4zM8 4v16M16 4v16M4 8h4M4 12h4M4 16h4M16 8h4M16 12h4M16 16h4',
  tv: 'M3.5 6.5h17v11h-17zM8 21h8M9 3l3 3.5L15 3',
  flame: 'M12 21c-3.9 0-6.5-2.6-6.5-6 0-3.3 2.4-5 3.4-8 .4 1.6 1.4 2.6 2.4 3 .2-2.7 1.5-5 3.2-6.5-.3 3 3.5 5.5 3.5 10.5 0 3.9-2.4 7-6 7z',
  calendar: 'M4.5 6h15v14h-15zM4.5 10h15M8.5 3.5V7M15.5 3.5V7',
  compass: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM15.5 8.5l-2 5-5 2 2-5z',
  list: 'M9 6h11M9 12h11M9 18h11M4.5 6v.1M4.5 12v.1M4.5 18v.1',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  menu: 'M4 7h16M4 12h16M4 17h16',
  logout: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10',
  login: 'M10 4H5v16h5M14 8l4 4-4 4M18 12H8',
  shield: 'M12 3l7.5 3v5.5c0 4.6-3.1 8.2-7.5 9.5-4.4-1.3-7.5-4.9-7.5-9.5V6z',
  upload: 'M12 16V4M7 9l5-5 5 5M4.5 15v4.5h15V15',
  download: 'M12 4v12M7 11l5 5 5-5M4.5 15v4.5h15V15',
  clapper: 'M4 10h16v10H4zM4 10l1.2-5 15.3 3.5L20 10M8.5 5.8l1.8 3.8M13.5 6.9l1.8 3.8',
  volume: 'M4 9.5h3.5L12 5.5v13l-4.5-4H4zM15.5 9a4.5 4.5 0 0 1 0 6M18 6.5a8 8 0 0 1 0 11',
  volumeMute: 'M4 9.5h3.5L12 5.5v13l-4.5-4H4zM16 9.5l5 5M21 9.5l-5 5',
  volumeLow: 'M4 9.5h3.5L12 5.5v13l-4.5-4H4zM15.5 9a4.5 4.5 0 0 1 0 6',
  fullscreen: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  fullscreenExit: 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5',
  pip: 'M3.5 5.5h17v13h-17zM12 12h6.5v5H12z',
  subtitles: 'M3.5 5.5h17v13h-17zM7 11.5h3.5M13 11.5h4M7 15h7M16 15h1',
  audio: 'M4 14v-2a8 8 0 0 1 16 0v2M4 14h3v6H4zM17 14h3v6h-3z',
  rewind: 'M11 7L5 12l6 5zM19 7l-6 5 6 5z',
  forward: 'M13 7l6 5-6 5zM5 7l6 5-6 5z',
  back10: 'M4 12a8 8 0 1 0 2.4-5.7M4 4v4.5h4.5M9.5 10v5M12.5 11.2a1.3 1.3 0 0 1 2.6 0v2.6a1.3 1.3 0 0 1-2.6 0z',
  fwd10: 'M20 12a8 8 0 1 1-2.4-5.7M20 4v4.5h-4.5M9.5 10v5M12.5 11.2a1.3 1.3 0 0 1 2.6 0v2.6a1.3 1.3 0 0 1-2.6 0z',
  skipNext: 'M6 5.5l9 6.5-9 6.5zM18 5.5v13',
  skipPrev: 'M18 5.5L9 12l9 6.5zM6 5.5v13',
  speed: 'M12 20a8 8 0 1 1 8-8M12 12l4-3M20.5 16.5h-5M20.5 19.5h-3',
  alert: 'M12 3.5l9.5 16.5h-19zM12 10v4.5M12 17.4v.1',
  checkCircle: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8 12.2l2.8 2.8L16.2 9.5',
  trash: 'M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13M10 11v5.5M14 11v5.5',
  edit: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4',
  flag: 'M5.5 21V4M5.5 4.5h11l-2 4 2 4h-11',
  thumbsUp: 'M7.5 10.5V20h-3v-9.5zM7.5 10.5L11 4c1.7 0 2.7 1.2 2.4 2.8L12.9 10h5.2c1.3 0 2.2 1.2 1.9 2.4l-1.5 6c-.2.9-1 1.6-2 1.6H7.5',
  share: 'M12 15V4M7.5 8.5L12 4l4.5 4.5M5 12v7.5h14V12',
  eye: 'M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  eyeOff: 'M3 3l18 18M10.6 5.6c.5-.1.9-.1 1.4-.1 6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.6 3.4M6.5 7.3C4 9 2.5 12 2.5 12s3.5 6.5 9.5 6.5c1.6 0 3-.4 4.2-1M9.9 9.9a3 3 0 0 0 4.2 4.2',
  lock: 'M5.5 10.5h13v10h-13zM8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3',
  key: 'M8 15a4 4 0 1 1 3.4-6.1L20 9v3.5h-2.5V15H15v-2.3h-3.6A4 4 0 0 1 8 15z',
  device: 'M3.5 5h17v11h-17zM2 19h20M9 16v3M15 16v3',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3c2.5 2.6 3.7 5.6 3.7 9s-1.2 6.4-3.7 9c-2.5-2.6-3.7-5.6-3.7-9S9.5 5.6 12 3z',
  palette: 'M12 3.5a8.5 8.5 0 0 0 0 17c1.1 0 1.6-.8 1.3-1.7-.4-1.1.3-2.3 1.5-2.3h2.2a3.5 3.5 0 0 0 3.5-3.5c0-5.3-3.8-9.5-8.5-9.5zM7.5 11.5v.1M9.5 7.5v.1M14.5 7.5v.1M17 11v.1',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5.5l3.5 2',
  history: 'M4 12a8 8 0 1 0 2.4-5.7M4 4v4.5h4.5M12 8v4.5l3 2',
  layers: 'M12 3.5l9 5-9 5-9-5zM3 13l9 5 9-5M3 17.2l9 5 9-5',
  columns: 'M4 4.5h4.5v15H4zM9.8 4.5h4.4v15H9.8zM15.5 4.5H20v15h-4.5z',
  chart: 'M4 20V4M4 20h16M8 16v-5M12 16V8M16 16v-3M20 16V6',
  message: 'M4 5.5h16v11H9l-5 4z',
  send: 'M4 12l16-8-6 16-2.5-6.5z',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5.5H4.5V6H10',
  refresh: 'M20 12a8 8 0 1 1-2.4-5.7M20 4v4.5h-4.5',
  sliders: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4',
  sort: 'M7 4v16M4 7l3-3 3 3M17 20V4M14 17l3 3 3-3',
  more: 'M5.5 12v.1M12 12v.1M18.5 12v.1',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z',
  leaf: 'M5 19c0-8 5-14 15-15-1 10-7 15-15 15zM5 19l7-7',
  mail: 'M3.5 6h17v12h-17zM3.5 6.5L12 13l8.5-6.5',
  copy: 'M8 8h11v12H8zM5 16V4h11',
  hd: 'M3.5 5.5h17v13h-17zM7.5 9v6M7.5 12h3M10.5 9v6M13.5 9v6h1.5a3 3 0 0 0 0-6z',
  lantern: 'M9 3.5h6M10 3.5v2M14 3.5v2M7.5 6.5h9l-.8 9.5H8.3zM9.5 16l.5 2h4l.5-2M12 18v2.5',
  sakura: 'M12 11.2c-1.4-2-1.8-4-.9-6.2.5.6 1.1.9 1.8.9.5-.6.6-1.4.4-2.2 2 1.4 2.3 4.1-1.3 7.5zM12 12.8c-2.3.7-4.4.4-6.1-1.2.7-.2 1.2-.7 1.5-1.3-.4-.7-1.1-1.1-1.9-1.2 2.3-.9 4.8.4 6.5 3.7zM12 12.8c2.3.7 4.4.4 6.1-1.2-.7-.2-1.2-.7-1.5-1.3.4-.7 1.1-1.1 1.9-1.2-2.3-.9-4.8.4-6.5 3.7zM12 12.8c-.9 2.2-2.5 3.6-4.8 4 .3.7.3 1.3 0 1.9.7.4 1.5.4 2.2.1-.9 2.4.9 3 3.2-2.4zM12 12.8c.9 2.2 2.5 3.6 4.8 4-.3.7-.3 1.3 0 1.9-.7.4-1.5.4-2.2.1.9 2.4-.9 3-3.2-2.4z',
};

// Icons drawn as filled shapes rather than strokes.
const FILLED = new Set(['play', 'star', 'sparkle', 'skipNext', 'skipPrev', 'rewind', 'forward', 'sakura']);

export function icon(name, { size, label, className, filled } = {}) {
  const d = P[name];
  if (!d) throw new Error(`Unknown icon: ${name}`);
  const isFilled = filled ?? FILLED.has(name);
  const svg = h('svg', {
    xmlns: 'http://www.w3.org/2000/svg',
    viewBox: '0 0 24 24',
    width: size,
    height: size,
    class: className ? `lm-icon ${className}` : 'lm-icon',
    fill: isFilled ? 'currentColor' : 'none',
    stroke: isFilled ? 'none' : 'currentColor',
    'stroke-width': isFilled ? undefined : '1.75',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': label ? undefined : 'true',
    role: label ? 'img' : undefined,
    'aria-label': label,
    focusable: 'false',
  });
  svg.append(h('path', { d }));
  return svg;
}

/** Outlined star used for empty rating slots. */
export function starIcon(fill = 'full') {
  const svg = h('svg', { xmlns: 'http://www.w3.org/2000/svg', viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' });
  const id = `half-${Math.random().toString(36).slice(2, 8)}`;
  if (fill === 'half') {
    svg.append(
      h('defs', null, h('linearGradient', { id }, h('stop', { offset: '50%', 'stop-color': 'currentColor' }), h('stop', { offset: '50%', 'stop-color': 'currentColor', 'stop-opacity': '0.25' }))),
      h('path', { d: P.star, fill: `url(#${id})` }),
    );
  } else {
    svg.append(h('path', { d: P.star, fill: 'currentColor', 'fill-opacity': fill === 'full' ? '1' : '0.25' }));
  }
  return svg;
}

/** The Lumina mark: a temple roof with upturned eaves sheltering a point of light. */
export function logoMark(className = 'lm-logo__mark') {
  return h('svg', { xmlns: 'http://www.w3.org/2000/svg', viewBox: '0 0 32 32', class: className, 'aria-hidden': 'true', focusable: 'false' },
    h('path', { d: 'M1.5 11.2c4.6-.4 9-2.3 14.5-6.7 5.5 4.4 9.9 6.3 14.5 6.7l-.9 1.7c-4.7-.3-9.3-2-13.6-5.2-4.3 3.2-8.9 4.9-13.6 5.2z', fill: 'currentColor' }),
    h('path', { d: 'M5.5 14.3h21M8 14.3V27M24 14.3V27M5 27h22', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round' }),
    h('circle', { cx: '16', cy: '20.2', r: '3.1', fill: 'currentColor', opacity: '0.95' }),
    h('circle', { cx: '16', cy: '20.2', r: '5.6', fill: 'currentColor', opacity: '0.18' }),
  );
}

export const ICON_NAMES = Object.keys(P);
