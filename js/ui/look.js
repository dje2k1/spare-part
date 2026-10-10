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

/** Émail de chaque famille (= barre du haut) : barre d'état du téléphone (meta theme-color). Voir css/tokens.css. */
const TOP = {
  brand: '#1b3d93', indigo: '#1b3d93', blue: '#0b5cad', teal: '#0b6b74', green: '#0d6b4c',
  amber: '#f3b41b', red: '#c7361f', violet: '#6a2d8f', slate: '#2b3555', rose: '#b52a63',
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

/** Couleur de ligne d'un dépôt : l'entrepôt central porte le bleu émail (hue-0), chaque atelier une autre teinte stable. */
export function depotHue(d) {
  if (d?.kind === 'central') return 'hue-0';
  const h = hueClass(d?.name);
  return h === 'hue-0' ? 'hue-1' : h;
}
