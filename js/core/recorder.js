// Enregistreur de modifications : exécute une opération métier en notant précisément ce qu'elle change.
//
// - `patch()`    : le delta à diffuser aux autres appareils (entités modifiées, journaux ajoutés).
//                  Les appareils appliquent ce delta tel quel : aucune règle métier n'est rejouée chez eux,
//                  donc pas de divergence possible entre versions de l'application.
// - `rollback()` : restaure exactement l'état d'avant (serveur : une opération qui échoue à mi-chemin
//                  ne laisse jamais une base à moitié modifiée).
//
// Structure suivie (schéma v6) :
//   tables à 1 niveau : depots, users, articles, locations, suppliers, orders, transfers → [table][id]
//   tables à 2 niveaux : stocks, levels, usage → [table][dépôt][ean]
//   journaux : history, audit (ajouts en tête, entrées existantes modifiées)
//   meta : objet entier
const MAP1 = new Set(['depots', 'users', 'articles', 'locations', 'suppliers', 'orders', 'transfers']);
const MAP2 = new Set(['stocks', 'levels', 'usage']);
const LOGS = new Set(['history', 'audit']);
const ALL = 'ALL';

const isObject = (v) => v !== null && typeof v === 'object';
const clone = (v) => (v === undefined ? undefined : structuredClone(v));

