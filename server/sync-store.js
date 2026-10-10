// Cœur du serveur : la base qui FAIT FOI, son journal d'événements et la diffusion aux appareils.
//
// Chaque opération reçue est exécutée avec les MÊMES règles métier que sur les appareils (js/core/ops*.js),
// de façon transactionnelle (recorder.js : retour arrière total en cas d'erreur), avec l'identité de
// l'utilisateur connue du serveur (jamais celle annoncée par l'appareil). Le delta produit est :
//   1. écrit et synchronisé sur disque (events.jsonl, fsync) AVANT de répondre ;
//   2. diffusé aux appareils connectés (sans empreintes de PIN).
// Un instantané complet (snapshot.json, écriture atomique) est pris régulièrement ; au redémarrage :
// instantané + rejeu du journal. Une ligne de journal tronquée (coupure de courant) est ignorée.
import { readFileSync, writeFileSync, existsSync, mkdirSync, openSync, writeSync, fsyncSync, closeSync, renameSync, appendFileSync, ftruncateSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeDb } from '../js/core/schema.js';
import { runRecorded, applyPatch, publicPatch, publicDb, stateHash } from '../js/core/recorder.js';
import { OPS, isOpName } from '../js/core/registry.js';
import { seededIds } from '../js/core/ops-kit.js';
import { isUid, uid } from '../js/lib/id.js';

const DAY = 86_400_000;
export const MAX_OP_AGE_DAYS = 14;
export const REPLICA_LOGS = { history: 4000, audit: 1500 }; // journaux envoyés à un appareil (instantané)

