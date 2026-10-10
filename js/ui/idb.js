// Copie locale de l'état confirmé par le serveur (IndexedDB : plusieurs dizaines de Mo possibles, contre
// ~5 Mo pour localStorage). Elle permet de démarrer et de travailler hors ligne.
const NAME = 'mode-stock';
const STORE = 'replica';
const KEY = 'main';

let handle = null; // connexion ouverte (permet une écriture synchrone, voir save)
let opening = null;

function open() {
  opening ??= new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error('IndexedDB indisponible')); return; }
    const req = indexedDB.open(NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => {
      handle = req.result;
      handle.onversionchange = () => { handle.close(); handle = null; opening = null; };
      resolve(handle);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB bloquée par un autre onglet'));
  }).catch((e) => { opening = null; throw e; });
  return opening;
}

function put(db, value) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, 'readwrite');
    if (value === undefined) t.objectStore(STORE).delete(KEY); else t.objectStore(STORE).put(value, KEY);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Écriture annulée'));
  });
}

/** Adaptateur attendu par le moteur de synchronisation. */
export const idbReplica = {
  async load() {
    try {
      const db = await open();
      return await new Promise((resolve, reject) => {
        const r = db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY);
        r.onsuccess = () => resolve(r.result ?? null);
        r.onerror = () => reject(r.error);
      });
    } catch { return null; }
  },
  /**
   * La valeur est copiée PENDANT l'appel (put copie l'objet de façon synchrone) : le moteur peut la modifier
   * dès le retour. Sans connexion ouverte, une copie est faite avant l'ouverture.
   */
  save(state) {
    if (handle) return put(handle, state);
    const copy = structuredClone(state);
    return open().then((db) => put(db, copy));
  },
  clear: () => open().then((db) => put(db, undefined)).catch(() => {}),
};
