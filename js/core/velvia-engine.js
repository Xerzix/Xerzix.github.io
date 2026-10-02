// Velvia's built-in catalog engine (shared by the server and Preview mode).
//
// A deterministic, rule-based concierge. It reads the conversation, works out what the
// viewer is asking for (genres, moods, runtime, format, quality, language, audience, titles
// they mention) and answers ONLY from the catalog metadata it is given. It never names a
// title that is not in `titles`, never states a fact the metadata does not contain, and
// says so plainly when nothing matches. Pure: no DOM, no network, no randomness.
//
//   respond(titles, { messages, context: { titleId?, compareIds? }, options: { useHistory } },
//           { history: [{ titleId, watchedAt }], watchlist: [{ titleId }], ratings: { id: n }, progress? })
//   -> { reply, recommendations: [{ titleId, reason, title, closest? }], clarifyingQuestion,
//        suggestions, provider: 'local', fallback: false, intent, comparison?, notInCatalog? }
import { normalize, editDistance, typoBudget } from './text.js';
import { similarityScore, tasteProfile, tasteScore } from './similarity.js';
import { ratingLabel } from './ratings.js';
import { languageName, runtime as fmtRuntime, resolutionLabel, date as fmtDate } from './format.js';

export const MAX_RECOMMENDATIONS = 5;

// ───────────────────────────── Vocabulary ─────────────────────────────
// Each facet maps viewer phrasing (`re`) onto catalog vocabulary. `terms` are full matches
// (genres score 3, moods 2, keywords/tags 1); `related` terms earn partial credit and power
// the clearly-labelled "closest options". `adj`/`noun`/`with` describe the facet in replies.
const FACETS = {
  thriller: { re: /\bthrill(?:er|ers)\b|\bsuspense(?:ful)?\b|\bedge of (?:my|your|the) seat\b/, terms: ['thriller', 'suspense', 'suspenseful', 'tense'], related: ['mystery', 'mysterious', 'dark', 'complex plot', 'crime', 'psychological'], noun: 'thriller', label: 'thriller tension' },
  psychological: { re: /\bpsycholog(?:ical|y)\b|\bmind games?\b/, terms: ['psychological', 'mind bending'], related: ['surreal', 'complex plot', 'thought provoking', 'mysterious', 'dream'], adj: 'psychological', label: 'a psychological edge' },
  scifi: { re: /\bsci[\s-]?fi\b|\bscience[\s-]fiction\b|\bfuturistic\b|\bouter space\b|\brobots?\b|\bdystopi(?:a|an)\b|\bcyberpunk\b/, terms: ['science fiction', 'sci fi'], related: ['robots', 'time', 'future', 'space', 'machine', 'visual effects'], adj: 'science fiction', label: 'science fiction' },
  fantasy: { re: /\bfantasy\b|\bmagic(?:al)?\b|\bdragons?\b|\bfair(?:y|ies)[\s-]?tales?\b|\bmythical\b/, terms: ['fantasy'], related: ['dragon', 'magic', 'quest', 'dream', 'imagination'], adj: 'fantasy', label: 'fantasy' },
  comedy: { re: /\bcomed(?:y|ies)\b|\bfunny\b|\bfunnier\b|\bhilarious\b|\blaughs?\b|\blaughter\b|\bhumou?r(?:ous)?\b|\bslapstick\b|\blight[\s-]?hearted\b/, terms: ['comedy', 'funny', 'lighthearted', 'slapstick', 'humor'], related: ['family', 'colorful', 'uplifting'], noun: 'comedy', label: 'comedy' },
  drama: { re: /\bdramas?\b|\bdramatic\b/, terms: ['drama'], related: ['emotional', 'bittersweet'], noun: 'drama', label: 'drama' },
  horror: { re: /\bhorror\b|\bscary\b|\bscarier\b|\bfrightening\b|\bcreepy\b|\bspooky\b|\bterrifying\b/, terms: ['horror', 'scary'], related: ['dark', 'suspenseful', 'mysterious'], adj: 'horror', label: 'horror' },
  animation: { re: /\banimat(?:ed|ion)\b|\bcartoons?\b|\banime\b/, terms: ['animation', 'animated', 'anime'], related: [], adj: 'animated', label: 'animation' },
  documentary: { re: /\bdocumentar(?:y|ies)\b|\bdocs\b|\breal[\s-]life\b|\btrue stor(?:y|ies)\b/, terms: ['documentary'], related: ['nature', 'history'], noun: 'documentary', label: 'documentary' },
  romance: { re: /\bromantic\b|\bromance\b|\blove stor(?:y|ies)\b|\brom[\s-]?coms?\b/, terms: ['romance', 'romantic'], related: ['emotional', 'bittersweet', 'breakup'], adj: 'romantic', label: 'romance' },
  action: { re: /\baction\b|\badrenaline\b|\bexplosive\b|\bfight(?:s|ing)\b|\bchases?\b/, terms: ['action', 'action packed'], related: ['adventure', 'epic', 'visual effects', 'intense'], adj: 'action', label: 'action' },
  adventure: { re: /\badventur(?:e|es|ous)\b|\bquests?\b|\bjourneys?\b|\bexploration\b/, terms: ['adventure', 'quest'], related: ['epic', 'fantasy', 'journey'], noun: 'adventure', label: 'adventure' },
  ambient: { re: /\bambient\b|\bslow (?:tv|television)\b|\bbackground\b|\bscreensaver\b/, terms: ['ambient', 'slow tv'], related: ['meditative', 'relaxing', 'nature'], adj: 'ambient', label: 'ambient calm' },
  nature: { re: /\bnature\b|\bgardens?\b|\bwildlife\b|\blandscapes?\b|\bforests?\b/, terms: ['nature', 'garden'], related: ['ambient', 'seasons', 'forest'], adj: 'nature', label: 'nature' },
  mystery: { re: /\bmyster(?:y|ies|ious)\b|\bwhodunn?its?\b|\benigmatic\b/, terms: ['mystery', 'mysterious'], related: ['surreal', 'complex plot', 'dark', 'atmospheric'], noun: 'mystery', label: 'mystery' },
  family: { re: /\bfamily[\s-]friendly\b|\bwholesome\b/, terms: ['family', 'family friendly'], related: ['lighthearted', 'colorful'], adj: 'family-friendly', label: 'family-friendly' },
  relaxing: { re: /\brelax(?:ing|ed|ation)?\b|\bcalm(?:ing|er)?\b|\bchill(?:ed)?\b|\bsoothing\b|\bpeaceful\b|\bunwind\b|\bwind(?:ing)? down\b|\bco[sz]y\b|\bgentle\b|\bquiet\b|\bmeditat(?:ive|ion)\b|\bserene\b|\bdecompress\b|\bslow[\s-]paced\b/, terms: ['relaxing', 'meditative', 'calm', 'peaceful', 'soothing', 'gentle'], related: ['ambient', 'lighthearted', 'nature', 'atmospheric'], adj: 'relaxing', label: 'pure calm' },
  complex: { re: /\bcomplex\b|\bcomplicated\b|\bbig ideas?\b|\bphilosophical\b|\bheady\b|\btwist(?:y|s|ed)?\b|\bmind[\s-]?bend(?:ing|er)s?\b|\bintricate\b|\bpuzzl(?:e|ing)\b|\bthought[\s-]provoking\b|\bcerebral\b|\bmakes? (?:me|you) think\b|\bnon[\s-]?linear\b|\blayered\b|\bclever\b/, terms: ['complex plot', 'mind bending', 'thought provoking', 'twist', 'nonlinear'], related: ['surreal', 'mysterious', 'psychological', 'time', 'memory'], with: 'a complicated storyline', label: 'a complex, layered plot' },
  emotional: { re: /\bemotional\b|\bmoving\b|\bmake me cry\b|\btear[\s-]?jerkers?\b|\bheart(?:felt|warming|breaking)\b|\btouching\b|\bsad\b|\bbittersweet\b|\bpoignant\b/, terms: ['emotional', 'bittersweet', 'moving', 'heartfelt', 'poignant', 'heartwarming'], related: ['drama', 'romantic', 'loss', 'friendship'], adj: 'emotional', label: 'emotional depth' },
  dark: { re: /\bdark(?:er)?\b|\bgrim\b|\bbleak\b|\bgritty\b|\bnoir\b|\bdisturbing\b|\bedgy\b|\bedgier\b/, terms: ['dark', 'gritty', 'bleak', 'noir'], related: ['mysterious', 'thriller', 'horror'], adj: 'dark', label: 'a darker tone' },
  cinematography: { re: /\bcinematograph(?:y|ic|er)\b|\bvisual(?:ly|s)?\b(?![\s-]effects)|\bgorgeous\b|\bstunning\b|\bbeautiful(?:ly)? (?:shot|filmed|photographed|made|looking)\b|\bbeautiful to (?:look at|watch)\b|\beye[\s-]candy\b|\bstriking\b|\bimagery\b|\blooks? (?:beautiful|amazing|incredible|stunning)\b/, terms: ['beautiful cinematography', 'visually stunning', 'cinematography', 'stunning visuals'], related: ['colorful', 'atmospheric', 'visual effects', 'epic'], with: 'beautiful cinematography', label: 'beautiful cinematography' },
  soundtrack: { re: /\bsoundtracks?\b|\bscores?\b|\bmusic(?:al)?\b|\bsongs?\b|\bcomposers?\b/, terms: ['notable soundtrack', 'beautiful soundtrack', 'soundtrack', 'score', 'musical'], related: ['music'], with: 'a beautiful soundtrack', label: 'a notable soundtrack' },
  surreal: { re: /\bsurreal(?:ist)?\b|\bdream(?:like|y)\b|\bweird\b|\bbizarre\b|\bstrange\b|\btrippy\b|\babstract\b/, terms: ['surreal', 'dreamlike', 'dream'], related: ['mysterious', 'atmospheric', 'imagination'], adj: 'surreal', label: 'surreal, dreamlike imagery' },
  epic: { re: /\bepic\b|\bgrand\b|\bsweeping\b|\bspectacular\b|\bspectacle\b/, terms: ['epic'], related: ['adventure', 'fantasy', 'quest'], adj: 'epic', label: 'epic scale' },
  noDialogue: { re: /\bno dialogue\b|\bwithout (?:any )?(?:dialogue|words|talking|speech)\b|\bwordless\b|\bsilent\b|\bno talking\b|\bno words\b|\bdialogue[\s-]free\b/, terms: ['no dialogue'], related: [], with: 'no dialogue', label: 'no dialogue' },
  atmospheric: { re: /\batmospheric\b|\bmoody\b|\bmood piece\b/, terms: ['atmospheric'], related: ['meditative', 'mysterious', 'surreal'], adj: 'atmospheric', label: 'atmosphere' },
  intense: { re: /\bintense\b|\bgripping\b|\bthrilling\b|\bexciting\b|\bheart[\s-]pounding\b|\bfast[\s-]paced\b|\bpulse[\s-]pounding\b|\bedge[\s-]of[\s-](?:the[\s-])?seat\b/, terms: ['action packed', 'intense', 'suspenseful', 'tense', 'gripping'], related: ['action', 'thriller', 'adventure', 'visual effects'], adj: 'gripping', label: 'gripping momentum' },
  uplifting: { re: /\buplifting\b|\bfeel[\s-]good\b|\bhappy\b|\bcheer(?:ful|y)\b|\bhopeful\b|\bjoyful\b/, terms: ['uplifting', 'feel good', 'heartwarming', 'lighthearted'], related: ['comedy', 'family', 'colorful'], adj: 'uplifting', label: 'an uplifting mood' },
};
const FACET_KEYS = Object.keys(FACETS);
const INTENSE_CLUSTER = ['intense', 'thriller', 'action', 'dark', 'horror'];

// Normalized catalog vocabulary per facet (computed once).
for (const f of Object.values(FACETS)) {
  f.nterms = f.terms.map(normalize);
  f.nrelated = f.related.map(normalize);
}

const MOOD_LABELS = {
  'beautiful-cinematography': 'beautiful cinematography',
  'notable-soundtrack': 'notable soundtrack',
  'complex-plot': 'complex plot',
  'no-dialogue': 'no dialogue',
  'family-friendly': 'family-friendly',
  'action-packed': 'action-packed',
  'visual-effects': 'visual effects',
  'thought-provoking': 'thought-provoking',
};
const humanMood = (m) => MOOD_LABELS[m] || String(m).replace(/-/g, ' ');

const LANGS = {
  english: 'en', japanese: 'ja', french: 'fr', spanish: 'es', german: 'de', italian: 'it', korean: 'ko', chinese: 'zh', mandarin: 'zh', cantonese: 'zh',
  portuguese: 'pt', dutch: 'nl', hindi: 'hi', russian: 'ru', swedish: 'sv', danish: 'da', norwegian: 'no', finnish: 'fi', polish: 'pl', turkish: 'tr',
  arabic: 'ar', hebrew: 'he', greek: 'el', thai: 'th', indonesian: 'id', vietnamese: 'vi', czech: 'cs', hungarian: 'hu', ukrainian: 'uk',
};
const LANG_COUNTRY = { ja: 'JP', fr: 'FR', es: 'ES', de: 'DE', it: 'IT', ko: 'KR', zh: 'CN', pt: 'PT', nl: 'NL', hi: 'IN', ru: 'RU', sv: 'SE', da: 'DK', no: 'NO', fi: 'FI', pl: 'PL', tr: 'TR', he: 'IL', el: 'GR', th: 'TH', id: 'ID', vi: 'VN', cs: 'CZ', hu: 'HU', uk: 'UA' };
const LANG_RE = Object.keys(LANGS).join('|');

