// Identité visuelle par section : famille de teintes (css/tokens.css) et pictogramme d'en-tête.
// La famille de la section courante est posée sur <body data-accent> : barre du haut, en-tête de page,
// boutons principaux, liens et focus en prennent la couleur ; la barre d'état du téléphone aussi.

/** [famille, pictogramme] par route. */
const LOOK = {
  home: ['brand', 'home'],
  scan: ['green', 'scan'],
  articles: ['indigo', 'box'],
  reorder: ['red', 'list'],
  plan: ['teal', 'map'],
  transfers: ['blue', 'swap'],
  journal: ['slate', 'clock'],
  photo: ['rose', 'sparkles'],
  inventory: ['amber', 'clipboard'],
  dashboard: ['indigo', 'chart'],
  admin: ['slate', 'settings'],
  orders: ['blue', 'truck'],
  order: ['amber', 'cart'],
  receive: ['green', 'inbox'],
  preceive: ['green', 'inbox'],
  pick: ['blue', 'box'],
  purchases: ['amber', 'cart'],
  purchase: ['amber', 'file'],
  suppliers: ['amber', 'store'],
  levels: ['violet', 'sliders'],
  labels: ['teal', 'tag'],
  reports: ['violet', 'file'],
};

/** Mode du scan → famille (entrée verte, sortie rouge, transfert bleu, consultation indigo). */
export const SCAN_FAMILY = { in: 'green', out: 'red', transfer: 'blue', find: 'indigo' };

/** Couleur « profonde » de chaque famille : barre d'état du téléphone (meta theme-color). */
const TOP = {
  brand: '#241336', indigo: '#1b1a4a', blue: '#0b2554', teal: '#042f2e', green: '#052e1f',
  amber: '#3a1d04', red: '#4c0519', violet: '#2e1065', slate: '#0f172a', rose: '#500724',
};

let currentName = 'home';

/** Section en cours de rendu (posée par le routeur juste avant le rendu de l'écran). */
export function enterSection(name, rest = []) {
  currentName = name;
  const [family] = LOOK[name] ?? LOOK.home;
  setAccent(name === 'scan' ? SCAN_FAMILY[rest[0]] ?? family : family);
}

/** Famille de couleurs d'une route (icônes du menu, liens). */
export const familyOf = (name) => (LOOK[name] ?? LOOK.home)[0];

/** Pictogramme d'en-tête de la section courante. */
export const sectionIcon = () => (LOOK[currentName] ?? LOOK.home)[1];

/** Change la famille de couleurs affichée (ex. changement de mode dans le scan). */
export function setAccent(family) {
  const f = TOP[family] ? family : 'brand';
  if (document.body.dataset.accent !== f) document.body.dataset.accent = f;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = TOP[f];
}

/** Teinte stable (0-9) pour un monogramme ou un avatar, à partir d'un texte (nom, famille…). */
export function hueClass(text) {
  let h = 7;
  for (const ch of String(text ?? '')) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return `hue-${h % 10}`;
}
