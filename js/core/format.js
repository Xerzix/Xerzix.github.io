// Formatting helpers for runtimes, dates, languages and resolutions.
const LANGUAGE_NAMES = {
  zxx: 'No dialogue',
  und: 'Unknown',
};

export function languageName(code, locale = 'en') {
  if (!code) return '';
  if (LANGUAGE_NAMES[code]) return LANGUAGE_NAMES[code];
  try {
    return new Intl.DisplayNames([locale], { type: 'language' }).of(code) || code;
  } catch {
    return code;
  }
}

export function countryName(code, locale = 'en') {
  try {
    return new Intl.DisplayNames([locale], { type: 'region' }).of(code) || code;
  } catch {
    return code;
  }
}

/** 95 -> "1h 35m", 12 -> "12m", 0.4 -> "<1m" */
export function runtime(minutes) {
  if (minutes === null || minutes === undefined) return '';
  if (minutes < 1) return '<1m';
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h ? `${h}h${m ? ` ${m}m` : ''}` : `${m}m`;
}

/** Seconds -> "1:02:03" or "4:05" */
export function clock(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor(seconds / 3600);
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Seconds -> "12m left" (kept from the original Continue Watching cards) */
export function timeLeft(positionS, durationS) {
  if (!durationS) return '';
  const left = Math.max(0, durationS - positionS);
  const h = Math.floor(left / 3600);
  const m = Math.floor((left % 3600) / 60);
  if (h) return `${h}h ${m}m left`;
  if (m) return `${m}m left`;
  return left > 0 ? '<1m left' : 'Finished';
}

export function resolutionLabel(height) {
  if (!height) return '';
  if (height >= 2160) return '4K UHD (2160p)';
  if (height >= 1440) return `QHD (${height}p)`;
  if (height >= 1080) return 'Full HD (1080p)';
  if (height >= 720) return 'HD (720p)';
  return `${height}p`;
}

export function shortResolution(height) {
  if (height >= 2160) return '4K';
  return `${height}p`;
}

export function date(iso, opts = { year: 'numeric', month: 'short', day: 'numeric' }) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, opts);
}

export function relativeTime(iso) {
  if (!iso) return '';
  const diff = (Date.parse(iso) - Date.now()) / 1000;
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (abs < 60) return rtf.format(Math.round(diff), 'second');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), 'day');
  if (abs < 86400 * 365) return rtf.format(Math.round(diff / (86400 * 30)), 'month');
  return rtf.format(Math.round(diff / (86400 * 365)), 'year');
}

export function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

export function bytes(n) {
  if (!Number.isFinite(n)) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n < 10 && i ? 1 : 0)} ${units[i]}`;
}

/** "Film · 2010 · 15m" style summary used under titles. */
export function titleFacts(t) {
  const parts = [];
  if (t.year) parts.push(String(t.year));
  if (t.type === 'series') {
    if (t.seasonCount > 1) parts.push(`${t.seasonCount} Seasons`);
    else if (t.episodeCount) parts.push(plural(t.episodeCount, 'Episode'));
  } else if (t.runtimeMin) parts.push(runtime(t.runtimeMin));
  return parts;
}
