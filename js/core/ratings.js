// Age ratings shared by the browser and the server. Movie (MPA) and TV Parental Guidelines
// ratings map onto a single minimum-age scale used for parental controls.
export const AGE_RATINGS = [
  { code: 'G', minAge: 0, system: 'movie', label: 'General audiences' },
  { code: 'TV-Y', minAge: 0, system: 'tv', label: 'All children' },
  { code: 'TV-G', minAge: 0, system: 'tv', label: 'General audience' },
  { code: 'TV-Y7', minAge: 7, system: 'tv', label: 'Directed to older children' },
  { code: 'PG', minAge: 8, system: 'movie', label: 'Parental guidance suggested' },
  { code: 'TV-PG', minAge: 8, system: 'tv', label: 'Parental guidance suggested' },
  { code: 'PG-13', minAge: 13, system: 'movie', label: 'Parents strongly cautioned' },
  { code: 'TV-14', minAge: 14, system: 'tv', label: 'Parents strongly cautioned' },
  { code: 'R', minAge: 17, system: 'movie', label: 'Restricted' },
  { code: 'TV-MA', minAge: 17, system: 'tv', label: 'Mature audiences only' },
  { code: 'NC-17', minAge: 18, system: 'movie', label: 'Adults only' },
  { code: 'NR', minAge: 18, system: 'any', label: 'Not rated' },
];

const BY_CODE = new Map(AGE_RATINGS.map((r) => [r.code, r]));

/** Minimum viewer age for a rating code. Unknown or unrated content is treated as adult. */
export function minAgeFor(code) {
  return BY_CODE.get(code)?.minAge ?? 18;
}

export function ratingLabel(code) {
  return BY_CODE.get(code)?.label ?? 'Not rated';
}

/** Kid-profile presets offered in profile settings. */
export const MATURITY_PRESETS = [
  { maxAge: 7, label: 'Little kids (up to TV-Y7)' },
  { maxAge: 8, label: 'Older kids (up to PG / TV-PG)' },
  { maxAge: 13, label: 'Teens (up to PG-13)' },
  { maxAge: 14, label: 'Teens (up to TV-14)' },
  { maxAge: null, label: 'All maturity ratings' },
];

/** True when a profile (with optional maxAge) may see a title with the given minAge. */
export function allowedFor(profile, minAge) {
  if (!profile || profile.maxAge === null || profile.maxAge === undefined) return true;
  return minAge <= profile.maxAge;
}
