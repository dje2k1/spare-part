// Authentification côté serveur : code d'accès de l'entreprise, connexion par PIN, sessions, limites.
//
// - Le code d'accès (ORG_CODE) est demandé une fois par appareil : sans lui, impossible même de lister
//   les dépôts et les comptes (pas d'annuaire du personnel exposé sur Internet).
// - Le PIN est vérifié par le serveur (empreinte PBKDF2) : la force brute hors ligne d'un appareil n'est
//   plus possible pour les autres comptes, et les essais en ligne sont limités par compte ET par adresse.
// - Session : jeton aléatoire de 256 bits dans un cookie HttpOnly, SameSite=Strict ; le serveur n'en garde
//   que l'empreinte SHA-256 (sessions.json), avec expiration glissante.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { verifyPin, hashPin, pinPolicy, createLockout, can } from '../js/core/auth.js';
import { own } from '../js/core/ops-kit.js';

const COOKIE = 'mode_session';
const sha = (s) => createHash('sha256').update(s).digest('hex');
/** Vérifications de PIN simultanées au plus (PBKDF2 : ~0,1 s de calcul chacune) — le processeur reste disponible. */
export const MAX_PIN_CHECKS = 8;
/** Sessions ouvertes par compte au plus (téléphone, tablette, poste…) : au-delà, la plus ancienne est fermée. */
export const MAX_SESSIONS_PER_USER = 20;
/** Verrouillages de compte journalisés : le premier, puis tous les 10 échecs (pas d'inondation du journal). */
const auditLockout = (failures) => failures === 5 || (failures > 5 && failures % 10 === 5);

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, val) => { m.set(k, String(val)); }, removeItem: (k) => { m.delete(k); } };
}

