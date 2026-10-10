// Moteur de synchronisation d'un appareil (mode serveur). Aucune dépendance au navigateur : testable dans Node
// contre le vrai serveur.
//
// Principe (« exécution anticipée, confirmation par le serveur ») :
//   - la base affichée = dernier état CONFIRMÉ par le serveur + opérations EN ATTENTE rejouées par-dessus ;
//   - une opération saisie s'applique immédiatement (même hors ligne), entre dans la file d'attente persistée
//     (localStorage, écriture synchrone : rien n'est perdu si l'application est fermée), puis part au serveur ;
//   - le serveur réexécute l'opération avec les mêmes règles métier et fait foi : son delta arrive par le flux
//     temps réel ; l'appareil annule ses opérations en attente, applique le delta, puis rejoue ce qui reste ;
//   - une opération refusée par le serveur (ex. stock épuisé entre-temps par un autre site) disparaît de la
//     base affichée et est signalée à l'utilisateur, avec le motif.
// Les identifiants créés par une opération dérivent de son identifiant (seededIds) : l'appareil et le serveur
// produisent les mêmes, une commande créée hors ligne garde son numéro interne après synchronisation.
import { OPS, isOpName } from './registry.js';
import { record, applyPatch, stateHash } from './recorder.js';
import { seededIds, OpError } from './ops-kit.js';
import { KEYS } from './config.js';
import { uid } from '../lib/id.js';

export const REPLICA_LOGS = { history: 4000, audit: 1500 };
const BATCH = 100;
const MAX_CONFIRMED = 5000;
const MAX_REJECTED = 50;

export class AuthExpired extends Error {
  constructor() { super('Session serveur expirée'); this.name = 'AuthExpired'; }
}

const LABELS = {
  recordAuth: 'Connexion', undoMovement: 'Annulation de mouvement', adjustStock: 'Correction de stock', commitInventory: 'Inventaire',
  createTransfer: 'Transfert', receiveTransfer: 'Réception de transfert', cancelTransfer: 'Annulation de transfert', refuseTransfer: 'Refus de transfert',
  upsertArticle: 'Fiche pièce', deleteArticle: 'Suppression de pièce', setArticleLocation: 'Rangement', removeArticleLocation: 'Retrait d\'emplacement',
  saveLocation: 'Emplacement', deleteLocation: 'Suppression d\'emplacement', saveDepot: 'Dépôt', deleteDepot: 'Suppression de dépôt',
  saveUser: 'Compte utilisateur', deleteUser: 'Suppression de compte', changeOwnPin: 'Changement de PIN', updateSettings: 'Réglages',
  importCatalogue: 'Import du catalogue', importSuggestedParts: 'Pièces suggérées', saveSupplier: 'Fournisseur', deleteSupplier: 'Suppression de fournisseur',
  setLevels: 'Seuils', setDraftLines: 'Panier de commande', submitOrder: 'Envoi de commande', discardDraft: 'Panier vidé', cancelOrder: 'Annulation de commande',
  claimOrder: 'Prise en charge de commande', releaseOrder: 'Commande libérée', shipOrder: 'Expédition', receiveOrder: 'Réception de commande',
  savePurchaseDraft: 'Commande fournisseur', deletePurchaseDraft: 'Brouillon fournisseur supprimé', sendPurchase: 'Envoi au fournisseur',
  receivePurchase: 'Réception fournisseur', closePurchase: 'Commande fournisseur soldée',
};

/** Libellé lisible d'une opération (file d'attente, refus). */
export function describeOp(entry, db) {
  const p = entry?.params && typeof entry.params === 'object' ? entry.params : {};
  const base = entry?.name === 'moveStock' ? (p.type === 'in' ? 'Entrée' : 'Sortie') : LABELS[entry?.name] ?? 'Opération';
  const art = typeof p.ean === 'string' && db?.articles && Object.hasOwn(db.articles, p.ean) ? db.articles[p.ean].name : '';
  const qty = Number.isFinite(Number(p.qty)) && p.qty !== '' && p.qty !== undefined ? `${Number(p.qty)} × ` : '';
  return art ? `${base} · ${qty}${art}` : base;
}

/**
 * @param {object} deps
 * @param {{get:(path:string)=>Promise<{status:number,json:any}>, post:(path:string, body:any)=>Promise<{status:number,json:any}>}} deps.api
 *        rejette (Error) en cas d'erreur réseau
 * @param {Storage} deps.storage   file d'attente et refus (synchrone)
 * @param {{load:()=>Promise<any>, save:(state:object)=>Promise<void>|void}} deps.replica  copie locale de l'état confirmé
 *        (`save` doit copier l'objet de façon synchrone, comme IndexedDB)
 */
