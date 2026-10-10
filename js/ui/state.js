// État partagé de l'interface : stockage, session, préférences. (L'état métier vit dans le store.)
import { createStore } from '../core/store.js';
import { createLockout, can as canRole } from '../core/auth.js';
import { KEYS } from '../core/config.js';

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

/** @type {{session: null|{user:{id:string,name:string,role:string,depotId:string}, depotId:string, loginAt:number}, online:boolean}} */
export const state = { session: null, online: typeof navigator === 'undefined' ? true : navigator.onLine };

export const db = () => store.db;
export const depot = () => store.db.depots[state.session.depotId];
export const can = (permission) => Boolean(state.session) && canRole(state.session.user.role, permission);

/** Contexte passé aux opérations métier. */
export const ctx = () => ({ user: { ...state.session.user }, depotId: state.session.depotId, now: new Date() });

/** Exécute une opération métier de façon transactionnelle pour l'utilisateur courant. */
export const run = (op, params) => store.run((d) => op(d, ctx(), params));

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
