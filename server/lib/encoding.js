// Content negotiation for compressed responses (static assets and JSON).

/** Picks br or gzip from an Accept-Encoding header, or null. Codings with q=0 are refused. */
export function pickEncoding(header) {
  if (!header) return null;
  const accepted = new Map();
  for (const part of String(header).toLowerCase().split(',')) {
    const [name, ...params] = part.trim().split(';');
    const q = params.map((p) => /^\s*q=([\d.]+)\s*$/.exec(p)).find(Boolean);
    accepted.set(name.trim(), q ? Number(q[1]) : 1);
  }
  const ok = (name) => (accepted.get(name) ?? accepted.get('*') ?? 0) > 0;
  if (ok('br')) return 'br';
  if (ok('gzip')) return 'gzip';
  return null;
}