export function record(db) {
  const toTarget = new WeakMap(); // proxy → objet réel
  const cache = new WeakMap(); // objet réel → proxy
  const undo = []; // fonctions de restauration, dans l'ordre des premières écritures
  const seen = new Set();
  const dirty1 = new Map(); // table → Set(id)
  const dirty2 = new Map(); // table → Map(dépôt → Set(ean) | ALL)
  let metaDirty = false;
  const logs = { history: { pre: 0, mod: new Set() }, audit: { pre: 0, mod: new Set() } };

  /** Remplace récursivement les proxys par les objets réels (avant tout stockage dans la base). */
  function unwrap(v) {
    if (!isObject(v)) return v;
    const t = toTarget.get(v);
    if (t) return t;
    if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) v[i] = unwrap(v[i]); return v; }
    for (const k of Object.keys(v)) v[k] = unwrap(v[k]);
    return v;
  }

  function once(key, fn) {
    if (seen.has(key)) return;
    seen.add(key);
    undo.push(fn());
  }

  /** Proxy profond : toute écriture, à n'importe quelle profondeur, appelle `onWrite` AVANT d'être faite. */
  function deep(target, onWrite) {
    const hit = cache.get(target);
    if (hit) return hit;
    const p = new Proxy(target, {
      get(t, k, r) { const v = Reflect.get(t, k, r); return isObject(v) && typeof k !== 'symbol' ? deep(v, onWrite) : v; },
      set(t, k, v) { onWrite(); t[k] = unwrap(v); return true; },
      deleteProperty(t, k) { onWrite(); delete t[k]; return true; },
      defineProperty(t, k, d) { onWrite(); return Reflect.defineProperty(t, k, { ...d, value: unwrap(d.value) }); },
    });
    cache.set(target, p);
    toTarget.set(p, target);
    return p;
  }

  // ── Tables à 1 niveau ──
  function touch1(table, id) {
    once(`1\u0000${table}\u0000${id}`, () => {
      const had = Object.hasOwn(db[table], id);
      const orig = had ? clone(db[table][id]) : undefined;
      return () => { if (had) db[table][id] = orig; else delete db[table][id]; };
    });
    if (!dirty1.has(table)) dirty1.set(table, new Set());
    dirty1.get(table).add(id);
  }
  const map1 = (table) => new Proxy(db[table], {
    get(t, id, r) {
      const v = Reflect.get(t, id, r);
      return isObject(v) && typeof id === 'string' && Object.hasOwn(t, id) ? deep(v, () => touch1(table, id)) : v;
    },
    set(t, id, v) { touch1(table, id); t[id] = unwrap(v); return true; },
    deleteProperty(t, id) { touch1(table, id); delete t[id]; return true; },
  });

  // ── Tables à 2 niveaux ──
  function mark2(table, k1, k2) {
    if (!dirty2.has(table)) dirty2.set(table, new Map());
    const m = dirty2.get(table);
    if (k2 === ALL) m.set(k1, ALL);
    else if (m.get(k1) !== ALL) { if (!m.has(k1)) m.set(k1, new Set()); m.get(k1).add(k2); }
  }
  function touch2(table, k1, k2) {
    if (k2 === ALL) {
      once(`2\u0000${table}\u0000${k1}`, () => {
        const had = Object.hasOwn(db[table], k1);
        const orig = had ? clone(db[table][k1]) : undefined;
        return () => { if (had) db[table][k1] = orig; else delete db[table][k1]; };
      });
    } else {
      once(`2\u0000${table}\u0000${k1}\u0000${k2}`, () => {
        const inner = db[table][k1];
        const had = Object.hasOwn(inner, k2);
        const orig = had ? clone(inner[k2]) : undefined;
        return () => {
          const cur = db[table][k1] ?? (db[table][k1] = {});
          if (had) cur[k2] = orig; else delete cur[k2];
        };
      });
    }
    mark2(table, k1, k2);
  }
  const inner2 = (table, k1, target) => {
    const hit = cache.get(target);
    if (hit) return hit;
    const p = new Proxy(target, {
      get(t, k2, r) {
        const v = Reflect.get(t, k2, r);
        return isObject(v) && typeof k2 === 'string' && Object.hasOwn(t, k2) ? deep(v, () => touch2(table, k1, k2)) : v;
      },
      set(t, k2, v) { touch2(table, k1, k2); t[k2] = unwrap(v); return true; },
      deleteProperty(t, k2) { touch2(table, k1, k2); delete t[k2]; return true; },
    });
    cache.set(target, p);
    toTarget.set(p, target);
    return p;
  };
  const map2 = (table) => new Proxy(db[table], {
    get(t, k1, r) {
      const v = Reflect.get(t, k1, r);
      return isObject(v) && typeof k1 === 'string' && Object.hasOwn(t, k1) ? inner2(table, k1, v) : v;
    },
    set(t, k1, v) { touch2(table, k1, ALL); t[k1] = unwrap(v); return true; },
    deleteProperty(t, k1) { touch2(table, k1, ALL); delete t[k1]; return true; },
  });

  // ── Journaux (ajouts en tête uniquement ; troncature tolérée) ──
  const logProxy = (name) => {
    const arr = db[name];
    const st = logs[name];
    const entryProxy = (entry) => deep(entry, () => {
      once(`L\u0000${name}\u0000${entry.id}`, () => {
        const orig = clone(entry);
        return () => { const i = arr.findIndex((e) => e.id === orig.id); if (i >= 0) arr[i] = orig; };
      });
      st.mod.add(entry.id);
    });
    return new Proxy(arr, {
      get(t, k, r) {
        if (k === 'unshift') {
          return (...items) => {
            const n = items.length;
            st.pre += n;
            undo.push(() => { arr.splice(0, n); });
            return t.unshift(...items.map(unwrap));
          };
        }
        if (k === 'push' || k === 'splice' || k === 'sort' || k === 'reverse' || k === 'shift' || k === 'pop' || k === 'fill' || k === 'copyWithin') {
          throw new Error(`Journal ${name} : seule l'insertion en tête est autorisée (${String(k)}).`);
        }
        const v = Reflect.get(t, k, r);
        return isObject(v) && typeof k === 'string' && /^\d+$/.test(k) ? entryProxy(v) : v;
      },
      set(t, k, v) {
        if (k === 'length') {
          if (v < t.length) {
            const removed = t.slice(v);
            st.pre = Math.min(st.pre, v);
            undo.push(() => { arr.push(...removed); });
          }
          t.length = v;
          return true;
        }
        throw new Error(`Journal ${name} : écriture directe interdite.`);
      },
      deleteProperty() { throw new Error(`Journal ${name} : suppression interdite.`); },
    });
  };

  const metaProxy = () => deep(db.meta, () => {
    once('M', () => { const orig = clone(db.meta); return () => { db.meta = orig; }; });
    metaDirty = true;
  });

  const views = {};
  const proxy = new Proxy(db, {
    get(t, k) {
      if (typeof k !== 'string') return t[k];
      if (k in views) return views[k];
      if (MAP1.has(k)) return (views[k] = map1(k));
      if (MAP2.has(k)) return (views[k] = map2(k));
      if (LOGS.has(k)) return (views[k] = logProxy(k));
      if (k === 'meta') return (views[k] = metaProxy());
      return t[k];
    },
    set(t, k) { throw new Error(`Base : la propriété « ${String(k)} » ne peut pas être remplacée par une opération.`); },
    deleteProperty(t, k) { throw new Error(`Base : la propriété « ${String(k)} » ne peut pas être supprimée.`); },
  });

  return {
    proxy,
    /** Delta de l'opération (valeurs copiées : indépendant des modifications ultérieures de la base). */
    patch() {
      const e = [];
      for (const [table, ids] of dirty1) for (const id of ids) e.push([table, id, Object.hasOwn(db[table], id) ? clone(db[table][id]) : null]);
      const e2 = [];
      for (const [table, m] of dirty2) {
        for (const [k1, keys] of m) {
          const inner = Object.hasOwn(db[table], k1) ? db[table][k1] : undefined;
          if (keys === ALL) { e2.push([table, k1, null, inner === undefined ? null : clone(inner)]); continue; }
          for (const k2 of keys) e2.push([table, k1, k2, inner && Object.hasOwn(inner, k2) ? clone(inner[k2]) : null]);
        }
      }
      const out = { e, e2 };
      if (metaDirty) out.meta = clone(db.meta);
      for (const name of LOGS) {
        const st = logs[name];
        const pre = db[name].slice(0, st.pre).map(clone);
        const preIds = new Set(pre.map((x) => x.id));
        const mod = [...st.mod].filter((id) => !preIds.has(id)).map((id) => db[name].find((x) => x.id === id)).filter(Boolean).map(clone);
        if (pre.length || mod.length) (out.log ??= {})[name] = { pre, mod };
      }
      return out;
    },
    rollback() {
      for (let i = undo.length - 1; i >= 0; i--) undo[i]();
      undo.length = 0;
    },
    get changed() { return dirty1.size > 0 || dirty2.size > 0 || metaDirty || logs.history.pre > 0 || logs.audit.pre > 0 || logs.history.mod.size > 0 || logs.audit.mod.size > 0; },
  };
}

