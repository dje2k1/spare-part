// Aides communes aux tests unitaires : stockage en mémoire, petite base déterministe, contextes.
import { emptyDb } from '../../js/core/schema.js';

export const NOW = new Date('2026-10-10T12:00:00.000Z');

/** Stockage en mémoire compatible avec l'API Storage. `limit` simule un quota (nb de caractères). */
export function memoryStorage({ limit = Infinity } = {}) {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem(k, v) {
      const size = [...m.entries()].reduce((s, [kk, vv]) => s + (kk === k ? 0 : vv.length), 0) + String(v).length;
      if (size > limit) { const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; }
      m.set(k, String(v));
    },
    removeItem: (k) => { m.delete(k); },
    get size() { return m.size; },
    keys: () => [...m.keys()],
  };
}

export const FAKE_PIN = { alg: 'PBKDF2-SHA256', salt: 'AAAAAAAAAAAAAAAAAAAAAA==', hash: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', iter: 150000, len: 4 };

export const IDS = {
  paris: 'depotparis01', lyon: 'depotlyon001',
  admin: 'useradmin001', mgrParis: 'usermgrpar01', opParis: 'useropspar01', mgrLyon: 'usermgrlyo01', opLyon: 'useropslyo01',
  locA: 'locparis0001', locB: 'locparis0002', locLyon: 'loclyon00001',
};
export const EAN = { zip: '3700089690011', button: '4006381333931', clasp: '5901234123457', ghost: '12345670' };

/** Petite base : 2 dépôts, 5 utilisateurs, 3 articles, 3 emplacements. */
export function smallDb(now = NOW) {
  const db = emptyDb(now);
  db.depots[IDS.paris] = { id: IDS.paris, name: 'Atelier Paris', location: 'Paris', code: 'DEP-01', kind: 'atelier' };
  db.depots[IDS.lyon] = { id: IDS.lyon, name: 'Atelier Lyon', location: 'Lyon', code: 'DEP-02', kind: 'atelier' };
  const user = (id, name, role, depotId) => { db.users[id] = { id, name, role, depotId, pin: { ...FAKE_PIN } }; };
  user(IDS.admin, 'Administrateur', 'admin', IDS.paris);
  user(IDS.mgrParis, 'Sophie Martin', 'manager', IDS.paris);
  user(IDS.opParis, 'Julie Laurent', 'operator', IDS.paris);
  user(IDS.mgrLyon, 'Marc Dubois', 'manager', IDS.lyon);
  user(IDS.opLyon, 'Pierre Blanc', 'operator', IDS.lyon);
  const art = (ean, name, family, price, threshold) => { db.articles[ean] = { ean, name, family, ref: '', price, threshold, photo: '', supplierId: '', supplierRef: '', pack: 1, locations: {} }; };
  art(EAN.zip, 'Zip YKK 20cm', 'Zips', 1.6, 10);
  art(EAN.button, 'Bouton doré', 'Boutons', 1.2, 5);
  art(EAN.clasp, 'Fermoir clip', 'Fermoirs', 4.2, 0);
  db.stocks[IDS.paris] = { [EAN.zip]: 20, [EAN.button]: 3, [EAN.clasp]: 0 };
  db.stocks[IDS.lyon] = { [EAN.zip]: 5, [EAN.button]: 0, [EAN.clasp]: 10 };
  db.locations[IDS.locA] = { id: IDS.locA, depotId: IDS.paris, rack: 'R1', allee: 'A1', etagere: 'E1', case: 'C1', desc: 'Zips' };
  db.locations[IDS.locB] = { id: IDS.locB, depotId: IDS.paris, rack: 'R1', allee: 'A2', etagere: 'E1', case: 'C1', desc: '' };
  db.locations[IDS.locLyon] = { id: IDS.locLyon, depotId: IDS.lyon, rack: 'R1', allee: 'A1', etagere: 'E1', case: 'C1', desc: '' };
  db.articles[EAN.zip].locations[IDS.paris] = [IDS.locA];
  return db;
}

/** Contexte d'opération pour l'utilisateur `key` (clé de IDS), dans son dépôt sauf indication. */
export function ctxFor(db, key, { depotId, now = NOW } = {}) {
  const u = db.users[IDS[key]];
  return { user: { id: u.id, name: u.name, role: u.role, depotId: u.depotId }, depotId: depotId ?? u.depotId, now };
}

/** Exécute `fn` et renvoie l'OpError levée (ou échoue si aucune). */
export function expectOpError(fn, pattern) {
  try { fn(); } catch (e) {
    if (!e.isOpError) throw e;
    if (pattern && !pattern.test(e.message)) throw new Error(`Message inattendu : « ${e.message} » (attendu ${pattern})`);
    return e;
  }
  throw new Error('OpError attendue, aucune levée');
}

/** PRNG déterministe. */
export const prng = (seed) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

/** Organisation complète : smallDb + entrepôt central (stock, 2 personnes) + 1 fournisseur. */
export const ORG = { central: 'depotcentral', karim: 'usermgrcen01', lea: 'useropscen01', ykk: 'supplierykk1' };
export function orgDb(now = NOW) {
  const db = smallDb(now);
  db.depots[ORG.central] = { id: ORG.central, name: 'Entrepôt central', location: 'Orly', code: 'CEN', kind: 'central' };
  db.stocks[ORG.central] = { [EAN.zip]: 200, [EAN.button]: 15, [EAN.clasp]: 40 };
  db.users[ORG.karim] = { id: ORG.karim, name: 'Karim Benali', role: 'manager', depotId: ORG.central, pin: { ...FAKE_PIN } };
  db.users[ORG.lea] = { id: ORG.lea, name: 'Léa Moreau', role: 'operator', depotId: ORG.central, pin: { ...FAKE_PIN } };
  db.suppliers[ORG.ykk] = { id: ORG.ykk, name: 'YKK France', email: 'adv@ykk.example', phone: '', note: '', leadDays: 10 };
  db.articles[EAN.zip].supplierId = ORG.ykk;
  db.articles[EAN.zip].pack = 10;
  IDS.karim = ORG.karim; IDS.lea = ORG.lea;
  return db;
}
