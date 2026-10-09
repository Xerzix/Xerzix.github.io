// WCAG 2.x colour contrast utilities (shared with tests).

export function parseHex(hex) {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(String(hex).trim());
  if (!m) return null;
  let v = m[1];
  if (v.length === 3) v = v.split('').map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16));
}

export function toHex([r, g, b]) {
  return `#${[r, g, b].map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')).join('')}`;
}

export function luminance(hex) {
  const rgb = parseHex(hex);
  if (!rgb) return 0;
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Mixes two hex colours; t = 0 → a, t = 1 → b. */
export function mix(a, b, t) {
  const A = parseHex(a);
  const B = parseHex(b);
  return toHex(A.map((v, i) => v + (B[i] - v) * t));
}

/**
 * Nudges `fg` towards white or black until it reaches `target` contrast against `bg`.
 * Returns the adjusted colour (or the best achievable).
 */
export function ensureContrast(fg, bg, target = 4.5) {
  if (contrastRatio(fg, bg) >= target) return fg;
  const towards = luminance(bg) < 0.4 ? '#ffffff' : '#000000';
  for (let t = 0.05; t <= 1.0001; t += 0.05) {
    const c = mix(fg, towards, t);
    if (contrastRatio(c, bg) >= target) return c;
  }
  return towards;
}

/** Best of white/black text for a background colour. */
export function readableOn(bg, light = '#f8f5f2', dark = '#0b0b0b') {
  return contrastRatio(light, bg) >= contrastRatio(dark, bg) ? light : dark;
}
