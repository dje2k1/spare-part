// Persistance de la base (localStorage) : chargement/migration, sauvegarde, transactions,
// export/import de sauvegardes. Le stockage est injecté → testable sans navigateur.
import { KEYS, LIMITS } from './config.js';
import { emptyDb, normalizeDb, makeBackup, parseBackup } from './schema.js';

/**
 * @param {{storage: Storage, now?: () => Date}} deps
 */
export function createStore({ storage, now = () => new Date() }) {
  let db = null;
  let external = null; // mode serveur : la base vient du moteur de synchronisation (core/sync-engine.js)
  let status = { recovered: false, migrated: false, notes: [], saveError: null, trimmed: false };
  const subs = new Set();
  const emit = (event, detail) => subs.forEach((fn) => { try { fn(event, detail); } catch (e) { console.error(e); } });

  const read = (key) => { try { return storage.getItem(key); } catch { return null; } };

  function trim() {
    if (db.history.length > LIMITS.history) db.history.length = LIMITS.history;
    if (db.audit.length > LIMITS.audit) db.audit.length = LIMITS.audit;
  }

  /** Écrit la base ; en cas de quota dépassé, élague les plus anciens journaux et réessaie une fois. */
  function save() {
    if (external) return true; // la copie locale est gérée par le moteur de synchronisation
    trim();
    db.meta.rev += 1;
    const attempt = () => storage.setItem(KEYS.db, JSON.stringify(db));
    try {
      attempt();
      status.saveError = null;
      emit('saved');
      return true;
    } catch (first) {
      try {
        const keepH = Math.max(200, Math.floor(db.history.length * 0.6));
        const keepA = Math.max(200, Math.floor(db.audit.length * 0.6));
        db.history.length = Math.min(db.history.length, keepH);
        db.audit.length = Math.min(db.audit.length, keepA);
        attempt();
        status.trimmed = true;
        status.saveError = null;
        emit('trimmed');
        return true;
      } catch (e) {
        status.saveError = e;
        emit('save-error', e);
        return false;
      }
    }
  }

  /** Charge la base : v5 → migration v4 → (rien). Les données illisibles sont mises en quarantaine, jamais écrasées. */
  function load() {
    status = { recovered: false, migrated: false, notes: [], saveError: null, trimmed: false };
    const current = read(KEYS.db);
    if (current) {
      try {
        const { db: d, notes } = normalizeDb(JSON.parse(current), now());
        db = d; status.notes = notes;
        return db;
      } catch {
        try { storage.setItem(`${KEYS.db}.corrupt`, current); } catch { /* quota : on garde au moins la mémoire */ }
        status.recovered = true;
        db = null;
        return null;
      }
    }
    const legacy = read(KEYS.legacyDb);
    if (legacy) {
      try {
        const { db: d, notes } = normalizeDb(JSON.parse(legacy), now());
        db = d; status.migrated = true; status.notes = notes;
        if (save()) {
          // Vérifie la relecture avant de supprimer l'ancienne copie (qui contient des PIN en clair).
          try { if (JSON.parse(storage.getItem(KEYS.db)).v === d.v) storage.removeItem(KEYS.legacyDb); } catch { /* on garde l'ancienne copie */ }
        }
        return db;
      } catch { status.recovered = true; db = null; return null; }
    }
    db = null;
    return null;
  }

  /** Purge les anciennes clés obsolètes (versions 1-3). */
  function cleanObsolete() {
    for (const k of KEYS.legacyOld) { try { storage.removeItem(k); } catch { /* ignore */ } }
  }

  return {
    load,
    cleanObsolete,
    get db() { return external ? external.db : db; },
    get status() { return status; },
    get isEmpty() { return external ? !external.db : db === null; },
    get external() { return Boolean(external); },

    /** Mode serveur : `source.db` devient la base de l'application ; le stockage local n'est plus utilisé. */
    attach(source) { external = source; },
    /** Signale aux écouteurs une modification faite hors du store (moteur de synchronisation). */
    notify(event, detail) { emit(event, detail); },

    /** Remplace toute la base (première installation, restauration, réinitialisation). */
    replace(next) {
      db = next;
      const ok = save();
      emit('replaced');
      return ok;
    },

    save,

    /** Recharge depuis le stockage (autre onglet, ou annulation d'une opération en erreur). */
    reload() {
      if (external) return external.db;
      const prev = db;
      load();
      if (!db) db = prev;
      emit('reloaded');
      return db;
    },

    /**
     * Exécute une opération métier de façon transactionnelle :
     * une `OpError` (validation) n'a rien modifié ; toute autre erreur recharge l'état persistant (rollback).
     * @template T
     * @param {(db:object)=>T} fn
     * @returns {T}
     */
    run(fn) {
      if (external) throw new Error('Mode serveur : les opérations passent par le moteur de synchronisation.');
      try {
        const result = fn(db);
        save();
        emit('changed');
        return result;
      } catch (e) {
        if (!(e && e.isOpError)) {
          const prev = db;
          load();
          if (!db) db = prev;
          emit('reloaded');
        }
        throw e;
      }
    },

    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },

    exportBackup() {
      db.meta.lastBackupAt = now().toISOString();
      db.meta.lastBackupRev = db.meta.rev + 1; // la sauvegarde ci-dessous incrémente rev
      const text = makeBackup(db, now());
      save();
      return text;
    },

    importBackup(text) {
      const { db: d, notes, exportedAt } = parseBackup(text, now());
      return { db: d, notes, exportedAt };
    },

    /** Octets utilisés par la base (approximation en caractères UTF-16 → octets). */
    sizeBytes() { if (external) return 0; const v = read(KEYS.db); return v ? v.length * 2 : 0; },

    /** Modifications depuis la dernière sauvegarde exportée. */
    changesSinceBackup() { return db && !external ? db.meta.rev - db.meta.lastBackupRev : 0; },

    freshDb: () => emptyDb(now()),
  };
}