/** Fenêtre glissante simple : au plus `max` événements par `windowMs` et par clé. */
export function createLimiter({ max, windowMs, now = () => Date.now() }) {
  const hits = new Map();
  const recent = (key) => (hits.get(key) ?? []).filter((x) => now() - x < windowMs);
  return {
    /** Enregistre un événement. @returns false si la limite est dépassée */
    hit(key) {
      const list = recent(key);
      list.push(now());
      hits.set(key, list);
      if (hits.size > 10_000) hits.delete(hits.keys().next().value);
      return list.length <= max;
    },
    /** Limite atteinte (sans enregistrer d'événement) ? */
    blocked: (key) => recent(key).length >= max,
    reset(key) { hits.delete(key); },
  };
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Cookies de la requête. Un cookie mal encodé (« % » isolé, posé par une autre application du même domaine)
 * est ignoré : il ne doit jamais faire échouer la requête (sinon : erreur 500 sur toute l'API).
 */
export function parseCookies(header = '') {
  const out = Object.create(null);
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    try { out[name] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* valeur illisible : ignorée */ }
  }
  return out;
}

export function createAuth({ store, dataDir, orgCode, sessionHours = 12, now = () => Date.now(), log = console }) {
  const file = join(dataDir, 'sessions.json');
  const sessions = new Map(); // empreinte du jeton → { userId, depotId, exp }
  const lockout = createLockout({ storage: memoryStorage(), key: 'locks', now });
  // Par adresse IP, seuls les ÉCHECS comptent : un atelier entier derrière la même box (même adresse publique)
  // peut se connecter et se reconnecter librement ; un essai systématique de codes ou de PIN est freiné.
  const ipFails = createLimiter({ max: 30, windowMs: 10 * 60_000, now });
  let saveTimer = null;
  let checking = 0; // calculs PBKDF2 en cours
  /** Calcul PBKDF2 (vérification ou empreinte) sans dépasser MAX_PIN_CHECKS en parallèle. @returns null = serveur occupé */
  async function pbkdf2(fn) {
    if (checking >= MAX_PIN_CHECKS) return null;
    checking++;
    try { return await fn(); } finally { checking--; }
  }
  const checkPin = (record, pin) => pbkdf2(() => verifyPin(record, pin));
  const busy = { ok: false, status: 503, error: 'Serveur occupé : réessayez dans un instant.' };
  /** PIN erroné (connexion ou changement de PIN) : compte et adresse pénalisés ; verrouillage signalé au journal. */
  function failed(user, ip) {
    ipFails.hit(ip);
    const r = lockout.fail(user.id);
    if (r.failures >= 5) log.warn?.(`compte ${user.name} verrouillé après ${r.failures} PIN erronés (dernier essai depuis ${ip})`);
    return { ok: false, status: 401, retryMs: r.remainingMs, ...(auditLockout(r.failures) && { lockout: { user, failures: r.failures } }) };
  }

  if (existsSync(file)) {
    try {
      for (const [k, s] of Object.entries(JSON.parse(readFileSync(file, 'utf8')))) if (s.exp > now()) sessions.set(k, s);
    } catch { log.warn?.('sessions.json illisible : sessions réinitialisées'); }
  }
  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        writeFileSync(`${file}.tmp`, JSON.stringify(Object.fromEntries(sessions)));
        renameSync(`${file}.tmp`, file);
      } catch (e) { log.error?.('sessions : écriture impossible', e); }
    }, 200);
    saveTimer.unref?.();
  }

  const checkOrg = (code) => Boolean(orgCode) && safeEqual(String(code ?? '').trim().toUpperCase(), String(orgCode).trim().toUpperCase());

  /** Retire les sessions expirées (appareils perdus, jamais revenus) : sessions.json ne grossit pas indéfiniment. */
  function purge() {
    let n = 0;
    for (const [k, s] of sessions) if (s.exp <= now()) { sessions.delete(k); n++; }
    if (n) persist();
    return n;
  }
  const purgeTimer = setInterval(purge, 3_600_000);
  purgeTimer.unref?.();

  return {
    purge,
    COOKIE,
    checkOrg,
    /** Code d'accès vérifié avec limitation des échecs par adresse. @returns 'ok' | 'bad' | 'blocked' */
    checkOrgFrom(code, ip) {
      if (ipFails.blocked(ip)) return 'blocked';
      if (checkOrg(code)) return 'ok';
      ipFails.hit(ip);
      return 'bad';
    },
    /** Annuaire minimal pour l'écran de connexion (aucune empreinte, aucune donnée de stock). */
    directory() {
      const db = store.db;
      return {
        depots: Object.values(db.depots).map((d) => ({ id: d.id, name: d.name, code: d.code, kind: d.kind })),
        users: Object.values(db.users).map((u) => ({ id: u.id, name: u.name, role: u.role, depotId: u.depotId, pinLen: u.pin?.len || 0 })),
      };
    },
    /**
     * L'empreinte du PIN ne quitte jamais le serveur : l'appareil fabrique son propre vérificateur (déverrouillage
     * hors ligne) à partir du PIN saisi. `lockout` : compte qui vient d'être verrouillé (à journaliser).
     * @returns {Promise<{ok:true, token:string, user:object, depotId:string} | {ok:false, status:number, error:string, retryMs?:number, lockout?:{user:object, failures:number}}>}
     */
    async login({ userId, pin, depotId, orgCode: code }, ip) {
      if (ipFails.blocked(ip)) return { ok: false, status: 429, error: 'Trop de tentatives depuis cette adresse : patientez quelques minutes.' };
      if (!checkOrg(code)) { ipFails.hit(ip); return { ok: false, status: 403, error: 'Code d\'accès de l\'entreprise incorrect.' }; }
      const user = typeof userId === 'string' ? own(store.db.users, userId) : null;
      if (!user || !user.pin) { ipFails.hit(ip); return { ok: false, status: 401, error: 'Compte inconnu.' }; }
      const st = lockout.status(user.id);
      if (st.locked) return { ok: false, status: 423, error: 'Compte verrouillé après plusieurs erreurs.', retryMs: st.remainingMs };
      const good = await checkPin(user.pin, pin);
      if (good === null) return busy;
      if (!good) return { ...failed(user, ip), error: 'PIN incorrect.' };
      lockout.success(user.id);
      const token = randomBytes(32).toString('base64url');
      const d = can(user.role, 'depot.any') && own(store.db.depots, depotId) ? depotId : user.depotId;
      sessions.set(sha(token), { userId: user.id, depotId: d, exp: now() + sessionHours * 3_600_000 });
      // Connexions en boucle : la mémoire et sessions.json restent bornés (la session la moins récemment utilisée part)
      const mine = [...sessions].filter(([, x]) => x.userId === user.id).sort((a, b) => a[1].exp - b[1].exp);
      for (const [k] of mine.slice(0, Math.max(0, mine.length - MAX_SESSIONS_PER_USER))) sessions.delete(k);
      persist();
      return { ok: true, token, user: { id: user.id, name: user.name, role: user.role, depotId: user.depotId }, depotId: d };
    },
    /**
     * Changement de son propre PIN : le PIN actuel est vérifié PAR LE SERVEUR (une session volée ou un appareil
     * modifié ne suffit pas), la politique est appliquée au nouveau PIN en clair, l'empreinte est calculée ici.
     * Les erreurs comptent comme à la connexion (même verrouillage du compte, même limite par adresse).
     * @returns {Promise<{ok:true, record:object} | {ok:false, status:number, error:string, retryMs?:number, lockout?:{user:object, failures:number}}>}
     */
    async changePin(s, { current, next } = {}, ip) {
      const user = own(store.db.users, s.user.id);
      if (!user?.pin) return { ok: false, status: 404, error: 'Compte introuvable.' };
      const policy = pinPolicy(next, { role: user.role }); // règle publique : vérifiée avant tout calcul
      if (!policy.ok) return { ok: false, status: 400, error: policy.reason };
      if (ipFails.blocked(ip)) return { ok: false, status: 429, error: 'Trop de tentatives depuis cette adresse : patientez quelques minutes.' };
      const st = lockout.status(user.id);
      if (st.locked) return { ok: false, status: 423, error: 'Trop d\'essais : patientez avant de réessayer.', retryMs: st.remainingMs };
      const good = await checkPin(user.pin, current);
      if (good === null) return busy;
      if (!good) return { ...failed(user, ip), error: 'PIN actuel incorrect.' };
      lockout.success(user.id);
      const record = await pbkdf2(() => hashPin(String(next)));
      return record ? { ok: true, record } : busy;
    },
    /** Session de la requête (cookie), prolongée à chaque usage ; null si absente, expirée ou compte supprimé. */
    authenticate(req) {
      const token = parseCookies(req.headers.cookie)[COOKIE];
      if (!token || token.length > 100) return null;
      const key = sha(token);
      const s = sessions.get(key);
      if (!s || s.exp <= now()) { if (s) { sessions.delete(key); persist(); } return null; }
      const user = own(store.db.users, s.userId);
      if (!user) { sessions.delete(key); persist(); return null; }
      if (s.exp - now() < (sessionHours * 3_600_000) / 2) { s.exp = now() + sessionHours * 3_600_000; persist(); }
      return { key, user, depotId: own(store.db.depots, s.depotId) ? s.depotId : user.depotId };
    },
    logout(req) {
      const token = parseCookies(req.headers.cookie)[COOKIE];
      if (token && sessions.delete(sha(token))) persist();
    },
    /** Révoque les sessions d'un compte (suppression, changement de PIN), sauf éventuellement la session `exceptKey`. */
    revokeUser(userId, exceptKey = null) {
      let n = 0;
      for (const [k, s] of sessions) if (s.userId === userId && k !== exceptKey) { sessions.delete(k); n++; }
      if (n) persist();
      return n;
    },
    /** Révoque toutes les sessions sauf `exceptKey` (restauration d'une sauvegarde). */
    revokeAll(exceptKey = null) {
      for (const k of [...sessions.keys()]) if (k !== exceptKey) sessions.delete(k);
      persist();
    },
    close() { clearTimeout(saveTimer); clearInterval(purgeTimer); try { writeFileSync(file, JSON.stringify(Object.fromEntries(sessions))); } catch { /* ignoré */ } },
  };
}