export function createSyncEngine({ api, storage, replica, now = () => new Date(), log = console, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let db = null; // base affichée (objet unique, modifié sur place)
  let v = -1; // version confirmée
  let applied = []; // opérations en attente appliquées localement, dans l'ordre, avec leur annulation
  const confirmed = new Set(); // opérations intégrées par le serveur (dédoublonnage)
  const dropped = new Set(); // opérations refusées (retirées de la file)
  let serverUser = null;
  let auth = 'none'; // 'ok' | 'expired' | 'none'
  let connected = false; // flux temps réel ouvert
  let reachable = true; // dernier échange réseau réussi
  let lastSync = null;
  let lastError = '';
  let flushing = null;
  let retryTimer = null;
  let retryDelay = 0;
  let persistTimer = null;
  let chain = Promise.resolve(); // rattrapages sérialisés
  const subs = new Set();
  const emit = (type, detail) => subs.forEach((fn) => { try { fn(type, detail); } catch (e) { log.error?.(e); } });

  // ── File d'attente persistée ──
  const readList = (key) => { try { const q = JSON.parse(storage.getItem(key)); return Array.isArray(q) ? q : []; } catch { return []; } };
  const readQueue = () => readList(KEYS.syncQueue).filter((e) => e && typeof e.opId === 'string' && isOpName(e.name) && e.user?.id);
  const writeQueue = (q) => storage.setItem(KEYS.syncQueue, JSON.stringify(q));
  const live = (q = readQueue()) => q.filter((e) => !confirmed.has(e.opId) && !dropped.has(e.opId));
  function prune() {
    const q = readQueue();
    const keep = live(q);
    if (keep.length !== q.length) { try { writeQueue(keep); } catch (e) { log.error?.('file d\'attente : écriture impossible', e); } }
  }
  function confirm(opId) {
    confirmed.add(opId);
    if (confirmed.size > MAX_CONFIRMED) confirmed.delete(confirmed.values().next().value);
  }

  // ── Base affichée = confirmée + en attente ──
  const ctxOf = (e) => ({ user: e.user, depotId: e.depotId, now: new Date(e.at), uid: seededIds(e.opId), limits: REPLICA_LOGS });
  function undoAll() {
    for (let i = applied.length - 1; i >= 0; i--) applied[i].rec.rollback();
    applied = [];
  }
  function redoAll() {
    applied = [];
    if (!db) return;
    for (const e of live()) {
      const rec = record(db);
      try {
        OPS[e.name](rec.proxy, ctxOf(e), e.params);
        applied.push({ opId: e.opId, rec });
      } catch {
        rec.rollback(); // n'aboutirait pas sur l'état actuel : sans effet local, le serveur tranchera
      }
    }
  }
  /** Modifie l'état confirmé : annule les opérations en attente, applique `fn`, rejoue la file. */
  function rebase(fn) {
    undoAll();
    try { fn?.(); } finally { prune(); redoAll(); }
  }

  // ── Copie locale de l'état confirmé (IndexedDB) ──
  function persistNow() {
    clearTimer(persistTimer);
    persistTimer = null;
    if (!db || v < 0) return;
    undoAll();
    try {
      Promise.resolve(replica.save({ v, db, ops: [...confirmed].slice(-2000), savedAt: now().toISOString() })).catch((e) => log.warn?.('copie locale non enregistrée', e));
    } finally { redoAll(); }
  }
  const persistSoon = () => { if (!persistTimer) persistTimer = setTimer(persistNow, 1500); };

  // ── Réception de l'état du serveur ──
  function loadSnapshot(snap) {
    if (!snap?.db || !Number.isInteger(snap.v)) throw new Error('Instantané du serveur invalide');
    applied = []; // l'ancienne base est abandonnée telle quelle
    db = snap.db;
    v = snap.v;
    for (const id of snap.ops ?? []) confirm(id);
    prune();
    redoAll();
    lastSync = now();
    persistNow();
    emit('changed', { reset: true });
  }

  /** Applique des événements consécutifs. @returns false s'il manque des événements (rattrapage nécessaire). */
  function applyEvents(events) {
    const fresh = (events ?? []).filter((ev) => ev.v > v).sort((a, b) => a.v - b.v);
    if (!fresh.length) return true;
    if (fresh[0].v !== v + 1 || fresh.some((ev) => ev.reset) || !db) return false;
    let complete = true;
    rebase(() => {
      for (const ev of fresh) {
        if (ev.v !== v + 1) { complete = false; break; }
        applyPatch(db, ev.patch ?? {}, { keepLog: REPLICA_LOGS });
        v = ev.v;
        if (ev.opId) confirm(ev.opId);
      }
    });
    lastSync = now();
    persistSoon();
    emit('changed', { remote: true, events: fresh });
    return complete;
  }

  async function getJson(path) {
    let r;
    try { r = await api.get(path); } catch (e) { reachable = false; status(); throw e; }
    reachable = true;
    if (r.status === 401) { setAuth('expired'); throw new AuthExpired(); }
    if (r.status !== 200) throw new Error(r.json?.error || `Erreur serveur (${r.status})`);
    return r.json;
  }

  const serial = (fn) => (chain = chain.then(fn, fn));

  /** Rattrapage : événements manqués, ou instantané complet si l'écart est trop grand. */
  function resync() {
    return serial(async () => {
      if (v < 0) { loadSnapshot(await getJson('/api/snapshot')); return; }
      const r = await getJson(`/api/events?since=${v}`);
      if (r.reset || !applyEvents(r.events)) loadSnapshot(await getJson('/api/snapshot'));
    });
  }

  /** Événement reçu par le flux temps réel. */
  function receive(ev) {
    if (!ev || !Number.isInteger(ev.v)) return;
    if (ev.reset) { serial(async () => loadSnapshot(await getJson('/api/snapshot'))).catch(() => {}); return; }
    if (ev.v <= v) return;
    if (ev.v !== v + 1 || !applyEvents([ev])) resync().catch(() => {});
  }

  // ── Envoi de la file ──
  function reject(results, batch) {
    const list = readList(KEYS.syncRejected);
    for (const r of results) {
      dropped.add(r.opId);
      const e = batch.find((x) => x.opId === r.opId);
      list.unshift({ opId: r.opId, name: e?.name, label: describeOp(e, db), message: r.message || 'Refusée par le serveur.', code: r.code, at: e?.at, by: e?.user?.name, seenAt: null });
    }
    try { storage.setItem(KEYS.syncRejected, JSON.stringify(list.slice(0, MAX_REJECTED))); } catch { /* quota : le toast reste */ }
    emit('rejected', results.map((r) => ({ ...r, label: describeOp(batch.find((x) => x.opId === r.opId), db) })));
  }

  async function sendOnce() {
    for (;;) {
      if (!serverUser || auth !== 'ok') return;
      const batch = live().filter((e) => e.user.id === serverUser).slice(0, BATCH);
      if (!batch.length) return;
      let res;
      try {
        res = await api.post('/api/ops', { userId: serverUser, since: v, ops: batch.map((e) => ({ opId: e.opId, name: e.name, params: e.params, depotId: e.depotId, at: e.at })) });
      } catch (e) { reachable = false; throw e; }
      reachable = true;
      if (res.status === 401) { setAuth('expired'); return; }
      if (res.status === 409) { await checkSession(); return; }
      if (res.status !== 200) throw new Error(res.json?.error || `Erreur serveur (${res.status})`);
      const rejected = [];
      for (const r of res.json.results ?? []) {
        if (r.status === 'ok' || r.status === 'duplicate') confirm(r.opId);
        else if (r.status === 'rejected') rejected.push(r);
      }
      if (rejected.length) reject(rejected, batch);
      if (res.json.reset || !applyEvents(res.json.events)) await resync();
      else if (rejected.length || res.json.results?.some((r) => r.status === 'duplicate')) { rebase(); emit('changed', { remote: true }); }
      lastError = '';
    }
  }

  /** Envoie les opérations en attente du compte connecté. Nouvelle tentative automatique en cas d'échec réseau. */
  function flush() {
    if (flushing) return flushing;
    clearTimer(retryTimer);
    retryTimer = null;
    flushing = sendOnce()
      .then(() => { retryDelay = 0; })
      .catch((e) => {
        lastError = e?.message || String(e);
        retryDelay = Math.min(60_000, retryDelay ? retryDelay * 2 : 2000);
        retryTimer = setTimer(() => { retryTimer = null; flush(); }, retryDelay);
      })
      .finally(() => { flushing = null; status(); });
    return flushing;
  }

  let kickTimer = null;
  /** Envoi groupé juste après une saisie (une rafale de scans part en une requête). */
  const kick = () => { if (!kickTimer) kickTimer = setTimer(() => { kickTimer = null; flush(); }, 60); };

  async function checkSession() {
    const r = await api.get('/api/session').catch(() => null);
    if (!r) return null;
    if (r.status === 200) { serverUser = r.json.user.id; setAuth('ok'); return r.json; }
    if (r.status === 401) setAuth('expired');
    return null;
  }

  function setAuth(next) {
    if (auth === next) return;
    auth = next;
    emit('auth', next);
    status();
  }

  function status() {
    const q = live();
    const mine = q.filter((e) => e.user.id === serverUser).length;
    const others = [...new Set(q.filter((e) => e.user.id !== serverUser).map((e) => e.user.name))];
    const s = { v, connected, reachable, auth, pending: q.length, mine, others, rejected: readList(KEYS.syncRejected), lastSync, lastError };
    emit('status', s);
    return s;
  }

  return {
    get db() { return db; },
    get version() { return v; },
    get serverUser() { return serverUser; },

    /** Charge la copie locale (démarrage, y compris hors ligne). @returns true si des données sont disponibles. */
    async init() {
      const saved = await Promise.resolve(replica.load()).catch(() => null);
      if (saved?.db && Number.isInteger(saved.v)) {
        db = saved.db;
        v = saved.v;
        for (const id of saved.ops ?? []) confirm(id);
        prune();
        redoAll();
      }
      return Boolean(db);
    },

    /** Exécute une opération pour l'utilisateur de `ctx` : effet immédiat, envoi au serveur dès que possible. */
    submit(name, params, ctx) {
      if (!db) throw new OpError('Données pas encore chargées : patientez quelques secondes.');
      if (!isOpName(name)) throw new Error(`Opération inconnue : ${name}`);
      const e = {
        opId: uid(), name, params: params === undefined ? null : JSON.parse(JSON.stringify(params)),
        depotId: ctx.depotId, at: (ctx.now ?? now()).toISOString(),
        user: { id: ctx.user.id, name: ctx.user.name, role: ctx.user.role, depotId: ctx.user.depotId },
      };
      const rec = record(db);
      let result;
      try { result = OPS[name](rec.proxy, ctxOf(e), e.params); } catch (err) { rec.rollback(); throw err; }
      try { writeQueue([...readQueue(), e]); } catch {
        rec.rollback();
        throw new OpError('Mémoire de l\'appareil pleine : opération non enregistrée. Reconnectez-vous au réseau pour libérer la file d\'attente.');
      }
      applied.push({ opId: e.opId, rec });
      emit('changed', { local: true });
      status();
      kick();
      return result === undefined ? undefined : JSON.parse(JSON.stringify(result));
    },

    resync, receive, flush, checkSession, loadSnapshot, applyEvents,

    /** Contrôle d'intégrité : l'état confirmé de l'appareil est-il identique à celui du serveur ? */
    async verify() {
      const r = await getJson('/api/state');
      if (r.v !== v || !db) return null; // état en mouvement : contrôle reporté
      undoAll();
      let h;
      try { h = stateHash(db); } finally { redoAll(); }
      if (h === r.hash) return true;
      log.warn?.('Divergence détectée avec le serveur : rechargement complet');
      await serial(async () => loadSnapshot(await getJson('/api/snapshot')));
      return false;
    },

    /** Compte de la session serveur (les opérations des autres comptes attendent leur reconnexion). */
    setSession(userId) { serverUser = userId; setAuth(userId ? 'ok' : 'none'); if (userId) kick(); },
    clearSession() { serverUser = null; setAuth('none'); },
    setConnected(on) { connected = Boolean(on); if (on) reachable = true; status(); },
    /** La file a été modifiée par un autre onglet. */
    queueChanged() { if (db) { rebase(); emit('changed', { local: true }); status(); } },

    status,
    pending: () => live(),
    describe: (e) => describeOp(e, db),
    /** Refus vus par l'utilisateur. */
    acknowledgeRejected() { try { storage.removeItem(KEYS.syncRejected); } catch { /* ignoré */ } status(); },
    persist: persistNow,
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    /** Arrêt (tests) : minuteries annulées. */
    stop() { clearTimer(retryTimer); clearTimer(persistTimer); clearTimer(kickTimer); retryTimer = persistTimer = kickTimer = null; },
  };
}
