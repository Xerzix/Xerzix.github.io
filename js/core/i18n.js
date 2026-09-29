// Interface language. English is complete; Japanese and Spanish cover navigation and
// shared interface strings (other text falls back to English). Call t(key, fallback, vars).
const DICTS = {
  ja: {
    'nav.home': 'ホーム', 'nav.movies': '映画', 'nav.tv': 'TV番組', 'nav.genres': 'ジャンル', 'nav.new': '新作',
    'nav.trending': '話題作', 'nav.mylist': 'マイリスト', 'nav.velvia': 'Velvia おすすめ', 'nav.search': '検索',
    'nav.notifications': '通知', 'nav.settings': '設定', 'nav.profiles': 'プロフィール', 'nav.account': 'アカウント',
    'nav.signin': 'ログイン', 'nav.signout': 'ログアウト', 'nav.creators': 'クリエイター', 'nav.discover': '発見',
    'nav.browse': 'ブラウズ', 'nav.admin': '管理', 'nav.manageProfiles': 'プロフィールの管理', 'nav.stats': '視聴統計',
    'action.play': '再生', 'action.resume': '続きから再生', 'action.moreInfo': '詳細情報', 'action.addList': 'マイリストに追加',
    'search.placeholder': 'タイトル、人物、ジャンル', 'footer.legal': '法的情報', 'common.seeAll': 'すべて表示',
  },
  es: {
    'nav.home': 'Inicio', 'nav.movies': 'Películas', 'nav.tv': 'Series', 'nav.genres': 'Géneros', 'nav.new': 'Novedades',
    'nav.trending': 'Tendencias', 'nav.mylist': 'Mi lista', 'nav.velvia': 'Sugerencias Velvia', 'nav.search': 'Buscar',
    'nav.notifications': 'Notificaciones', 'nav.settings': 'Ajustes', 'nav.profiles': 'Perfiles', 'nav.account': 'Cuenta',
    'nav.signin': 'Iniciar sesión', 'nav.signout': 'Cerrar sesión', 'nav.creators': 'Creadores', 'nav.discover': 'Descubrir',
    'nav.browse': 'Explorar', 'nav.admin': 'Administración', 'nav.manageProfiles': 'Administrar perfiles', 'nav.stats': 'Estadísticas',
    'action.play': 'Reproducir', 'action.resume': 'Reanudar', 'action.moreInfo': 'Más información', 'action.addList': 'Añadir a Mi lista',
    'search.placeholder': 'Títulos, personas, géneros', 'footer.legal': 'Legal', 'common.seeAll': 'Ver todo',
  },
};

export const INTERFACE_LANGUAGES = [
  { code: 'en', name: 'English', coverage: 'Complete' },
  { code: 'ja', name: '日本語 (Japanese)', coverage: 'Navigation and common controls' },
  { code: 'es', name: 'Español (Spanish)', coverage: 'Navigation and common controls' },
];

let lang = 'en';

export function setLanguage(code) {
  lang = DICTS[code] || code === 'en' ? code : 'en';
  document.documentElement.lang = lang;
}

export const currentLanguage = () => lang;

export function t(key, fallback = key, vars) {
  let s = DICTS[lang]?.[key] ?? fallback;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}