const NUM_WORDS = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15,
  twenty: 20, thirty: 30, forty: 40, 'forty five': 45, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, 'a hundred': 100,
  'one hundred': 100, 'a couple of': 2, 'half an': 0.5, 'half a': 0.5,
};
const NUM = String.raw`(\d+(?:\.\d+)?|a couple of|half an?|a hundred|one hundred|hundred|forty[\s-]five|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)`;
const UNIT = String.raw`(hours?|hrs?|h|minutes?|mins?|m)\b`;
const DUR = String.raw`${NUM}[\s-]*${UNIT}(?:\s*(?:and\s+)?(a half|\d+\s*(?:minutes?|mins?|m)\b))?`;

const SERIES_RE = /\bseries\b|\btv shows?\b|\b(?:a|the|some|any|good) shows?\b|\bshows\b|\bepisod(?:es|ic)\b|\bbinge(?:[\s-]?(?:watch|worthy|able))?\b|\bseasons?\b|\bsitcoms?\b|\bdocuseries\b/;
const MOVIE_RE = /\bmovies?\b|\bfilms?\b|\bfeatures?\b|\bcinema\b/;
const FOLLOW_UP_STRONG = /^\s*(?:and|but|also|or|ok(?:ay)?|hmm+|maybe|actually|what about|how about|instead|only|just|make it|preferably|ideally|then|now)\b/;
const FOLLOW_UP_WEAK = /^\s*(?:anything|something|less|more|shorter|longer|not|no|nothing|without|too|same|one|ones|yes|yeah|sure|please|in|with|a|an|the)\b/;
const FOLLOW_UP_ANY = /\binstead\b|\bshorter\b|\blonger\b|\bless\b|\bcalmer\b|\bgentler\b|\banother\b|\belse\b|\bthat one\b|\bthose\b|\bthese\b|\bthem\b|\bsame\b|\btoo\b/;
const OPEN_RE = /\bwhat (?:should|can|could|shall|do) (?:i|we) watch\b|\bsurprise me\b|\brecommend (?:me )?something\b|\bany (?:ideas|suggestions|recommendations)\b|\bwhat'?s good\b|\bwhat'?s on\b|\bi'?m bored\b|\bsomething to watch\b|\bwhat to watch\b|\bpick something\b|\bhelp me (?:choose|pick|decide)\b|\bsuggest something\b|\bwhat do you recommend\b/;
const RECOMMEND_RE = /\brecommend|\bsuggest|\bfind\b|\bshow me\b|\bi want\b|\bi(?:'d| would) like\b|\blooking for\b|\bsomething\b|\banything\b|\bwhat should\b|\bgive me\b|\bpick\b|\bin the mood\b|\bany (?:good )?(?:ideas|suggestions)\b/;
const COMPARE_RE = /\bcompare\b|\bcomparison\b|\bversus\b|\bvs\.?(?=\s|$)|\bdifferences? between\b|\bwhich (?:one |of (?:these|them|the two|the three|those) )?(?:is|should|would|do|to|has)\b|\bbetter\b|\bor\b/;
const SIMILAR_RE = /\bsimilar\b|(?<!\b(?:i'?d|would|we'?d|you'?d)\s)\blike\b(?!\s+to\b)|\bin the (?:vein|style|spirit) of\b|\breminds? (?:me )?of\b|\balong the lines of\b|\bsame (?:vibe|feel|mood)\b|\bloved\b|\bliked\b|\benjoyed\b|\badored\b|\bwatch (?:next|after)\b|\bnext\b|\bafter (?:this|that|it)\b|\bafterwards\b/;
// Questions about Velvia itself, thanks, and messages that have nothing to do with watching.
const META_RE = /\b(?:who|what) are you\b|\bare you (?:an? )?(?:ai|a\.i\.|bot|robot|human|real|person|chatbot|machine|computer|program|assistant)\b|\bwhat can you do\b|\bwhat do you do\b|\bhow do you work\b|\bhow does (?:this|velvia|it) work\b|\b(?:what|who) is velvia\b|\bwhat can i ask\b|^\s*help\s*[?!.]*\s*$/;
const THANKS_RE = /^\s*(?:(?:ok(?:ay)?|great|perfect|lovely|wonderful|brilliant|cool|nice)[,!.]?\s+)?(?:thanks|thank you|thx|ty|cheers|much appreciated)\b/;
const GREETING_RE = /^\s*(?:hi|hello|hey|hiya|good (?:morning|afternoon|evening|night)|konnichiwa|konbanwa)\b/;
const QUESTION_RE = /\?\s*$|^\s*(?:what|who|where|when|why|how|which|can|could|would|will|do|does|did|is|are|tell me|explain|write|translate|calculate|define)\b/;
const DOMAIN_RE = /\b(?:tonight|watch\w*|movies?|films?|series|shows?|tv|episodes?|seasons?|titles?|catalog(?:ue)?|lumina|cinema|stream\w*|recommend\w*|suggest\w*|actors?|actress(?:es)?|direct\w*|genres?|trailers?|velvia|play\w*|screen\w*|cartoons?|anime|documentar\w+)\b/;
const PRONOUN_RE = /\b(?:it|its|it's|this|that|this one|that one|the (?:film|movie|series|show|title))\b/;
const WORD_STOP = new Set(['a', 'an', 'the', 'some', 'something', 'anything', 'any', 'more', 'this', 'that', 'it', 'them', 'those', 'these', 'one', 'ones', 'my', 'your', 'what', 'how', 'which', 'who', 'watching', 'to', 'me', 'us', 'i', 'you', 'we', 'good', 'great', 'nice', 'stuff', 'things', 'thing', 'movie', 'movies', 'film', 'films', 'show', 'shows', 'series', 'title', 'titles', 'else', 'others', 'other', 'lumina', 'here', 'there', 'tonight', 'today', 'now', 'much', 'many', 'lot', 'lots', 'kind', 'sort', 'type', 'story', 'plot', 'music', 'soundtrack', 'visuals', 'ones']);
const COMMON_SINGLE = new Set(['dream', 'garden', 'nature', 'space', 'love', 'home', 'family', 'night', 'time', 'music', 'seasons', 'short', 'drama', 'comedy', 'action', 'horror', 'quiet', 'calm', 'relax', 'moon', 'snow', 'autumn', 'spring', 'summer', 'winter', 'light', 'dark', 'gold']);

// ───────────────────────────── Helpers ─────────────────────────────
const DOCS = new WeakMap();
function doc(t) {
  let d = DOCS.get(t);
  if (!d) {
    d = {
      genres: (t.genres || []).map((g) => ({ raw: g, n: normalize(g) })),
      moods: (t.moods || []).map((m) => ({ raw: m, n: normalize(m) })),
      keywords: [...(t.keywords || []), ...(t.tags || [])].map((k) => ({ raw: k, n: normalize(k) })),
      text: ` ${normalize(`${t.tagline || ''} ${t.synopsis || ''}`)} `,
      title: normalize(t.title),
      original: normalize(t.originalTitle || ''),
      people: [...(t.directors || []), ...(t.cast || [])].map((p) => ({ raw: p, n: normalize(p) })),
    };
    DOCS.set(t, d);
  }
  return d;
}

const containsTerm = (value, term) => value === term || ` ${value} `.includes(` ${term} `);
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
// Catalog terms read in lower case mid-sentence ("No dialogue and animation"); acronyms keep their case.
const lowerTerm = (w) => (/^[\p{Lu}\d]{2,}$/u.test(w) ? w : String(w).toLowerCase());
const lowerFirst = (s) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);
const article = (w) => (/^[aeiou]/i.test(w) && !/^(?:uni|eu|one)/i.test(w) ? 'an' : 'a');
const quote = (s) => `“${s}”`;
// "Sintel’s", "Garden Hours’" (a name ending in s takes only the apostrophe).
const possessive = (name) => (/s$/i.test(name) ? `${name}’` : `${name}’s`);
const baseLang = (code) => String(code || '').toLowerCase().split('-')[0];
const rankOf = (t) => (Number.isFinite(t.editorialRank) ? t.editorialRank : 1000);
const byEditorial = (a, b) => rankOf(a) - rankOf(b) || String(a.title).localeCompare(String(b.title)) || String(a.id).localeCompare(String(b.id));

function list(items, conj = 'and') {
  const xs = items.filter(Boolean);
  if (xs.length <= 1) return xs[0] || '';
  if (xs.length === 2) return `${xs[0]} ${conj} ${xs[1]}`;
  return `${xs.slice(0, -1).join(', ')} ${conj} ${xs[xs.length - 1]}`;
}

function minutesPhrase(n) {
  if (n === null || n === undefined) return '';
  if (n < 1) return 'under a minute';
  if (n === 1) return '1 minute';
  if (n < 120) return `${Math.round(n)} minutes`;
  return fmtRuntime(n);
}

function lengthShort(t) {
  if (t.type === 'series') {
    const parts = [];
    if (t.seasonCount) parts.push(`${t.seasonCount} season${t.seasonCount === 1 ? '' : 's'}`);
    if (t.episodeCount) parts.push(`${t.episodeCount} episode${t.episodeCount === 1 ? '' : 's'}`);
    return parts.join(', ');
  }
  if (!t.runtimeMin && t.runtimeMin !== 0) return '';
  return t.runtimeMin < 1 ? '<1 min' : t.runtimeMin < 60 ? `${Math.round(t.runtimeMin)} min` : fmtRuntime(t.runtimeMin);
}

function describeRuntime(t) {
  if (t.type === 'series') {
    const s = lengthShort(t);
    return s ? `${s}${t.runtimeMin ? ` of about ${minutesPhrase(t.runtimeMin)} each` : ''}` : '';
  }
  return t.runtimeMin || t.runtimeMin === 0 ? minutesPhrase(t.runtimeMin) : '';
}

const langNames = (codes) => (codes || []).map((c) => (baseLang(c) === 'zxx' ? 'no dialogue' : languageName(c)));
const isNoDialogue = (t) => t.originalLanguage === 'zxx' || ((t.audioLanguages || []).length > 0 && t.audioLanguages.every((l) => baseLang(l) === 'zxx'));
const verified4k = (t) => (t.resolutions || [])[0] >= 2160;
const mentions4k = (t) => (t.keywords || []).some((k) => /\b4k\b/i.test(k)) || /\b4k\b|3840|2160/i.test(`${t.synopsis || ''} ${t.tagline || ''}`);
const musicCredits = (t) => (t.credits?.crew || []).filter((c) => /music|composer|score/i.test(c.job || '')).map((c) => c.name);

// ───────────────────────────── Message parsing ─────────────────────────────
function numberValue(raw) {
  const s = raw.replace(/-/g, ' ').trim();
  if (/^\d/.test(s)) return Number(s);
  return NUM_WORDS[s] ?? null;
}

function durationMinutes(num, unit, extra) {
  const n = numberValue(num);
  if (n === null) return null;
  const u = unit.toLowerCase();
  let minutes = u.startsWith('h') ? n * 60 : n;
  if (extra) {
    if (/half/.test(extra)) minutes += u.startsWith('h') ? 30 : 0;
    else {
      const m = Number(extra.match(/\d+/)?.[0] || 0);
      minutes += m;
    }
  }
  return Math.round(minutes);
}

/** Replaces matched spans with spaces so later patterns do not match them again. */
function mask(state, re, fn) {
  state.s = state.s.replace(re, (...args) => {
    const m = args[0];
    fn(...args);
    return ' '.repeat(m.length);
  });
}

function facetKeysIn(text) {
  const keys = [];
  for (const k of FACET_KEYS) if (FACETS[k].re.test(text)) keys.push(k);
  return keys;
}

/**
 * Parses one viewer message into facets, constraints and flags. Exported for tests.
 * @returns {{ facets: string[], avoid: string[], soften: string[], boost: string[], constraints: object, flags: object, refs: {text:string, strong:boolean}[], topics: string[] }}
 */
export function parseMessage(raw, { ignore = [] } = {}) {
  const text = String(raw || '').replace(/[’‘`]/g, "'").slice(0, 2000);
  let lowered = ` ${text.toLowerCase()} `;
  // Catalog title names must not read as moods ("Garden Hours" is not a request for gardens).
  for (const name of ignore) {
    if (name && name.length >= 2) lowered = lowered.replace(new RegExp(escapeRe(name.toLowerCase()), 'g'), (m) => ' '.repeat(m.length));
  }
  lowered = lowered.replace(/(\d+)\s*h\s*(\d+)\s*(?:m|mins?|minutes?)?\b/g, (m, h, mm) => `${Number(h) * 60 + Number(mm)} minutes`);
  const st = { s: lowered };
  const c = {};
  const flags = {};
  const avoid = new Set();
  const soften = new Set();
  const boost = new Set();

  // Runtime: explicit bounds first ("under two hours", "< 90 min", "90 minutes or less").
  const upper = new RegExp(String.raw`(?<![a-z])(under|less than|shorter than|below|no (?:more|longer) than|not (?:more|longer) than|at most|max(?:imum)?(?: of)?|within|up to|<=?|≤)\s*(?:about |around |roughly |approximately )?${DUR}`, 'g');
  mask(st, upper, (m, op, num, unit, extra) => {
    const mins = durationMinutes(num, unit, extra);
    if (mins) c.maxRuntime = /under|less|shorter|below|^<$/.test(op) && op !== '<=' ? mins - 1 : mins;
  });
  mask(st, new RegExp(String.raw`${DUR}\s*(?:or (?:less|under|shorter|fewer)|max(?:imum)?|tops|at most)`, 'g'), (m, num, unit, extra) => {
    const mins = durationMinutes(num, unit, extra);
    if (mins) c.maxRuntime = mins;
  });
  mask(st, new RegExp(String.raw`(?<![a-z])(over|more than|longer than|at least|minimum(?: of)?|>=?|≥)\s*(?:about |around )?${DUR}`, 'g'), (m, op, num, unit, extra) => {
    const mins = durationMinutes(num, unit, extra);
    if (mins) c.minRuntime = /over|more|longer|^>$/.test(op) && op !== '>=' ? mins + 1 : mins;
  });
  // Time available: "I have 20 minutes", "we've only got an hour", "45 minutes to spare".
  const fits = (m, num, unit, extra) => {
    const mins = durationMinutes(num, unit, extra);
    if (mins) c.maxRuntime ??= mins;
  };
  mask(st, new RegExp(String.raw`\b(?:i|we)(?:'ve| have| 've got| have got| got| only have| just have)?\s+(?:only\s+|just\s+)?(?:got\s+)?(?:about\s+|around\s+|roughly\s+|maybe\s+)?${DUR}`, 'g'), fits);
  mask(st, new RegExp(String.raw`${DUR}\s+(?:to spare|to kill|free|before (?:bed|dinner|work|school))`, 'g'), fits);
  mask(st, new RegExp(String.raw`\b(?:a|an)\s+${DUR}\s+(?:long\s+)?(?:film|movie|feature|watch|episode)`, 'g'), (m, num, unit, extra) => {
    const mins = durationMinutes(num, unit, extra);
    if (mins) {
      c.maxRuntime ??= Math.round(mins * 1.25);
      c.minRuntime ??= Math.round(mins * 0.75);
    }
  });
  mask(st, /\b(?:feature|full)[\s-]length\b/g, () => { c.minRuntime ??= 60; });
  mask(st, /\b(?:not|nothing|isn't|no)\s+(?:too|very|so|overly)?\s*long\b/g, () => { c.maxRuntime ??= 100; });
  mask(st, /\bshorter\b|\bquicker\b|\bless long\b/g, () => { flags.shorter = true; });
  mask(st, /\blonger\b/g, () => { flags.longer = true; });
  mask(st, /\b(?:short|quick|brief|bite[\s-]sized)\b(?![\s-]film)/g, () => { flags.short = true; });
  mask(st, /\bshort[\s-]films?\b/g, () => { flags.short = true; c.type ??= 'movie'; });
  mask(st, /\b(?:a|something|anything)\s+long\b/g, () => { c.minRuntime ??= 90; });

  // Seasons and format.
  mask(st, /\b(several|multiple|many|lots of|a lot of|a few|a couple of|a bunch of|two or more|2 or more|more than one|at least (?:two|2|three|3)|\d+\s*\+?|two|three|four|five)\s+seasons?\b/g, (m, q) => {
    const n = /^\d/.test(q) ? Number(q.match(/\d+/)[0]) : /three|3/.test(q) ? 3 : /four/.test(q) ? 4 : /five/.test(q) ? 5 : 2;
    c.type = 'series';
    c.minSeasons = Math.max(2, n);
  });
  mask(st, /\blong[\s-]running\b/g, () => { c.type = 'series'; c.minSeasons = 2; });
  mask(st, /\bmini[\s-]?series\b|\blimited series\b|\b(?:one|single) season\b/g, () => { c.type = 'series'; c.maxSeasons = 1; });

  // Picture quality.
  mask(st, /\b4k\b|\buhd\b|\bultra[\s-]?hd\b|\b2160p?\b/g, () => { c.minHeight = 2160; });
  mask(st, /\b1080p?\b|\bfull[\s-]hd\b/g, () => { c.minHeight = Math.max(c.minHeight || 0, 1080); });
  mask(st, /\bhd\b|\bhigh[\s-]def(?:inition)?\b|\b720p\b/g, () => { c.minHeight = Math.max(c.minHeight || 0, 720); });
  mask(st, /\bhdr\b|\bdolby vision\b/g, () => { c.hdr = true; });

  // Languages: subtitles, then audio, then country/original language.
  mask(st, new RegExp(String.raw`\b(${LANG_RE})\s+(?:subtitles?|subs|captions|cc)\b|\b(?:subtitles?|subs|captions|cc)\s+(?:in|for)\s+(${LANG_RE})\b|\bsubtitled\s+(?:in(?:to)?\s+)?(${LANG_RE})\b`, 'g'), (m, a, b, d) => {
    c.subtitleLang = LANGS[a || b || d];
  });
  mask(st, /\bwith\s+(?:subtitles?|subs|captions|closed captions|cc)\b|\bsubtitled\b|\bcaptioned\b|\bhas subtitles\b|\bsubtitles\b/g, () => { c.needSubs = true; });
  mask(st, new RegExp(String.raw`\b(${LANG_RE})[\s-](?:language\s+)?(?:films?|movies?|cinema|series|shows?|animation|anime|dramas?|titles?)\b`, 'g'), (m, l) => {
    c.origin = LANGS[l];
    if (/film|movie|cinema/.test(m)) c.type ??= 'movie';
    if (/series|show/.test(m)) c.type ??= 'series';
  });
  mask(st, new RegExp(String.raw`\b(?:dubbed|dub)\s+(?:in(?:to)?\s+)?(${LANG_RE})\b|\b(${LANG_RE})\s+(?:audio|dub|dubbed|dubbing|voices?|voice track|language track|dialogue)\b|\bspoken\s+in\s+(${LANG_RE})\b|\bin\s+(${LANG_RE})\b`, 'g'), (m, a, b, d, e) => {
    c.audioLang = LANGS[a || b || d || e];
  });

  // Audience.
  mask(st, /\b(?:toddlers?|preschool(?:ers)?|babies)\b/g, () => { c.maxAge = 0; });
  mask(st, /\b(?:little|young|small) (?:kids|children|ones)\b/g, () => { c.maxAge = Math.min(c.maxAge ?? 99, 7); });
  mask(st, /\bfamily (?:movie|film) night\b|\bfamily night\b/g, () => { c.maxAge = Math.min(c.maxAge ?? 99, 8); c.type ??= 'movie'; flags.familyNight = true; });
  mask(st, /\bmovie night\b/g, () => { c.type ??= 'movie'; });
  mask(st, /\b(?:for|with) (?:the |my |our )?(?:kids|children|family|son|daughter|little ones)\b|\bkid[\s-]?friendly\b|\bchild[\s-]?friendly\b|\bsuitable for (?:kids|children)\b|\ball ages\b|\bkids?\b|\bchildren\b/g, () => {
    c.maxAge = Math.min(c.maxAge ?? 99, 8);
  });
  mask(st, /\b(?:for )?teen(?:ager)?s?\b/g, () => { c.maxAge = Math.min(c.maxAge ?? 99, 13); });

  // Positive phrases that would otherwise read as negations ("no dialogue").
  if (FACETS.noDialogue.re.test(st.s)) {
    boost.add('noDialogue');
    mask(st, new RegExp(FACETS.noDialogue.re.source, 'g'), () => {});
  }

  // Softening and negation.
  mask(st, /\b(?:calmer|gentler|softer|lighter|chiller|quieter|easier|more relaxed|more relaxing|toned[\s-]down|not as (?:intense|dark|scary))\b/g, () => {
    for (const k of INTENSE_CLUSTER) soften.add(k);
    boost.add('relaxing');
  });
  mask(st, /\bless\s+([a-z-]+)/g, (m, w) => {
    const keys = facetKeysIn(` ${w} `);
    if (/intense|scary|dark|violent|action|exciting|gripping|heavy|serious/.test(w)) {
      for (const k of INTENSE_CLUSTER) soften.add(k);
      boost.add('relaxing');
    }
    for (const k of keys) soften.add(k);
  });
  mask(st, /\b(?:no|not|nothing|without|avoid|skip|never|isn't|is not|don't want|do not want|none of the)\s+(too\s+|very\s+|so\s+|overly\s+)?(?:anything\s+|any\s+|something\s+|more\s+|a\s+)?([a-z][a-z'-]*(?:\s+[a-z][a-z'-]*){0,2})/g, (m, degree, phrase) => {
    const keys = facetKeysIn(` ${phrase} `);
    for (const k of keys) (degree ? soften : avoid).add(k);
    if (/^(?:series|shows?|tv)\b/.test(phrase)) c.type = 'movie';
    else if (/^(?:movies?|films?)\b/.test(phrase)) c.type = 'series';
  });
  mask(st, /\b(?:darker|more intense|more exciting|more gripping|scarier|edgier)\b/g, (m) => {
    if (/dark|edg/.test(m)) boost.add('dark');
    else if (/scar/.test(m)) boost.add('horror');
    else boost.add('intense');
  });

  // Positive facets.
  const facets = new Set(boost);
  for (const k of FACET_KEYS) if (!avoid.has(k) && !soften.has(k) && FACETS[k].re.test(st.s)) facets.add(k);
  // "intense" and "thriller" overlap; keep both, scoring handles overlap.

  // Format.
  const series = SERIES_RE.test(st.s);
  const movie = MOVIE_RE.test(st.s);
  if (series && movie) {
    if (/\b(?:series|shows?)\b[^.?!]*\binstead\b/.test(st.s)) c.type = 'series';
    else if (/\b(?:movies?|films?)\b[^.?!]*\binstead\b/.test(st.s)) c.type = 'movie';
  } else if (series) c.type = 'series';
  else if (movie && !c.type) c.type = 'movie';
  if (/\beither\b|\bany (?:type|format)\b|\bmovie or (?:a )?series\b|\bseries or (?:a )?movie\b/.test(st.s)) c.type = null;

  // Flags.
  const lower = ` ${text.toLowerCase()} `;
  if (/\bre[\s-]?watch\b|\bwatch (?:it |them |something )?again\b|\balready (?:seen|watched)\b|\bseen before\b|\bold favou?rites?\b|\bcomfort (?:watch|film|show)\b/.test(lower)) flags.rewatch = true;
  if (/\b(?:something|anything) else\b|\banother\b|\bother (?:options|ones|titles|picks|suggestions|ideas)\b|\bdifferent\b|\bmore (?:options|suggestions|picks|ideas)\b|\bnot (?:that|those|these) ones?\b|\bnone of (?:those|these|them)\b/.test(lower)) flags.excludePrev = true;
  if (/\bnew(?:est)?\b(?! conversation)|\blatest\b|\brecent(?:ly)?(?: added)?\b|\bjust added\b/.test(lower)) flags.preferNew = true;
  if (/\b(?:highly|best|top|well)[\s-]rated\b|\bacclaimed\b|\bmost popular\b|\bcrowd[\s-]pleas/.test(lower)) flags.preferRated = true;
  if (OPEN_RE.test(lower)) flags.open = true;
  if (META_RE.test(lower)) flags.meta = true;
  if (THANKS_RE.test(lower)) flags.thanks = true;
  if (GREETING_RE.test(lower)) flags.greeting = true;
  if (QUESTION_RE.test(text.toLowerCase().trim()) && !DOMAIN_RE.test(lower) && !OPEN_RE.test(lower)) flags.offTopic = true;
  const words = normalize(text).split(' ').filter(Boolean).length;
  flags.words = words;
  if (FOLLOW_UP_STRONG.test(text.toLowerCase()) || FOLLOW_UP_ANY.test(lower)) flags.followUp = true;
  else if (FOLLOW_UP_WEAK.test(text.toLowerCase()) && words <= 5) flags.followUp = true;
  if (RECOMMEND_RE.test(lower)) flags.request = true;

  return {
    facets: [...facets],
    avoid: [...avoid],
    soften: [...soften],
    boost: [...boost],
    constraints: c,
    flags,
    refs: extractRefs(text),
    topics: detectTopics(lower),
  };
}

// Title references the viewer makes ("similar to Interstellar", "tell me about “Sintel”").
const REF_FRAMES = [
  /(?:similar to|reminds? me of|in the (?:vein|style|spirit) of|along the lines of|the same (?:vibe|feel) as|comparable to|fans? of|a fan of)\s+(.+?)(?=[?.!,;:]|\s+(?:but|and|with|that|which|or|except|only|please|though|because|if|for|to|in|on)\b|$)/gi,
  /(?:something|anything|movies?|films?|shows?|series|titles?|more|stuff|ones?|things|picks|else)\s+like\s+(.+?)(?=[?.!,;:]|\s+(?:but|and|with|that|which|or|except|only|please|though|because|if|for|to|in|on)\b|$)/gi,
  /(?:tell me (?:more )?about|what do you know about|thoughts on|info(?:rmation)? on|details (?:on|about)|what is|what's|is|do you have|have you got|can i (?:watch|stream)|where (?:is|can i find)|i (?:loved|liked|enjoyed|adored|just watched|watched|saw)|(?:loved|liked|enjoyed|adored))\s+(.+?)(?=[?.!,;:]|\s+(?:but|and|with|that|which|or|except|only|please|though|because|if|for|to|on lumina|available|any good|good|worth)\b|$)/gi,
];
const STRONG_FRAME = /similar|remind|vein|style|spirit|lines|vibe|feel|comparable|fan|like|about|know|thoughts|info|details|have|stream|find|loved|liked|enjoyed|adored|watched|saw/i;

function extractRefs(text) {
  const out = [];
  const seen = new Set();
  const push = (raw, strong, quoted = false, weak = false) => {
    let x = raw.trim().replace(/^[“"']|[”"']$/g, '').replace(/'s\b.*$/i, '').replace(/\s+(?:movie|film|series|show|please|instead|again|too)$/i, '').trim();
    if (!x || x.length < 2 || x.length > 60 || x.split(/\s+/).length > 8) return;
    const words = normalize(x).split(' ').filter(Boolean);
    if (!words.length) return;
    if (!quoted) {
      const capitalised = /(?:^|\s)[\p{Lu}\p{N}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
      // "The Matrix" is a title; "the cinematography" is not.
      if (words[0] === 'the' ? !capitalised.test(x.replace(/^the\s+/i, '')) : WORD_STOP.has(words[0])) return;
      if (words.every((w) => WORD_STOP.has(w) || facetKeysIn(` ${w} `).length || LANGS[w] || /^\d+$/.test(w))) return;
      if (!capitalised.test(x) && !strong) return;
      // After a weak frame the name itself must start with a capital ("is Sintel…", "what is The Matrix").
      if (weak && !/^(?:the\s+)?[\p{Lu}\p{N}]/u.test(x.replace(/^the\s+/i, (m) => m.toLowerCase()))) return;
    }
    if (x === x.toLowerCase() && /^[a-z]/.test(x)) x = x.replace(/\b[a-z]/g, (ch) => ch.toUpperCase());
    const key = normalize(x);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ text: x, strong: strong || quoted, quoted });
  };
  for (const m of text.matchAll(/["“]([^"“”]{2,60})["”]/g)) push(m[1], true, true);
  for (const re of REF_FRAMES) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const frame = m[0].slice(0, m[0].length - m[1].length);
      // "is X" and "what is X" are weak frames: only accept capitalised or quoted names.
      const weak = /^(?:what is|what's|is)\s*$/i.test(frame.trim());
      push(m[1], !weak && STRONG_FRAME.test(frame), false, weak);
    }
  }
  return out;
}

const TOPICS = {
  availability: /\bon lumina\b|\bavailable\b|\bcan i (?:watch|stream)\b|\bdo you have\b|\bhave you got\b|\bis there\b/,
  story: /\bwhat(?:'s| is| are)\b.*\babout\b|\babout\?|\bstory\b|\bplot\b|\bsynopsis\b|\bpremise\b|\bsummar(?:y|ise|ize)\b|\bhappens\b/,
  genres: /\bgenres?\b|\bwhat (?:kind|type|sort) of\b/,
  themes: /\bthemes?\b|\bthematic\b|\bmoods?\b|\btone\b|\bvibe\b|\bmessage\b/,
  cast: /\bcast\b|\bactors?\b|\bactress(?:es)?\b|\bstarring\b|\bstars\b|\bwho(?:'s| is)? in\b|\bdirector\b|\bdirected\b|\bcrew\b|\bwho made\b|\bcreators?\b|\bwho (?:wrote|directed)\b/,
  cinematography: /\bcinematograph(?:y|er|ic)\b|\bvisuals?\b|\bcamera\b|\bphotography\b|\blook(?:s)? like\b|\bshot\b|\bhow does it look\b/,
  soundtrack: /\bsoundtrack\b|\bscore\b|\bmusic\b|\bcomposer\b|\bsongs?\b/,
  pacing: /\bpac(?:ing|ed|e)\b|\bslow\b|\bfast\b|\bboring\b|\bdrag\b/,
  runtime: /\bhow long\b|\bruntime\b|\blength\b|\bduration\b|\bhow many (?:episodes|seasons)\b/,
  audience: /\bkids?\b|\bchild(?:ren)?\b|\bfamily\b|\bage\b|\brated\b|\bage rating\b|\bappropriate\b|\bsuitable\b|\bscary\b|\bviolen(?:t|ce)\b|\bmature\b|\bteens?\b/,
  languages: new RegExp(String.raw`\blanguages?\b|\baudio\b|\bdub(?:bed)?\b|\bspoken\b|\bdialogue\b|\bin (?:${LANG_RE})\b`),
  subtitles: /\bsubtitles?\b|\bsubs\b|\bcaptions?\b|\bcc\b/,
  quality: /\b4k\b|\bhd\b|\bquality\b|\bresolution\b|\bhdr\b|\b1080p?\b|\buhd\b/,
  release: /\bwhat year\b|\bwhen was (?:it|this|that|[\p{L}\s]+) (?:made|released|filmed|shot|out)\b|\brelease(?:d| date)\b|\bhow old is\b/u,
  reception: /\breviews?\b|\bmember ratings?\b|\bratings?\b|\bworth (?:it|watching)\b|\bany good\b|\bis it good\b/,
};

function detectTopics(lower) {
  return Object.keys(TOPICS).filter((k) => TOPICS[k].test(lower));
}

// ───────────────────────────── Title matching ─────────────────────────────
/** Catalog titles named in `raw`, in order of appearance. */
function findMentions(raw, titles, { trusted = false } = {}) {
  const text = String(raw || '');
  const norm = ` ${normalize(text)} `;
  // Words the viewer typed with a capital letter (accent-insensitive), for single-word titles.
  const capitalised = new Set(text.split(/[^\p{L}\p{N}]+/u).filter((w) => /^\p{Lu}/u.test(w)).map((w) => normalize(w)));
  const hits = [];
  for (const t of titles) {
    const d = doc(t);
    let hit = null;
    for (const name of [d.title, d.original]) {
      if (!name || hit) continue;
      const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(name);
      const i = cjk ? norm.indexOf(name) : norm.indexOf(` ${name} `);
      if (i < 0) continue;
      const len = name.length;
      if (cjk || (name.includes(' ') && len >= 4)) hit = { at: i, len };
      else if (len >= 3 && (trusted || capitalised.has(name) || (len >= 4 && !COMMON_SINGLE.has(name)))) hit = { at: i, len };
    }
    if (!hit && d.title.includes(' ')) {
      // The leading word of a longer title, typed with a capital ("Kōyō", "Elephants").
      const first = d.title.split(' ')[0];
      const i = norm.indexOf(` ${first} `);
      if (i >= 0 && first.length >= 4 && !COMMON_SINGLE.has(first) && (trusted || capitalised.has(first))) hit = { at: i, len: first.length };
    }
    if (hit) hits.push({ t, ...hit });
  }
  // A shorter title matched inside a longer matched title ("Dune" in "Dune: Part Two") is dropped.
  const kept = hits.filter((h) => !hits.some((o) => o !== h && o.len > h.len && o.at <= h.at && o.at + o.len >= h.at + h.len));
  kept.sort((x, y) => x.at - y.at || y.len - x.len);
  return kept.map((h) => h.t);
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Resolves a free-text reference to a catalog title (typo tolerant), or null. */
function resolveRef(refText, titles) {
  const n = normalize(refText);
  if (!n) return null;
  let best = null;
  let bestD = Infinity;
  for (const t of titles) {
    const d = doc(t);
    for (const name of [d.title, d.original]) {
      if (!name) continue;
      if (name === n) return t;
      const budget = Math.max(typoBudget(n.length), n.length >= 12 ? 3 : 0);
      if (!budget) continue;
      const dist = editDistance(n, name, budget);
      if (dist <= budget && dist < bestD) {
        best = t;
        bestD = dist;
      }
    }
  }
  return best;
}

function findPeople(raw, titles) {
  const norm = ` ${normalize(raw)} `;
  const people = new Map();
  for (const t of titles) {
    for (const p of doc(t).people) {
      if (!p.n.includes(' ') || !norm.includes(` ${p.n} `)) continue;
      const director = (t.directors || []).includes(p.raw);
      const prev = people.get(p.n);
      people.set(p.n, { n: p.n, name: p.raw, director: director || !!prev?.director });
    }
  }
  return [...people.values()];
}

/** True when two titles share something a viewer would recognise (not just the "Short" genre). */
function meaningfulOverlap(a, b) {
  const da = doc(a);
  const db = doc(b);
  if (da.genres.some((g) => g.n !== 'short' && db.genres.some((x) => x.n === g.n))) return true;
  if (da.moods.some((m) => db.moods.some((x) => x.n === m.n))) return true;
  return da.people.some((p) => db.people.some((x) => x.n === p.n));
}

/** Titles Velvia suggested in an assistant turn ("Suggested: A · B" line, else named titles). */
function titlesInAssistant(content, titles) {
  const text = String(content || '');
  const line = text.match(/(?:^|\n)\s*(?:suggested|suggestions|recommended|picks)(?: titles)?\s*:\s*(.+)$/im);
  if (line) {
    const names = line[1].split(/\s*(?:·|;|\|)\s*/).map((s) => normalize(s)).filter(Boolean);
    const byName = new Map(titles.map((t) => [doc(t).title, t]));
    const found = names.map((n) => byName.get(n)).filter(Boolean);
    if (found.length) return found;
  }
  return findMentions(text, titles, { trusted: true });
}

// ───────────────────────────── Scoring ─────────────────────────────
function facetMatch(t, key) {
  const f = FACETS[key];
  const d = doc(t);
  let primary = 0;
  let related = 0;
  const hits = [];
  const seen = new Set();
  const note = (raw) => {
    const label = humanMood(raw);
    if (!seen.has(label)) {
      seen.add(label);
      hits.push(label);
    }
  };
  for (const term of f.nterms) {
    const g = d.genres.find((x) => containsTerm(x.n, term));
    if (g) { primary += 3; note(g.raw); continue; }
    const m = d.moods.find((x) => containsTerm(x.n, term));
    if (m) { primary += 2; note(m.raw); continue; }
    const k = d.keywords.find((x) => containsTerm(x.n, term));
    if (k) { primary += 1; note(k.raw); continue; }
    if (term.length >= 5 && d.text.includes(` ${term} `)) primary += 0.5;
  }
  if (key === 'noDialogue' && isNoDialogue(t)) { primary += 2; note('no-dialogue'); }
  for (const term of f.nrelated) {
    const x = d.genres.find((y) => containsTerm(y.n, term)) || d.moods.find((y) => containsTerm(y.n, term)) || d.keywords.find((y) => containsTerm(y.n, term));
    if (x) {
      related += 1;
      if (!primary) note(x.raw);
    }
  }
  return { primary: Math.min(primary, 6), related: Math.min(related, 3), strong: primary >= 1, hits };
}

function passesHard(t, c, { ignore = new Set() } = {}) {
  if (!ignore.has('type') && c.type && t.type !== c.type) return false;
  if (!ignore.has('seasons') && c.minSeasons && !(t.type === 'series' && (t.seasonCount || 0) >= c.minSeasons)) return false;
  if (!ignore.has('seasons') && c.maxSeasons && !(t.type === 'series' && (t.seasonCount || 0) <= c.maxSeasons)) return false;
  if (!ignore.has('runtime')) {
    if (c.maxRuntime && !(Number.isFinite(t.runtimeMin) && t.runtimeMin <= c.maxRuntime)) return false;
    if (c.minRuntime && !(Number.isFinite(t.runtimeMin) && t.runtimeMin >= c.minRuntime) && t.type !== 'series') return false;
  }
  if (!ignore.has('quality')) {
    if (c.minHeight && !((t.resolutions || [])[0] >= c.minHeight)) return false;
    if (c.hdr && !t.hdr) return false;
  }
  if (!ignore.has('language')) {
    if (c.audioLang && !(t.audioLanguages || []).some((l) => baseLang(l) === c.audioLang)) return false;
    if (c.subtitleLang && !(t.subtitleLanguages || []).some((l) => baseLang(l) === c.subtitleLang)) return false;
    if (c.needSubs && !(t.subtitleLanguages || []).length) return false;
    if (c.origin && baseLang(t.originalLanguage) !== c.origin && !(t.countries || []).includes(LANG_COUNTRY[c.origin])) return false;
  }
  // Audience limits are never relaxed.
  if (c.maxAge !== undefined && c.maxAge !== null && !(Number(t.minAge ?? 18) <= c.maxAge)) return false;
  return true;
}

function signalsFor(titles, signals, useHistory) {
  const byId = new Map(titles.map((t) => [t.id, t]));
  if (!useHistory || !signals) return { byId, history: [], watched: new Set(), taste: new Map(), historyTitles: [] };
  const history = (signals.history || []).filter((h) => byId.has(h.titleId));
  const completed = (signals.progress || []).filter((p) => p.completed && byId.get(p.titleId)?.type === 'movie').map((p) => p.titleId);
  const seeds = [];
  for (const h of history.slice(0, 50)) seeds.push({ title: byId.get(h.titleId), weight: 1 });
  for (const w of signals.watchlist || []) if (byId.has(w.titleId)) seeds.push({ title: byId.get(w.titleId), weight: 0.8 });
  for (const [id, r] of Object.entries(signals.ratings || {})) if (byId.has(id)) seeds.push({ title: byId.get(id), weight: (Number(r) - 3) * 1.2 });
  return {
    byId,
    history,
    historyTitles: history.map((h) => byId.get(h.titleId)),
    watched: new Set([...history.map((h) => h.titleId), ...completed]),
    taste: tasteProfile(seeds),
    disliked: new Set(Object.entries(signals.ratings || {}).filter(([, r]) => Number(r) <= 2).map(([id]) => id)),
  };
}

// ───────────────────────────── Conversation state ─────────────────────────────
function cleanMessages(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-20)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));
}

/** True when Velvia's previous turn ended by asking the viewer something. */
function askedQuestion(prevAssistant) {
  if (!prevAssistant) return false;
  const body = prevAssistant.replace(/(?:^|\n)\s*(?:suggested|suggestions|recommended|picks)(?: titles)?\s*:.*$/gim, '').trim();
  return /\?\s*$/.test(body);
}

function isFollowUp(parsed, prevAssistant) {
  if (parsed.flags.followUp) return true;
  // A short answer to a question Velvia just asked continues that thread.
  if (askedQuestion(prevAssistant) && parsed.flags.words <= 6) return true;
  const ownFacets = parsed.facets.length > 0;
  const hasConstraints = Object.keys(parsed.constraints).length > 0 || parsed.flags.shorter || parsed.flags.longer || parsed.flags.short;
  return !ownFacets && !parsed.refs.length && hasConstraints && !parsed.flags.request;
}

function buildState(msgs, titles) {
  const turns = [];
  let lastAssistant = null;
  for (const m of msgs) {
    if (m.role === 'assistant') lastAssistant = m.content;
    else {
      const mentions = findMentions(m.content, titles);
      const ignore = mentions.flatMap((t) => [t.title, t.originalTitle].filter(Boolean));
      turns.push({ text: m.content, mentions, parsed: parseMessage(m.content, { ignore }), prevAssistant: lastAssistant, prevRecs: lastAssistant ? titlesInAssistant(lastAssistant, titles) : [] });
    }
  }
  if (!turns.length) return null;
  let start = turns.length - 1;
  while (start > 0 && isFollowUp(turns[start].parsed, turns[start].prevAssistant)) start--;

  const facets = new Map();
  const avoid = new Set();
  const soften = new Set();
  const c = {};
  const flags = {};
  let unknownRef = null;
  const { prevAssistant, prevRecs } = turns[turns.length - 1];

  for (let i = start; i < turns.length; i++) {
    const p = turns[i].parsed;
    const latest = i === turns.length - 1;
    const w = latest ? 1 : 0.6;
    for (const k of p.avoid) { avoid.add(k); facets.delete(k); }
    for (const k of p.soften) { soften.add(k); facets.delete(k); }
    for (const k of p.facets) {
      facets.set(k, Math.max(facets.get(k) || 0, p.boost.includes(k) && !latest ? 0.6 : w));
      avoid.delete(k);
      soften.delete(k);
    }
    for (const [k, v] of Object.entries(p.constraints)) {
      if (v === undefined) continue;
      c[k] = v;
      if (k === 'type' && v === 'movie') { delete c.minSeasons; delete c.maxSeasons; }
      if (k === 'maxRuntime' && c.minRuntime && c.minRuntime > v) delete c.minRuntime;
      if (k === 'minRuntime' && c.maxRuntime && c.maxRuntime < v) delete c.maxRuntime;
    }
    if (p.flags.short && !p.constraints.maxRuntime) c.maxRuntime = Math.min(c.maxRuntime || 40, 40);
    if (p.flags.shorter && !p.constraints.maxRuntime) {
      const ref = turns[i].prevRecs[0]?.runtimeMin;
      c.maxRuntime = ref ? Math.max(1, Math.min(c.maxRuntime || Infinity, ref - 1)) : Math.max(1, Math.floor((c.maxRuntime || 40) * 0.75));
      delete c.minRuntime;
    }
    if (p.flags.longer && !p.constraints.minRuntime) {
      const ref = turns[i].prevRecs[0]?.runtimeMin;
      c.minRuntime = ref ? ref + 1 : Math.max(c.minRuntime || 0, (c.maxRuntime || 60) + 1);
      delete c.maxRuntime;
    }
    for (const k of ['rewatch', 'preferNew', 'preferRated', 'familyNight']) if (p.flags[k]) flags[k] = true;
    const unknown = p.refs.find((r) => !resolveRef(r.text, titles));
    if (unknown) unknownRef = unknown.text;
  }
  const latest = turns[turns.length - 1];
  for (const k of ['excludePrev', 'open', 'request', 'followUp']) if (latest.parsed.flags[k]) flags[k] = true;
  return { facets, avoid, soften, constraints: c, flags, unknownRef, latest, turns, prevRecs, prevAssistant, carried: start < turns.length - 1 };
}

// ───────────────────────────── Analysis ─────────────────────────────
/**
 * Reads the conversation and ranks the catalog. The server uses this to build the grounded
 * candidate set for conversational providers; respond() turns it into a reply.
 */
export function analyze(titles, payload = {}, signals = {}) {
  const pool = Array.isArray(titles) ? titles.filter((t) => t && t.id && t.title) : [];
  const msgs = cleanMessages(payload?.messages);
  const useHistory = payload?.options?.useHistory !== false && signals?.useHistory !== false;
  const sig = signalsFor(pool, signals, useHistory);
  const state = buildState(msgs, pool);
  const context = payload?.context || {};
  // Context ids the viewer cannot see (parental limits, unpublished) are ignored silently.
  const contextTitle = context.titleId ? sig.byId.get(context.titleId) || null : null;
  const compareIds = [...new Set(Array.isArray(context.compareIds) ? context.compareIds : [])].slice(0, 3);
  const compareTitles = compareIds.map((id) => sig.byId.get(id)).filter(Boolean);

  const a = { pool, msgs, sig, state, contextTitle, compareTitles, useHistory, intent: 'recommend', target: null, compare: [], topics: [], unknown: null, people: [], ranked: [], full: [], partial: [], closest: [], relaxed: [] };
  if (!state) {
    a.intent = 'open';
    a.ranked = openPicks(a);
    return a;
  }
  const latestText = state.latest.text;
  const lower = ` ${latestText.toLowerCase()} `;
  const parsed = state.latest.parsed;
  const mentions = [...state.latest.mentions];
  for (const r of parsed.refs) {
    const t = resolveRef(r.text, pool);
    if (t && !mentions.includes(t)) mentions.push(t);
  }
  a.people = findPeople(latestText, pool);
  a.topics = parsed.topics;
  const unknownNow = parsed.refs.find((r) => !resolveRef(r.text, pool) && !findMentions(r.text, pool).length && !findPeople(r.text, pool).length);

  // Ordinal or pronoun references to Velvia's previous suggestions ("the second one", "is it scary?").
  let prevRef = null;
  const ord = lower.match(/\bthe (first|second|third|fourth|fifth|last)(?: one| pick| option| title| film| movie| series| suggestion)?\b/);
  if (ord && state.prevRecs.length) {
    const idx = { first: 0, second: 1, third: 2, fourth: 3, fifth: 4, last: state.prevRecs.length - 1 }[ord[1]];
    prevRef = state.prevRecs[idx] || null;
  } else if (state.prevRecs.length && !contextTitle && PRONOUN_RE.test(lower) && (parsed.topics.length || /\?/.test(lower)) && !parsed.flags.request) {
    prevRef = state.prevRecs[0];
  }

  // 0. Messages that are not a request about a title: questions about Velvia, thanks, and
  //    questions that have nothing to do with watching (answered honestly, never with picks).
  const plain = !parsed.facets.length && !parsed.avoid.length && !parsed.soften.length && !hasConstraints(parsed.constraints) && !parsed.refs.length
    && !mentions.length && !a.people.length && !parsed.topics.length && !parsed.flags.shorter && !parsed.flags.longer && !parsed.flags.short
    && !parsed.flags.open && !parsed.flags.request && compareTitles.length < 2;
  if (plain && (parsed.flags.meta || parsed.flags.thanks || (parsed.flags.offTopic && !PRONOUN_RE.test(lower)))) {
    a.intent = parsed.flags.meta ? 'about' : parsed.flags.thanks ? 'thanks' : 'offtopic';
    return a;
  }
  a.greeting = !!parsed.flags.greeting;

  // 1. Compare two or three titles.
  if (compareTitles.length >= 2) a.compare = compareTitles;
  else if (mentions.length >= 2 && COMPARE_RE.test(lower)) a.compare = mentions.slice(0, 3);
  else if (state.prevRecs.length >= 2 && (/\bcompare\b.*\b(?:top (?:two|three|2|3)|first (?:two|three)|them|these|those)\b/.test(lower) || /\bwhich (?:one |of (?:them|these|those|the two|the three) )?(?:is|has|would|should)\b/.test(lower))) {
    a.compare = state.prevRecs.slice(0, /\b(?:three|3)\b/.test(lower) ? 3 : 2);
  }
  if (a.compare.length >= 2) {
    a.intent = 'compare';
    a.ranked = rankForCompare(a);
    return a;
  }

  // 2. A single title the message is about.
  const refersToContext = contextTitle && (PRONOUN_RE.test(lower) || mentions.includes(contextTitle) || (parsed.topics.length > 0 && (!parsed.facets.length || !parsed.flags.request)) || SIMILAR_RE.test(lower));
  const target = mentions[0] || (refersToContext ? contextTitle : null) || prevRef;
  const wantsSimilar = SIMILAR_RE.test(lower);
  const asksAbout = parsed.topics.length > 0 || /\?|\btell me\b|\bexplain\b|\bdescribe\b|\bwhat(?:'s| is)\b/.test(lower);
  const nextWords = /\bnext\b|\bafter\b|\blike\b|\bsimilar\b|\bmore\b/.test(lower);

  if (unknownNow && !target) {
    a.unknown = unknownNow.text;
    a.intent = wantsSimilar || !asksAbout ? 'similar' : 'discuss';
  } else if (target && wantsSimilar && (!parsed.topics.length || nextWords)) {
    a.intent = 'similar';
    a.target = target;
  } else if (target && (asksAbout || !parsed.facets.length) && !(parsed.flags.request && parsed.facets.length && !mentions.length)) {
    a.intent = 'discuss';
    a.target = target;
  }

  if (a.intent === 'discuss' && a.target) {
    // A family question about a title that is not for younger viewers: offer suitable picks.
    if (parsed.topics.includes('audience') && Number(a.target.minAge ?? 18) > 8) {
      state.constraints = { maxAge: 8 };
      state.facets = new Map();
      a.ranked = rankTitles(a, { similarTo: a.target });
      if (!a.ranked.length) a.ranked = rankTitles(a, {});
    }
    return a;
  }
  if (a.intent === 'discuss') return a;

  if (a.intent === 'similar' && a.target) {
    const rt = a.target.runtimeMin;
    if (parsed.flags.shorter && !parsed.constraints.maxRuntime && Number.isFinite(rt)) state.constraints.maxRuntime = Math.max(1, rt - 1);
    if (parsed.flags.longer && !parsed.constraints.minRuntime && Number.isFinite(rt)) state.constraints.minRuntime = rt + 1;
    a.ranked = rankTitles(a, { similarTo: a.target });
    return a;
  }
  if (a.intent === 'similar' && a.unknown) {
    // Not in the catalog: use only the traits the viewer described (never outside knowledge).
    if (state.facets.size || hasConstraints(state.constraints)) a.ranked = rankTitles(a, {});
    return a;
  }

  // 3. Recommendations.
  const nothingAsked = !state.facets.size && !hasConstraints(state.constraints) && !a.people.length && !state.flags.preferNew && !state.flags.preferRated;
  if (nothingAsked && state.unknownRef && state.carried) {
    a.intent = 'similar';
    a.unknown = state.unknownRef;
    return a;
  }
  if (nothingAsked) {
    a.intent = 'open';
    a.ranked = openPicks(a);
    return a;
  }
  if (state.unknownRef && state.carried) a.unknown = state.unknownRef;
  a.intent = 'recommend';
  a.ranked = rankTitles(a, {});
  return a;
}

const hasConstraints = (c) => Object.values(c).some((v) => v !== null && v !== undefined && v !== false);

function scoreTitle(a, t, { similarTo, facets }) {
  const { state, sig } = a;
  let score = 0;
  const strongKeys = [];
  const hits = [];
  const relatedHits = [];
  for (const [k, w] of facets) {
    const m = facetMatch(t, k);
    score += w * (m.primary + 0.35 * m.related);
    if (m.strong) {
      strongKeys.push(k);
      hits.push(...m.hits);
    } else if (m.related) relatedHits.push(...m.hits);
  }
  for (const k of state.soften) {
    const m = facetMatch(t, k);
    score -= 1.5 * m.primary + 0.3 * m.related;
  }
  let simScore = 0;
  if (similarTo) {
    simScore = similarityScore(similarTo, t);
    score += 2 * simScore;
  }
  const people = a.people.filter((p) => doc(t).people.some((x) => x.n === p.n));
  if (people.length) score += 4 * people.length;
  if (state.constraints.maxAge !== undefined && state.constraints.maxAge !== null) {
    score += 0.5 * facetMatch(t, 'family').primary;
  }
  let taste = 0;
  if (sig.taste.size) {
    taste = tasteScore(sig.taste, t);
    score += Math.min(taste, 30) / 12;
    if (sig.disliked?.has(t.id)) score -= 3;
  }
  if (state.flags.preferNew && t.year) score += Math.max(0, (t.year - 1990) / 36);
  if (state.flags.preferRated && t.memberRating?.count) score += (t.memberRating.average / 5) * 1.5;
  return { t, score, strongKeys, hits: [...new Set(hits)], relatedHits: [...new Set(relatedHits)], simScore, people, taste };
}

function compareScored(x, y) {
  return y.strongKeys.length - x.strongKeys.length || y.score - x.score || byEditorial(x.t, y.t);
}

function rankTitles(a, { similarTo = null, extraConstraints = {} }) {
  const { state, sig, pool } = a;
  const c = { ...state.constraints, ...extraConstraints };
  const facets = state.facets;
  const excluded = new Set();
  if (!state.flags.rewatch) for (const id of sig.watched) excluded.add(id);
  if (similarTo) excluded.add(similarTo.id);
  if (state.flags.excludePrev) for (const t of state.prevRecs) excluded.add(t.id);
  const avoid = [...state.avoid];
  const eligible = (t) => !excluded.has(t.id) && !avoid.some((k) => facetMatch(t, k).strong);
  const want = facets.size;
  const matches = (x) => (similarTo ? (x.simScore > 0.2 && meaningfulOverlap(similarTo, x.t)) || x.strongKeys.length > 0 : want ? x.strongKeys.length > 0 : a.people.length ? x.people.length > 0 : true);
  a.excludedWatched = [...sig.watched].some((id) => !state.flags.rewatch && pool.some((t) => t.id === id && passesHard(t, c)));

  const score = (items) => items.map((t) => scoreTitle(a, t, { similarTo, facets })).sort(compareScored);
  const candidates = (ignore) => score(pool.filter((t) => eligible(t) && passesHard(t, c, { ignore })));
  const related = (x) => x.strongKeys.length > 0 || x.relatedHits.length > 0;
  let ranked = candidates(new Set()).filter(matches);
  a.full = ranked.filter((x) => (similarTo || !want ? true : x.strongKeys.length >= want));
  a.partial = a.full.length ? [] : ranked;
  if (ranked.length) return ranked;

  // Nothing matches exactly. Closest options, in order of usefulness (the audience limit is
  // never relaxed): one requirement relaxed with the facets intact, then the same
  // requirements with related moods, then one requirement relaxed with related moods, then
  // every requirement relaxed. Everything returned is labelled as a closest option.
  const groups = [['quality', ['minHeight', 'hdr']], ['runtime', ['maxRuntime', 'minRuntime']], ['seasons', ['minSeasons', 'maxSeasons']], ['type', ['type']], ['language', ['audioLang', 'subtitleLang', 'needSubs', 'origin']]]
    .filter(([, keys]) => keys.some((k) => c[k] !== undefined && c[k] !== null && c[k] !== false))
    .map(([name]) => name);
  const attempts = [];
  for (const g of groups) attempts.push({ ignore: [g], filter: matches });
  if (want) attempts.push({ ignore: [], filter: related });
  if (want) for (const g of groups) attempts.push({ ignore: [g], filter: related });
  if (groups.length > 1) attempts.push({ ignore: groups, filter: want ? related : matches });
  for (const at of attempts) {
    ranked = candidates(new Set(at.ignore)).filter(at.filter);
    if (ranked.length) {
      a.relaxed = at.ignore;
      break;
    }
  }
  if (c.minHeight >= 2160) {
    // Titles whose catalog description mentions 4K are the honest closest options.
    ranked.sort((x, y) => Number(mentions4k(y.t)) - Number(mentions4k(x.t)) || compareScored(x, y));
  }
  a.closest = ranked;
  return ranked;
}

function openPicks(a) {
  const { pool, sig, state } = a;
  const excluded = state?.flags?.rewatch ? new Set() : sig.watched;
  const scored = pool
    .filter((t) => !excluded.has(t.id) && !sig.disliked?.has(t.id))
    .map((t) => ({ t, score: sig.taste.size ? Math.min(tasteScore(sig.taste, t), 30) / 12 : 0, strongKeys: [], hits: [], relatedHits: [], simScore: 0, people: [], taste: sig.taste.size ? tasteScore(sig.taste, t) : 0 }))
    .sort((x, y) => y.score - x.score || byEditorial(x.t, y.t));
  // Three different directions: vary the lead genre and the format.
  const picks = [];
  const genresUsed = new Set();
  for (const x of scored) {
    const g = normalize(x.t.genres?.[0] || x.t.type);
    if (genresUsed.has(g)) continue;
    picks.push(x);
    genresUsed.add(g);
    if (picks.length === 3) break;
  }
  for (const x of scored) {
    if (picks.length >= 3) break;
    if (!picks.includes(x)) picks.push(x);
  }
  return picks;
}

function rankForCompare(a) {
  const { state } = a;
  const c = state.constraints;
  const facets = state.facets;
  const shorter = state.latest.parsed.flags.shorter || state.latest.parsed.flags.short || c.maxRuntime;
  const longer = state.latest.parsed.flags.longer || c.minRuntime;
  const scored = a.compare.map((t) => {
    const x = scoreTitle(a, t, { facets });
    x.prefHits = [];
    for (const [k] of facets) if (facetMatch(t, k).strong) x.prefHits.push(k);
    return x;
  });
  const runtimes = scored.map((x) => (Number.isFinite(x.t.runtimeMin) ? x.t.runtimeMin : null)).filter((v) => v !== null);
  const minRt = Math.min(...runtimes);
  const maxRt = Math.max(...runtimes);
  for (const x of scored) {
    x.cmp = x.score;
    if (shorter && x.t.runtimeMin === minRt && minRt !== maxRt) { x.cmp += 2; x.prefHits.push('shorter'); }
    if (longer && x.t.runtimeMin === maxRt && minRt !== maxRt) { x.cmp += 2; x.prefHits.push('longer'); }
    if (c.minHeight && (x.t.resolutions || [])[0] >= c.minHeight) { x.cmp += 2; x.prefHits.push('quality'); }
    if (c.maxAge !== undefined && c.maxAge !== null) x.cmp += Number(x.t.minAge ?? 18) <= c.maxAge ? 2 : -2;
    if (c.type && x.t.type === c.type) x.cmp += 0.5;
  }
  a.hasPreference = !!(facets.size || shorter || longer || c.minHeight || c.maxAge !== undefined || c.type || a.state.flags.preferRated);
  return scored.sort((x, y) => y.cmp - x.cmp || byEditorial(x.t, y.t));
}

// ───────────────────────────── Language ─────────────────────────────
/** Describes the request in words: { head: 'a psychological thriller', tail: 'under two hours' }. */
const GENRE_ADJ = new Set(['psychological', 'scifi', 'fantasy', 'horror', 'animation', 'romance', 'action', 'ambient', 'nature', 'family']);

function describeRequest(state, people = []) {
  const c = state.constraints;
  const adjs = [];
  const withs = [];
  let noun = null;
  let genreAdj = false;
  for (const k of state.facets.keys()) {
    const f = FACETS[k];
    if (f.noun && !noun) noun = f.noun;
    else if (f.noun) adjs.push(f.noun);
    if (f.adj) {
      // Mood adjectives read first: "a relaxing fantasy title".
      if (GENRE_ADJ.has(k)) { adjs.push(f.adj); genreAdj = true; } else adjs.unshift(f.adj);
    }
    if (f.with) withs.push(f.with);
  }
  const typeNoun = c.type === 'series' ? 'series' : c.type === 'movie' ? 'film' : null;
  let head;
  if (noun) head = `${adjs.join(' ')} ${noun}${c.type === 'series' ? ' series' : ''}`.trim();
  else if (typeNoun) head = `${adjs.join(' ')} ${typeNoun}`.trim();
  else if (genreAdj) head = `${adjs.join(' ')} title`;
  else head = adjs.length ? `something ${list(adjs)}` : '';
  if (head && !head.startsWith('something')) head = `${article(head)} ${head}`;
  if (withs.length) head = `${head || 'something'} with ${list(withs)}`;
  const tail = [];
  if (people.length) tail.push(list(people.map((p) => `${p.director ? 'by' : 'with'} ${p.name}`)));
  if (c.maxRuntime) tail.push(c.maxRuntime >= 119 && c.maxRuntime <= 120 ? 'under two hours' : `under ${minutesPhrase(c.maxRuntime % 5 === 4 ? c.maxRuntime + 1 : c.maxRuntime)}`);
  if (c.minRuntime) tail.push(`of at least ${minutesPhrase(c.minRuntime)}`);
  if (c.minSeasons) tail.push('with several seasons');
  if (c.maxSeasons === 1) tail.push('with a single season');
  if (c.minHeight >= 2160) tail.push('in 4K');
  else if (c.minHeight) tail.push(`in ${c.minHeight >= 1080 ? 'Full HD' : 'HD'}`);
  if (c.hdr) tail.push('in HDR');
  if (c.audioLang) tail.push(`in ${languageName(c.audioLang)}`);
  if (c.origin) tail.push(`from ${languageName(c.origin)}-language cinema`);
  if (c.subtitleLang) tail.push(`with ${languageName(c.subtitleLang)} subtitles`);
  else if (c.needSubs) tail.push('with subtitles');
  if (state.flags.familyNight) tail.push('for a family movie night');
  else if (c.maxAge !== undefined && c.maxAge !== null) tail.push(c.maxAge <= 8 ? 'for younger viewers' : 'for teens');
  return { head, tail: tail.join(' '), typeNoun };
}

function requestSummary(state, people) {
  const { head, tail, typeNoun } = describeRequest(state, people);
  return [head || (typeNoun ? `${article(typeNoun)} ${typeNoun}` : 'something'), tail].filter(Boolean).join(' ');
}

function historyReason(a, t) {
  if (!a.sig.historyTitles.length) return '';
  const d = doc(t);
  const g = new Set(d.genres.map((x) => x.n).filter((x) => x !== 'short'));
  const m = new Set(d.moods.map((x) => x.n));
  const src = a.sig.historyTitles.find((h) => h.id !== t.id && (doc(h).genres.some((x) => g.has(x.n)) || doc(h).moods.some((x) => m.has(x.n))));
  return src ? `Because you watched ${src.title}` : '';
}

function reasonFor(a, x, { closest = false, similarTo = null } = {}) {
  const t = x.t;
  const c = a.state?.constraints || {};
  const parts = [];
  let lead = '';
  if (similarTo) {
    const dt = doc(t);
    const ds = doc(similarTo);
    const genres = dt.genres.filter((g) => g.n !== 'short' && ds.genres.some((y) => y.n === g.n)).map((g) => g.raw.toLowerCase());
    const moods = dt.moods.filter((g) => ds.moods.some((y) => y.n === g.n)).map((g) => humanMood(g.raw));
    const sharedDirector = (t.directors || []).find((p) => (similarTo.directors || []).includes(p));
    if (sharedDirector) lead = `Also directed by ${sharedDirector}`;
    else if (genres.length) lead = `Shares ${possessive(similarTo.title)} ${list(genres.slice(0, 2))} genre${genres.length > 1 ? 's' : ''}`;
    else if (moods.length) lead = `${cap(list(moods.slice(0, 2)))}, like ${similarTo.title}`;
    else lead = cap(list((t.moods || []).slice(0, 2).map(humanMood))) || cap((t.genres || [])[0] || 'Film');
    if (moods.length && (genres.length || sharedDirector)) parts.push(list(moods.slice(0, 2)));
  } else if (x.people?.length) {
    const p = x.people[0].name;
    lead = (t.directors || []).includes(p) ? `Directed by ${p}` : `With ${p}`;
  } else if (x.hits.length) {
    lead = cap(list(x.hits.slice(0, 2).map(lowerTerm)));
    const genreOnly = x.hits.every((h) => (t.genres || []).some((g) => g.toLowerCase() === h.toLowerCase()));
    const moods = (t.moods || []).map(humanMood).filter((m) => !x.hits.includes(m)).slice(0, 2);
    if (genreOnly && moods.length) parts.push(list(moods));
  } else if (closest && x.relatedHits.length) {
    lead = cap(list(x.relatedHits.slice(0, 2).map(lowerTerm)));
  } else {
    const moods = (t.moods || []).slice(0, 2).map(humanMood);
    lead = moods.length ? cap(list(moods)) : cap((t.genres || [])[0] || (t.type === 'series' ? 'Series' : 'Film'));
  }
  if (closest) lead = `Closest option: ${lowerFirst(lead)}`;
  const len = lengthShort(t);
  if (len) parts.push(c.maxRuntime && t.type !== 'series' && Number.isFinite(t.runtimeMin) ? `runs ${minutesPhrase(t.runtimeMin)}` : len);
  if (verified4k(t)) parts.push('available in 4K');
  else if (c.minHeight >= 2160 && mentions4k(t)) parts.push('4K is mentioned in its description, but the stream isn’t verified yet');
  else if (c.minHeight >= 2160) parts.push('resolution detected at playback');
  if (c.maxAge !== undefined && c.maxAge !== null && t.ageRating) parts.push(`rated ${t.ageRating}`);
  if (c.audioLang && (t.audioLanguages || []).some((l) => baseLang(l) === c.audioLang)) parts.push(`${languageName(c.audioLang)} audio`);
  if (c.subtitleLang && (t.subtitleLanguages || []).some((l) => baseLang(l) === c.subtitleLang)) parts.push(`${languageName(c.subtitleLang)} subtitles`);
  const hist = a.useHistory && x.taste > 0 ? historyReason(a, t) : '';
  if (hist) parts.push(hist);
  return [lead, ...parts].filter(Boolean).slice(0, 4).join(' · ');
}

function recItem(a, x, opts = {}) {
  const item = { titleId: x.t.id, reason: reasonFor(a, x, opts), title: x.t };
  if (opts.closest) item.closest = true;
  return item;
}

function followUps(a, recs) {
  const c = a.state?.constraints || {};
  const out = [];
  const top = recs[0]?.title;
  if (top && !(top.type === 'movie' && top.runtimeMin <= 5)) out.push('Something shorter');
  out.push(c.type === 'series' ? 'What about a film instead?' : 'What about a series instead?');
  if ([...(a.state?.facets?.keys() || [])].some((k) => INTENSE_CLUSTER.includes(k))) out.push('Less intense');
  if (top) out.push(`More like ${top.title}`);
  if (recs.length >= 2) out.push('Compare the top two');
  return out.slice(0, 4);
}

const count = (n) => ['no', 'one', 'two', 'three', 'four', 'five', 'six'][n] || String(n);

function firstSentence(s) {
  const m = String(s).match(/^.*?[.!?](?:\s|$)/);
  return (m ? m[0] : String(s)).trim();
}

/** One sentence introducing a title: its synopsis opening, or its catalog facts. */
function introduce(t, { named = false } = {}) {
  const first = t.synopsis ? firstSentence(t.synopsis) : '';
  if (first.length >= 50) return first;
  return named ? `It’s ${describeBrief(t)}.` : `${t.title} is ${describeBrief(t)}.`;
}

function describeBrief(t) {
  const moods = (t.moods || []).slice(0, 2).map(humanMood);
  const kind = t.type === 'series' ? 'series' : (t.runtimeMin ?? 99) <= 40 ? 'short film' : 'film';
  const len = describeRuntime(t);
  const lead = moods.length ? `${article(moods[0])} ${list(moods)} ${kind}` : `${article(kind)} ${kind}`;
  return `${lead}${len ? ` (${len})` : ''}`;
}

// ───────────────────────────── Composition ─────────────────────────────
/** Builds Velvia's answer from the catalog alone. See the header comment for the shape. */
export function respond(titles, payload = {}, signals = {}) {
  return composeResponse(analyze(titles, payload, signals));
}

/** Turns an analyze() result into Velvia's answer. */
export function composeResponse(a) {
  let out;
  if (!a.pool.length) {
    out = {
      reply: 'The Lumina catalog has no titles I can suggest right now. Once titles are published, I can recommend and compare them for you.',
      recommendations: [],
      suggestions: [],
    };
  } else if (a.intent === 'about') out = composeAbout(a);
  else if (a.intent === 'thanks') out = composeThanks();
  else if (a.intent === 'offtopic') out = composeOffTopic();
  else if (a.intent === 'compare') out = composeCompare(a);
  else if (a.intent === 'discuss' && a.target) out = composeDiscuss(a);
  else if (a.unknown && !a.ranked.length) out = composeUnknown(a);
  else if (a.intent === 'similar' && a.target) out = composeSimilar(a);
  else if (a.intent === 'open') out = composeOpen(a);
  else out = composeRecommend(a);
  const result = {
    reply: out.reply,
    recommendations: (out.recommendations || []).slice(0, MAX_RECOMMENDATIONS),
    clarifyingQuestion: out.clarifyingQuestion || '',
    suggestions: (out.suggestions || []).slice(0, 4),
    provider: 'local',
    fallback: false,
    intent: a.intent,
  };
  if (out.comparison) result.comparison = out.comparison;
  if (a.unknown) result.notInCatalog = [a.unknown];
  return result;
}

function composeAbout(a) {
  const askedWhat = /^\s*(?:so\s+|and\s+)?are you\b/i.test(a.state.latest.text);
  return {
    reply: `${askedWhat ? 'I’m not a person or a general-purpose assistant. ' : ''}I’m Velvia, Lumina’s film and series concierge, and this answer comes from Lumina’s built-in catalog engine: fixed rules that match what you describe — mood, genre, length, picture quality, language, who it’s for — against what the Lumina catalog records. I only ever suggest titles that are really here, and I can recommend something, find titles like one you enjoyed, compare two or three, or tell you what the catalog says about a title.`,
    recommendations: [],
    clarifyingQuestion: 'What are you in the mood for?',
    suggestions: ['What should I watch tonight?', 'Something calm', 'Something with a complex plot', 'Recommend a series'],
  };
}

function composeThanks() {
  return {
    reply: 'You’re welcome — enjoy your time in the gardens. Whenever you’d like another suggestion, just ask.',
    recommendations: [],
    clarifyingQuestion: '',
    suggestions: ['What should I watch tonight?', 'Something calm', 'Something gripping'],
  };
}

function composeOffTopic() {
  return {
    reply: 'I can only help with choosing and understanding the films and series in the Lumina catalog, so I can’t answer that one. Tell me a mood, a title you enjoyed or how much time you have, and I’ll find something that’s here.',
    recommendations: [],
    clarifyingQuestion: '',
    suggestions: ['What should I watch tonight?', 'Something calm', 'Something funny'],
  };
}

function composeOpen(a) {
  const picks = a.ranked.slice(0, 3);
  if (!picks.length) {
    return {
      reply: 'You’ve already watched everything I would suggest from the catalog right now. Ask me for something to rewatch, or tell me a mood and I’ll look again.',
      recommendations: [],
      clarifyingQuestion: 'Would you like a favourite to rewatch?',
      suggestions: ['Something to rewatch', 'Something calm', 'Something gripping'],
    };
  }
  const personal = a.sig.taste.size && picks.some((x) => x.taste > 0);
  const names = picks.map((x) => x.t.title);
  return {
    reply: `${a.greeting ? 'Hello. ' : ''}${personal ? 'Going by what you’ve been watching, here' : 'Here'} are ${picks.length === 3 ? 'three' : picks.length === 2 ? 'two' : 'a'} different direction${picks.length === 1 ? '' : 's'} from the Lumina catalog: ${list(names)}. ${names[0]} is ${describeBrief(picks[0].t)}.`,
    recommendations: picks.map((x) => recItem(a, x)),
    clarifyingQuestion: 'Something calm, or something gripping?',
    suggestions: ['Something calm', 'Something gripping', 'Something funny', 'A series to settle into'],
  };
}

function composeRecommend(a) {
  const { state } = a;
  const c = state.constraints;
  const summary = requestSummary(state, a.people);
  const { tail, typeNoun } = describeRequest(state, a.people);
  const closest = !a.full.length;
  const source = closest ? (a.closest.length ? a.closest : a.partial) : a.full;
  const picks = source.slice(0, closest ? 3 : MAX_RECOMMENDATIONS);
  const recs = picks.map((x) => recItem(a, x, { closest }));
  const sentences = [];
  const unknownNote = a.unknown ? `${quote(a.unknown)} isn’t available on Lumina, so I’ve gone by what you described. ` : '';
  const agePhrase = c.maxAge !== undefined && c.maxAge !== null;

  if (!picks.length) {
    return {
      reply: `${unknownNote}I couldn’t find ${summary.replace(/^something\b/, 'anything')} in the Lumina catalog, and I won’t suggest titles that aren’t here.${agePhrase ? ' I only suggest titles within the age limit you asked for.' : ''} Try describing a different mood, genre or length and I’ll look again.`,
      recommendations: [],
      clarifyingQuestion: 'What matters most to you tonight — the mood, the length or the genre?',
      suggestions: ['Something calm', 'Something with a complex plot', 'Something funny'],
    };
  }

  const top = picks[0];
  const noFacets = !state.facets.size;
  if (!closest) {
    if (noFacets && state.flags.familyNight) {
      sentences.push(`${unknownNote}For a family movie night, ${top.t.title} is a lovely place to start — ${describeBrief(top.t)}, rated ${top.t.ageRating}.`);
      sentences.push(`Everything below is rated for younger viewers${picks.some((x) => x.t.ratingSource === 'advisory') ? ' (Lumina assigns advisory ratings where no official one exists)' : ''}.`);
    } else if (noFacets) {
      const plural = typeNoun === 'series' ? 'series' : typeNoun === 'film' ? 'films' : 'titles';
      const singular = typeNoun || 'title';
      if (picks.length === 1) sentences.push(`${unknownNote}${top.t.title} is the only ${singular}${tail ? ` ${tail}` : ''} in the catalog right now.`);
      else sentences.push(`${unknownNote}Here are ${count(picks.length)} ${plural} from the Lumina catalog${tail ? ` ${tail}` : ''}.`);
      sentences.push(picks.length === 1 ? introduce(top.t, { named: true }) : `${top.t.title} is a good place to start: ${describeBrief(top.t)}.`);
    } else {
      if (picks.length === 1) sentences.push(`${unknownNote}${top.t.title} is the one title in the catalog right now that fits ${summary}.`);
      else sentences.push(`${unknownNote}Here are ${count(picks.length)} titles from the Lumina catalog for ${summary}.`);
      if (picks.length > 1) sentences.push(`${top.t.title} is the strongest match — ${lowerFirst(recs[0].reason.split(' · ')[0])}${describeRuntime(top.t) ? `, ${top.t.type === 'series' ? describeRuntime(top.t) : `at ${describeRuntime(top.t)}`}` : ''}.`);
      else sentences.push(introduce(top.t, { named: true }));
    }
  } else if (a.relaxed.includes('quality') && c.minHeight >= 2160) {
    const kind = c.type === 'series' ? 'series' : c.type === 'movie' ? 'movie' : 'title';
    sentences.push(`${unknownNote}No ${kind} on Lumina has verified 4K yet — resolution is confirmed when media is checked, and otherwise the player detects it at playback.`);
    sentences.push(mentions4k(top.t)
      ? `${possessive(top.t.title)} catalog description mentions 4K, so it’s the closest option; its streaming resolution will be confirmed at playback.`
      : 'The titles below are the closest options, clearly labelled; their quality is detected at playback.');
  } else {
    sentences.push(`${unknownNote}I couldn’t find ${summary.replace(/^something\b/, 'anything')} in the Lumina catalog right now.`);
    const facetKeys = [...state.facets.keys()];
    const bests = facetKeys.map((k) => ({ k, x: picks.find((p) => p.strongKeys.includes(k)) })).filter((b) => b.x);
    const otherRelaxed = a.relaxed.filter((r) => r !== 'quality');
    if (bests.length >= 2 && bests[0].x !== bests[1].x) {
      sentences.push(`These are the closest real options: ${bests[0].x.t.title} for ${FACETS[bests[0].k].label}, and ${bests[1].x.t.title} for ${FACETS[bests[1].k].label}.`);
    } else if (otherRelaxed.length) {
      const names = { runtime: 'length', seasons: 'season count', type: 'format', language: 'language' };
      sentences.push(`The closest real options are below, clearly labelled — they don’t meet the ${list(otherRelaxed.map((r) => names[r]))} you asked for.`);
    } else {
      const feel = [...new Set(picks.flatMap((p) => (p.hits.length ? p.hits : p.relatedHits)))].slice(0, 3);
      sentences.push(`These are the closest real options, clearly labelled${feel.length ? ` — they share some of that feel (${list(feel)})` : ''} without being an exact match.`);
    }
  }
  if (a.excludedWatched && !state.flags.rewatch) sentences.push('I’ve left out titles you’ve already watched.');
  return {
    reply: sentences.slice(0, 4).join(' '),
    recommendations: recs,
    clarifyingQuestion: '',
    suggestions: followUps(a, recs),
  };
}

function composeSimilar(a) {
  const t = a.target;
  const closest = !a.full.length;
  const ranked = closest ? a.closest : a.full;
  const picks = ranked.slice(0, closest ? 3 : MAX_RECOMMENDATIONS);
  const recs = picks.map((x) => recItem(a, x, { similarTo: t, closest }));
  if (!picks.length) {
    return {
      reply: `Nothing else in the Lumina catalog is closely related to ${t.title} right now${hasConstraints(a.state.constraints) ? ' with those requirements' : ''}. Tell me what you enjoyed about it — the mood, the story or the look — and I’ll search by that instead.`,
      recommendations: [],
      clarifyingQuestion: `What did you enjoy most about ${t.title}?`,
      suggestions: ['The mood', 'The story', 'The visuals', 'The music'],
    };
  }
  const top = picks[0];
  const shared = recs[0].reason.split(' · ')[0].replace(/^Closest option: /, '');
  const sentences = [closest
    ? `Nothing in the catalog is a close match for ${t.title} with those requirements, so ${top.t.title} is the closest option — ${lowerFirst(shared)}.`
    : `If you enjoyed ${t.title}, ${top.t.title} is the closest match in the catalog — ${lowerFirst(shared)}.`];
  if (picks.length > 1) sentences.push(`I’ve added ${count(picks.length - 1)} more below, ranked by the genres, moods and filmmakers they have in common.`);
  if (a.excludedWatched) sentences.push('Titles you’ve already watched are left out.');
  return {
    reply: sentences.join(' '),
    recommendations: recs,
    clarifyingQuestion: '',
    suggestions: [`Tell me about ${top.t.title}`, 'Something shorter', picks.length > 1 ? 'Compare the top two' : 'What should I watch tonight?'],
  };
}

function composeUnknown(a) {
  const name = a.unknown;
  if (a.intent === 'discuss') {
    return {
      reply: `${quote(name)} isn’t available on Lumina, so I can’t tell you about it from the catalog — and I won’t guess. Tell me what you’re in the mood for and I’ll find something that is here.`,
      recommendations: [],
      clarifyingQuestion: 'What kind of film or series are you looking for?',
      suggestions: ['Something calm', 'Something with a complex plot', 'What should I watch tonight?'],
    };
  }
  return {
    reply: `${quote(name)} isn’t available on Lumina, so I can’t match it directly — and I’d rather not guess at what you loved about it. Tell me what drew you in, and I’ll find the closest titles that are in the catalog.`,
    recommendations: [],
    clarifyingQuestion: `What did you enjoy most about ${name}?`,
    suggestions: ['The big ideas and mysteries', 'The emotional story', 'The visuals', 'The music'],
  };
}

// ── Discussing one title (catalog metadata only) ──
function composeDiscuss(a) {
  const t = a.target;
  let topics = a.topics.filter((k) => k !== 'availability' || a.topics.length === 1);
  if (!topics.length) topics = ['overview'];
  const reply = topics.slice(0, 3).map((topic) => discussTopic(a, t, topic)).join(' ');
  const recs = topics.includes('audience') && a.ranked.length ? a.ranked.slice(0, 3).map((x) => recItem(a, x)) : [];
  const options = [
    ['story', `What’s ${t.title} about?`],
    ['cast', `Who made ${t.title}?`],
    ['audience', `Is ${t.title} right for kids?`],
    ['similar', `More like ${t.title}`],
  ];
  return {
    reply,
    recommendations: recs,
    clarifyingQuestion: '',
    suggestions: options.filter(([k]) => !topics.includes(k) && !(k === 'story' && topics.includes('overview'))).map(([, label]) => label).slice(0, 3),
  };
}

function discussTopic(a, t, topic) {
  const name = t.title;
  const moods = (t.moods || []).map(humanMood);
  const genres = t.genres || [];
  switch (topic) {
    case 'availability':
      return `Yes — ${name} is in the Lumina catalog${t.playable === false ? ', though it has no playable media yet' : ''}.`;
    case 'story':
      return t.synopsis ? `From its catalog synopsis: ${t.synopsis}` : `The catalog doesn’t include a synopsis for ${name} yet.`;
    case 'genres':
      return genres.length ? `${name} is listed as ${list(genres)}.` : `The catalog doesn’t list genres for ${name}.`;
    case 'themes': {
      const kws = (t.keywords || []).filter((k) => !/^(?:4k|blender|open movie|live action)$/i.test(k)).slice(0, 5);
      if (!moods.length && !kws.length) return `The catalog doesn’t describe the themes of ${name}.`;
      if (!kws.length) return `The catalog doesn’t list themes for ${name}, but its moods are ${list(moods.slice(0, 4))}.`;
      return `Going by its catalog keywords, ${name} deals with ${list(kws)}${moods.length ? `; its listed moods are ${list(moods.slice(0, 4))}` : ''}.`;
    }
    case 'cast': {
      const credits = t.credits || {};
      const directors = credits.directors?.length ? credits.directors : t.directors || [];
      const cast = credits.cast?.length ? credits.cast.map((p) => (p.role ? `${p.name} (${p.role})` : p.name)) : t.cast || [];
      const crew = (credits.crew || []).map((p) => `${p.name} (${p.job})`);
      const bits = [];
      if (directors.length) bits.push(`directed by ${list(directors)}`);
      if (cast.length) bits.push(`with ${list(cast.slice(0, 5))}`);
      if (!bits.length && crew.length) return `The catalog doesn’t list a director or cast for ${name}; its credits name ${list(crew.slice(0, 3))}.`;
      if (!bits.length) return `The catalog doesn’t list a director or cast for ${name}.`;
      return `${name} is ${bits.join(', ')}.${crew.length ? ` The credits also name ${list(crew.slice(0, 3))}.` : ''}`;
    }
    case 'cinematography': {
      const visual = (t.moods || []).filter((m) => /cinematograph|visual|colou?rful|atmospheric/.test(m)).map(humanMood);
      const facts = [t.directors?.length ? `directed by ${list(t.directors)}` : '', genres.length ? `listed as ${list(genres.slice(0, 3))}` : '', describeRuntime(t) ? `${t.type === 'series' ? 'with' : 'running'} ${describeRuntime(t)}` : ''].filter(Boolean);
      const lead = visual.length
        ? `The catalog tags ${name} for ${list(visual)}, but it doesn’t credit a cinematographer or describe the camera work in detail.`
        : `The catalog doesn’t include details about the cinematography of ${name}.`;
      return `${lead}${facts.length ? ` What it does record: it’s ${list(facts)}.` : ''}`;
    }
    case 'soundtrack': {
      const composers = musicCredits(t);
      const tag = moods.find((m) => /soundtrack|score|music/.test(m));
      let out = composers.length
        ? `The music is credited to ${list(composers)}${tag ? `, and the catalog notes a ${tag}` : ''}.`
        : tag ? `The catalog notes a ${tag} for ${name}, but doesn’t credit a composer.` : `The catalog doesn’t include soundtrack details for ${name}.`;
      if (isNoDialogue(t)) out += ' It has no dialogue, so music and sound carry it.';
      return out;
    }
    case 'pacing': {
      const len = describeRuntime(t);
      const head = len ? `${name} ${t.type === 'series' ? 'has' : 'runs'} ${len}.` : `The catalog doesn’t list a runtime for ${name}.`;
      return `${head}${moods.length ? ` Its catalog moods are ${list(moods.slice(0, 3))} — beyond that, I don’t have a scene-by-scene sense of its pacing.` : ' The catalog doesn’t describe its pacing further.'}`;
    }
    case 'runtime':
      return t.type === 'series' ? `${name} has ${describeRuntime(t) || 'no episodes listed yet'}.` : `${name} runs ${describeRuntime(t) || 'for an unlisted length'}.`;
    case 'audience': {
      const advisory = t.ratingSource === 'advisory' ? ' That’s an advisory rating assigned by Lumina, not an official certificate.' : '';
      const family = (t.moods || []).includes('family-friendly') || genres.some((g) => /family/i.test(g));
      const kidOk = Number(t.minAge ?? 18) <= 8;
      const base = `${name} is rated ${t.ageRating} (${lowerFirst(ratingLabel(t.ageRating))}).${advisory}`;
      if (kidOk) return `${family ? 'Yes — ' : ''}${base}${family ? ' The catalog also tags it as family-friendly.' : ''}`;
      return `${base}${a.ranked.length ? ' For younger viewers, these catalog titles are a better fit:' : ' The catalog has nothing similar rated for younger viewers.'}`;
    }
    case 'languages': {
      const audio = langNames(t.audioLanguages);
      if (!audio.length) return isNoDialogue(t) ? `${name} has no dialogue.` : `The catalog doesn’t list an audio language for ${name} yet; it’s confirmed when the media is checked.`;
      return audio.length === 1 && audio[0] === 'no dialogue' ? `${name} has no dialogue — just music and effects.` : `${name} has ${list(audio)} audio.`;
    }
    case 'subtitles': {
      const subs = langNames(t.subtitleLanguages);
      return subs.length ? `Subtitles for ${name} are available in ${list(subs)}.` : `No subtitle tracks are listed for ${name}.`;
    }
    case 'quality': {
      if ((t.resolutions || []).length) {
        const hdr = t.hdr ? ` in ${t.hdr}` : '';
        const audio = (t.audioFormats || []).length ? `, with ${list(t.audioFormats)} audio` : '';
        return `${name} is verified up to ${resolutionLabel(t.resolutions[0])}${hdr}${audio}.`;
      }
      return `The resolution of ${name} hasn’t been verified yet, so the player detects the available quality at playback.${mentions4k(t) ? ' Its catalog description does mention 4K.' : ''}`;
    }
    case 'release':
      if (t.releaseDate) return `${name} was released on ${fmtDate(t.releaseDate, { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })}.`;
      return t.year ? `${name} is from ${t.year}.` : `The catalog doesn’t record when ${name} was released.`;
    case 'reception':
      return t.memberRating?.count
        ? `Lumina members rate ${name} ${t.memberRating.average} out of 5 from ${t.memberRating.count} rating${t.memberRating.count === 1 ? '' : 's'}.`
        : `${name} has no member ratings yet, so I can only go by its catalog description.`;
    default: {
      const facts = [t.year, t.type === 'series' ? 'series' : 'film', describeRuntime(t), t.ageRating].filter(Boolean);
      return `${name} (${facts.join(', ')})${genres.length ? ` is listed as ${list(genres.slice(0, 3))}` : ''}.${t.synopsis ? ` ${firstSentence(t.synopsis)}` : ''}`;
    }
  }
}

// ── Comparing 2–3 titles ──
function compareRows(titles) {
  const val = {
    format: (t) => [t.type === 'series' ? 'Series' : 'Film', t.year].filter(Boolean).join(', '),
    length: (t) => describeRuntime(t) || 'Not listed',
    genres: (t) => (t.genres || []).join(', ') || 'Not listed',
    moods: (t) => (t.moods || []).slice(0, 3).map(humanMood).join(', ') || 'Not listed',
    rating: (t) => (t.memberRating?.count ? `${t.memberRating.average} / 5 (${t.memberRating.count})` : 'No member ratings yet'),
    languages: (t) => cap(list(langNames(t.audioLanguages))) || (isNoDialogue(t) ? 'No dialogue' : 'Not listed'),
    quality: (t) => ((t.resolutions || []).length ? resolutionLabel(t.resolutions[0]) : 'Detected at playback'),
    age: (t) => `${t.ageRating}${t.ratingSource === 'advisory' ? ' (advisory)' : ''}`,
  };
  const labels = { format: 'Format', length: 'Length', genres: 'Genres', moods: 'Moods', rating: 'Member rating', languages: 'Audio', quality: 'Picture quality', age: 'Age rating' };
  return Object.keys(val).map((k) => ({ key: k, label: labels[k], values: titles.map(val[k]) }));
}

function composeCompare(a) {
  const ranked = a.ranked;
  const titles = a.compare;
  const comparison = { titleIds: titles.map((t) => t.id), titles: titles.map((t) => t.title), rows: compareRows(titles) };
  const sentences = [`Here’s how ${list(titles.map((t) => t.title))} compare, using their catalog details: ${titles.map((t) => `${t.title} is ${describeBrief(t)}`).join('; ')}.`];
  const [winner, second] = ranked;
  const decisive = winner && second && winner.cmp > second.cmp;
  let clarifyingQuestion = '';
  if (a.hasPreference && decisive) {
    const why = [];
    if (winner.prefHits.includes('shorter')) why.push(`it’s the shorter of the ${titles.length === 2 ? 'two' : 'three'}, at ${minutesPhrase(winner.t.runtimeMin)}`);
    if (winner.prefHits.includes('longer')) why.push(`it’s the longer, at ${minutesPhrase(winner.t.runtimeMin)}`);
    const tagged = winner.hits.length ? winner.hits : [];
    if (tagged.length) why.push(`it’s tagged for ${list(tagged.slice(0, 2))}`);
    if (winner.prefHits.includes('quality')) why.push('its picture quality is verified');
    sentences.push(`Going by your preference, I’d choose ${winner.t.title}${why.length ? `: ${list(why)}` : ''}.`);
    const trade = ranked.slice(1).find((x) => x.hits.some((h) => !winner.hits.includes(h)));
    if (trade) sentences.push(`${trade.t.title} is the one tagged for ${list(trade.hits.filter((h) => !winner.hits.includes(h)).slice(0, 2))}, if that matters more.`);
  } else if (a.hasPreference) {
    sentences.push('On what you described they’re evenly matched, so the details below may help you choose.');
  } else {
    clarifyingQuestion = 'What matters most tonight — length, mood or picture quality?';
    sentences.push('Tell me what you’re in the mood for and I’ll pick one.');
  }
  const recs = ranked.map((x, i) => ({
    titleId: x.t.id,
    title: x.t,
    reason: i === 0 && a.hasPreference && decisive
      ? `Best fit for your preference · ${lengthShort(x.t)}`
      : [cap(list((x.t.moods || []).slice(0, 2).map(humanMood))) || cap((x.t.genres || [])[0] || ''), lengthShort(x.t)].filter(Boolean).join(' · '),
  }));
  return {
    reply: sentences.join(' '),
    recommendations: recs,
    clarifyingQuestion,
    suggestions: ['Which is shorter?', 'Which is more relaxing?', `More like ${ranked[0].t.title}`],
    comparison,
  };
}