export function createSyncStore({ dataDir, now = () => new Date(), snapshotEvery = 500, keepEvents = 5000, keepOpIds = 50_000, historyMax = 200_000, auditMax = 100_000, log = console }) {
  mkdirSync(dataDir, { recursive: true });
  const files = { snapshot: join(dataDir, 'snapshot.json'), events: join(dataDir, 'events.jsonl'), archive: join(dataDir, 'archive-history.jsonl') };
  let db = null;
  let v = 0;
  let sinceSnapshot = 0;
  let eventsFd = null;
  const recent = new Map(); // opId → v (détection des doublons : un appareil renvoie après une coupure réseau)
  const ring = []; // derniers événements publics (rattrapage des appareils reconnectés)
  const subs = new Set();
  let hashCache = { v: -1, h: '' };
  /** Empreinte de l'état (calculée une fois par version). */
  function hash() {
    if (hashCache.v !== v) hashCache = { v, h: stateHash(db) };
    return hashCache.h;
  }

  const remember = (opId, ver) => {
    recent.set(opId, ver);
    if (recent.size > keepOpIds) recent.delete(recent.keys().next().value);
  };
  const pushRing = (ev) => {
    ring.push(ev);
    if (ring.length > keepEvents) ring.splice(0, ring.length - keepEvents);
  };
  const emit = (ev) => subs.forEach((fn) => { try { fn(ev); } catch (e) { log.error?.('diffusion', e); } });

  function openEvents() {
    eventsFd ??= openSync(files.events, 'a');
    return eventsFd;
  }

  function writeSnapshot() {
    const tmp = `${files.snapshot}.tmp`;
    const fd = openSync(tmp, 'w');
    writeSync(fd, JSON.stringify({ format: 'mode-stock-server', v, savedAt: now().toISOString(), ops: [...recent.entries()].slice(-keepOpIds), db }));
    fsyncSync(fd);
    closeSync(fd);
    renameSync(tmp, files.snapshot);
    // Le journal est désormais couvert par l'instantané : on repart d'un journal vide
    const fdE = openEvents();
    ftruncateSync(fdE, 0);
    fsyncSync(fdE);
    sinceSnapshot = 0;
  }

  /** Élagage serveur des journaux (hors opérations, non diffusé) : l'excédent part en archive. */
  function trimLogs() {
    if (db.history.length > historyMax) {
      const removed = db.history.splice(historyMax);
      appendFileSync(files.archive, removed.map((h) => JSON.stringify(h)).join('\n') + '\n');
    }
    if (db.audit.length > auditMax) db.audit.length = auditMax;
  }

  function load() {
    if (!existsSync(files.snapshot)) return false;
    const snap = JSON.parse(readFileSync(files.snapshot, 'utf8'));
    if (snap?.format !== 'mode-stock-server' || !snap.db) throw new Error('snapshot.json illisible');
    db = normalizeDb(snap.db, now(), { limits: { history: historyMax, audit: auditMax } }).db;
    v = Number(snap.v) || 0;
    for (const [opId, ver] of Array.isArray(snap.ops) ? snap.ops : []) remember(opId, ver);
    if (existsSync(files.events)) {
      const lines = readFileSync(files.events, 'utf8').split('\n');
      let replayed = 0;
      for (const [i, line] of lines.entries()) {
        if (!line.trim()) continue;
        let ev;
        try { ev = JSON.parse(line); } catch {
          if (i >= lines.length - 2) { log.warn?.('journal : dernière ligne incomplète ignorée (arrêt brutal)'); break; }
          throw new Error(`events.jsonl : ligne ${i + 1} illisible`);
        }
        if (ev.v <= v) continue;
        if (ev.v !== v + 1) throw new Error(`events.jsonl : version ${ev.v} inattendue (attendue ${v + 1})`);
        if (ev.reset) { db = normalizeDb(ev.db, now(), { limits: { history: historyMax, audit: auditMax } }).db; ring.length = 0; }
        else {
          applyPatch(db, ev.patch);
          pushRing({ ...ev, patch: publicPatch(ev.patch) }); // rattrapage possible des appareils après un redémarrage
        }
        v = ev.v;
        if (ev.opId) remember(ev.opId, ev.v);
        replayed++;
        sinceSnapshot++;
      }
      if (replayed) log.info?.(`journal : ${replayed} événement(s) rejoué(s)`);
    }
    return true;
  }

  function appendEvent(ev) {
    const fd = openEvents();
    writeSync(fd, `${JSON.stringify(ev)}\n`);
    fsyncSync(fd);
    sinceSnapshot++;
  }

  /** Date d'effet d'une opération : celle de l'appareil (saisie hors ligne), bornée par le serveur. */
  function effectiveDate(at) {
    const t = Date.parse(at);
    const n = now().getTime();
    if (!Number.isFinite(t) || t > n + 120_000) return { date: new Date(n) };
    if (t < n - MAX_OP_AGE_DAYS * DAY) return { error: `Opération saisie il y a plus de ${MAX_OP_AGE_DAYS} jours : ressaisissez-la.` };
    return { date: new Date(t) };
  }

  /**
   * Exécute une opération pour `user` (fiche utilisateur du serveur).
   * @returns {{status:'ok'|'duplicate', v:number, result?:any} | {status:'rejected', code:string, message:string}}
   */
  function apply({ opId, name, params, depotId, at }, user) {
    if (typeof opId !== 'string' || !isUid(opId) || opId.length > 32) return { status: 'rejected', code: 'invalid', message: 'Identifiant d\'opération invalide.' };
    if (recent.has(opId)) return { status: 'duplicate', v: recent.get(opId) };
    if (!isOpName(name)) return { status: 'rejected', code: 'invalid', message: 'Opération inconnue.' };
    const when = effectiveDate(at);
    if (when.error) return { status: 'rejected', code: 'too_old', message: when.error };
    const ctx = {
      user: { id: user.id, name: user.name, role: user.role, depotId: user.depotId },
      depotId: typeof depotId === 'string' ? depotId : user.depotId,
      now: when.date, uid: seededIds(opId), limits: { history: Infinity, audit: Infinity },
    };
    let out;
    try {
      out = runRecorded(db, (d) => OPS[name](d, ctx, params));
    } catch (e) {
      if (e?.isOpError) return { status: 'rejected', code: e.code, message: e.message };
      log.error?.(`opération ${name} : erreur inattendue (base intacte)`, e);
      return { status: 'rejected', code: 'invalid', message: 'Requête invalide.' };
    }
    v += 1;
    const ev = { v, at: now().toISOString(), opId, name, by: user.name, depotId: ctx.depotId, patch: out.patch };
    appendEvent(ev);
    remember(opId, v);
    const pub = { ...ev, patch: publicPatch(out.patch) };
    pushRing(pub);
    emit(pub);
    trimLogs();
    if (sinceSnapshot >= snapshotEvery) writeSnapshot();
    return { status: 'ok', v, result: out.result };
  }

  return {
    load,
    /** Première installation : base fournie (démo ou installation vide). */
    bootstrap(initial) {
      db = initial;
      v = 0;
      writeSnapshot();
    },
    apply,
    /** Opération décidée par le serveur lui-même (trace de connexion…). */
    serverOp(name, params, user, depotId) { return apply({ opId: uid(), name, params, depotId, at: now().toISOString() }, user); },
    /** Restauration d'une sauvegarde : nouvel état complet, les appareils rechargent un instantané. */
    replace(next) {
      db = next;
      v += 1;
      appendEvent({ v, at: now().toISOString(), reset: true, db: next });
      ring.length = 0;
      writeSnapshot();
      emit({ v, reset: true });
    },
    /** Événements publics postérieurs à `since` ; null = trop ancien (l'appareil doit recharger un instantané). */
    eventsSince(since) {
      const s = Number(since);
      if (!Number.isInteger(s) || s < 0 || s > v) return null;
      if (s === v) return [];
      if (!ring.length || ring[0].v > s + 1) return null;
      return ring.filter((e) => e.v > s);
    },
    /** Instantané pour un appareil : sans PIN, journaux limités (seule la partie envoyée est copiée). */
    snapshot() {
      const pub = publicDb({ ...db, history: db.history.slice(0, REPLICA_LOGS.history), audit: db.audit.slice(0, REPLICA_LOGS.audit) });
      // `ops` : opérations récentes déjà intégrées — l'appareil retire de sa file celles dont la réponse s'est perdue.
      return { v, db: pub, hash: hash(), serverTime: now().toISOString(), ops: [...recent.keys()].slice(-2000) };
    },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    get db() { return db; },
    get version() { return v; },
    hash,
    flush() { if (db) writeSnapshot(); },
    close() {
      if (db && sinceSnapshot) writeSnapshot();
      if (eventsFd !== null) { closeSync(eventsFd); eventsFd = null; }
      subs.clear();
    },
  };
}