/** Exécute `fn(proxy)` de façon transactionnelle. @returns {{result, patch}} ; en cas d'erreur, la base est intacte. */
export function runRecorded(db, fn) {
  const rec = record(db);
  try {
    const result = fn(rec.proxy);
    return { result: result === undefined ? undefined : JSON.parse(JSON.stringify(result)), patch: rec.patch() };
  } catch (err) {
    rec.rollback();
    throw err;
  }
}

/** Applique un delta à une copie de la base (appareil). `keepLog` : élagage local des journaux. */
export function applyPatch(db, patch, { keepLog = null } = {}) {
  for (const [table, id, value] of patch.e ?? []) {
    if (!MAP1.has(table) || typeof id !== 'string') continue;
    if (value === null) delete db[table][id]; else db[table][id] = clone(value);
  }
  for (const [table, k1, k2, value] of patch.e2 ?? []) {
    if (!MAP2.has(table) || typeof k1 !== 'string') continue;
    if (k2 === null) {
      if (value === null) delete db[table][k1]; else db[table][k1] = clone(value);
    } else {
      if (value === null) { if (db[table][k1]) delete db[table][k1][k2]; continue; }
      (db[table][k1] ??= {})[k2] = clone(value);
    }
  }
  if (patch.meta) db.meta = { ...clone(patch.meta), rev: db.meta?.rev ?? 0, lastBackupAt: db.meta?.lastBackupAt ?? null, lastBackupRev: db.meta?.lastBackupRev ?? 0 };
  for (const name of LOGS) {
    const l = patch.log?.[name];
    if (!l) continue;
    const arr = db[name];
    for (const m of l.mod ?? []) { const i = arr.findIndex((x) => x.id === m.id); if (i >= 0) arr[i] = clone(m); }
    const known = new Set(arr.slice(0, 50).map((x) => x.id));
    const fresh = (l.pre ?? []).filter((x) => !known.has(x.id)).map(clone);
    if (fresh.length) arr.unshift(...fresh);
    if (keepLog?.[name] && arr.length > keepLog[name]) arr.length = keepLog[name];
  }
  return db;
}

/** Copie diffusable : sans empreintes de PIN (un appareil ne doit pas pouvoir les attaquer hors ligne). */
export function publicUser(u) {
  if (!u) return u;
  return { ...u, pin: null, ...(u.pin?.len ? { pinLen: u.pin.len } : {}) };
}

export function publicPatch(patch) {
  if (!patch.e?.some(([t]) => t === 'users')) return patch;
  return { ...patch, e: patch.e.map(([t, id, v]) => (t === 'users' && v ? [t, id, publicUser(v)] : [t, id, v])) };
}

export function publicDb(db) {
  const out = structuredClone(db);
  for (const id of Object.keys(out.users)) out.users[id] = publicUser(out.users[id]);
  return out;
}

// ── Empreinte d'état (détection de divergence entre un appareil et le serveur) ──
const LOCAL_META = new Set(['rev', 'lastBackupAt', 'lastBackupRev']);
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (isObject(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}
/**
 * Empreinte des données de référence et des stocks (les journaux, élagués différemment sur chaque appareil,
 * et les compteurs locaux en sont exclus ; les PIN aussi).
 */
export function stateHash(db) {
  const meta = Object.fromEntries(Object.entries(db.meta).filter(([k]) => !LOCAL_META.has(k)));
  const users = Object.fromEntries(Object.entries(db.users).map(([id, u]) => [id, { ...u, pin: null, pinLen: undefined }]));
  const core = { ...db, history: undefined, audit: undefined, v: undefined, meta, users };
  const s = stable(core);
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 ^ c, 2246822519) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}
