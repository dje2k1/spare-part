// État partagé de l'interface : stockage, session, préférences. (L'état métier vit dans le store.)
import { createStore } from '../core/store.js';
import { createLockout, can as canRole } from '../core/auth.js';
import { KEYS } from '../core/config.js';
import { OPS, opName } from '../core/registry.js';

/** localStorage si disponible, sinon mémoire (navigation privée stricte) — l'application reste utilisable. */
function pickStorage() {
  try {
    const k = '__mode_probe__';
    localStorage.setItem(k, '1'); localStorage.removeItem(k);
    return localStorage;
  } catch {
    const m = new Map();
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, volatile: true };
  }
}

export const storage = pickStorage();
export const store = createStore({ storage });
export const lockout = createLockout({ storage, key: KEYS.lock });

/**
 * @type {{session: null|{user:{id:string,name:string,role:string,depotId:string}, depotId:string, loginAt:number},
 *         online:boolean, serverMode:boolean}}
 * `serverMode` : l'application est servie par le serveur de synchronisation (sinon : autonome, données locales).
 */
export const state = { session: null, online: typeof navigator === 'undefined' ? true : navigator.onLine, serverMode: false };

export const db = () => store.db;
export const depot = () => store.db.depots[state.session.depotId];
export const can = (permission) => Boolean(state.session) && canRole(state.session.user.role, permission);

/** Contexte passé aux opérations métier. */
export const ctx = () => ({ user: { ...state.session.user }, depotId: state.session.depotId, now: new Date() });

// Mode serveur : un moteur de synchronisation prend en charge l'exécution (anticipée sur l'appareil,
// puis confirmée par le serveur). Sans serveur : exécution locale transactionnelle.
let engine = null;
export const setEngine = (e) => { engine = e; };
export const syncEngine = () => engine;

/**
 * Exécute une opération métier (fonction du registre, voir core/registry.js) pour l'utilisateur courant.
 * Le résultat est disponible immédiatement, y compris hors ligne en mode serveur.
 */
export function run(op, params) {
  const name = opName(op);
  if (engine) return engine.submit(name, params, ctx());
  return store.run((d) => OPS[name](d, ctx(), params));
}

/** Simulation sans rien enregistrer (aperçu d'un import, contrôle avant validation). */
export function preview(op, params) {
  return OPS[opName(op)](structuredClone(store.db), ctx(), params);
}

// ── Préférences d'appareil (thème, son, dernier dépôt…) ──
const readPrefs = () => { try { return JSON.parse(storage.getItem(KEYS.prefs)) || {}; } catch { return {}; } };
export const prefs = {
  get: (key, fallback) => readPrefs()[key] ?? fallback,
  set(key, value) {
    const p = readPrefs();
    p[key] = value;
    try { storage.setItem(KEYS.prefs, JSON.stringify(p)); } catch { /* quota : préférence non conservée */ }
  },
};

export function applyTheme(theme = prefs.get('theme', 'auto')) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme; else delete root.dataset.theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  const dark = theme === 'dark' || (theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  if (meta) meta.content = dark ? '#0f0f0e' : '#111111';
}
