// Schéma de la base (v5) : création, migration depuis l'ancien format (dior_v4) et assainissement.
// `normalizeDb` ne fait confiance à rien : il sert aussi à valider les sauvegardes importées.
import { DB_VERSION, LIMITS, ROLES, DEFAULT_SETTINGS, MOVES } from './config.js';
import { isCode } from '../lib/ean.js';
import { isImageDataUrl } from '../lib/image.js';
import { isUid, uid } from '../lib/id.js';
import { toInt } from '../lib/text.js';

export function emptyDb(now = new Date()) {
  return {
    v: DB_VERSION,
    meta: { createdAt: now.toISOString(), demo: false, lastBackupAt: null, lastBackupRev: 0, rev: 0, settings: { ...DEFAULT_SETTINGS } },
    depots: {}, users: {}, articles: {}, stocks: {}, locations: {}, history: [], transfers: [], audit: [],
  };
}

const str = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const nonNeg = (v, max = LIMITS.maxStock) => { const n = toInt(v); return Number.isNaN(n) ? 0 : Math.min(max, Math.max(0, n)); };
const iso = (v, fallback) => {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? fallback : d.toISOString();
};
const safeId = (v) => (isUid(v) ? v : null);

/** Variation de stock portée par une ligne d'historique (v4 ne la stockait pas). */
export function deriveDelta(h) {
  if (Number.isFinite(h.delta)) return h.delta;
  const q = Number(h.qty) || 0;
  switch (h.type) {
    case 'in': case 'transfer_in': case 'transfer_cancel': return q;
    case 'out': case 'transfer': return -q;
    case 'inv': return Number.isFinite(h.diff) ? h.diff : 0;
    default: return 0;
  }
}

function normPin(u) {
  const p = u.pin;
  if (isObj(p) && p.alg === 'PBKDF2-SHA256' && typeof p.salt === 'string' && typeof p.hash === 'string' && Number.isInteger(p.iter) && p.iter >= 10_000) {
    return { pin: { alg: p.alg, salt: p.salt, hash: p.hash, iter: p.iter, len: toInt(p.len) > 0 ? toInt(p.len) : 0 }, pinLegacy: undefined };
  }
  // Ancien format : PIN en clair → conservé le temps d'être haché au démarrage (auth.upgradeLegacyPins)
  const legacy = typeof p === 'string' ? p : typeof u.pinLegacy === 'string' ? u.pinLegacy : null;
  return { pin: null, pinLegacy: legacy && /^\d{4,8}$/.test(legacy) ? legacy : undefined };
}

/**
 * Assainit n'importe quelle donnée (stockage, migration v4, sauvegarde importée).
 * @returns {{db: object, notes: string[]}} base valide + remarques (éléments écartés/corrigés)
 */
export function normalizeDb(raw, now = new Date()) {
  const notes = [];
  if (!isObj(raw)) throw new Error('Format de données invalide');
  const out = emptyDb(now);
  const nowIso = now.toISOString();
  const wasLegacy = raw.v === undefined;

  if (isObj(raw.meta)) {
    out.meta.createdAt = iso(raw.meta.createdAt, out.meta.createdAt);
    out.meta.demo = raw.meta.demo === true;
    if (out.meta.demo && Array.isArray(raw.meta.demoPins)) {
      out.meta.demoPins = raw.meta.demoPins
        .filter((p) => p && typeof p.name === 'string' && /^\d{4,8}$/.test(String(p.pin)))
        .map((p) => ({ name: str(p.name, LIMITS.short), pin: String(p.pin) })).slice(0, 10);
    }
    out.meta.lastBackupAt = raw.meta.lastBackupAt ? iso(raw.meta.lastBackupAt, null) : null;
    out.meta.lastBackupRev = nonNeg(raw.meta.lastBackupRev, 1e12);
    out.meta.rev = nonNeg(raw.meta.rev, 1e12);
    const s = isObj(raw.meta.settings) ? raw.meta.settings : {};
    const sm = toInt(s.sessionMinutes);
    out.meta.settings.sessionMinutes = Number.isNaN(sm) ? DEFAULT_SETTINGS.sessionMinutes : Math.min(240, Math.max(0, sm));
  }

  // Dépôts
  for (const d of Object.values(isObj(raw.depots) ? raw.depots : {})) {
    const id = safeId(d?.id);
    const name = str(d?.name, LIMITS.short);
    if (!id || !name) { notes.push('dépôt invalide ignoré'); continue; }
    out.depots[id] = { id, name, location: str(d.location, LIMITS.short), code: str(d.code, 10) };
    out.stocks[id] = {};
  }

  // Emplacements
  for (const l of Object.values(isObj(raw.locations) ? raw.locations : {})) {
    const id = safeId(l?.id);
    if (!id || !out.depots[l.depotId]) { notes.push('emplacement orphelin ignoré'); continue; }
    const part = (v) => str(v, 8).toUpperCase().replace(/[^A-Z0-9]/g, '');
    const loc = { id, depotId: l.depotId, rack: part(l.rack), allee: part(l.allee), etagere: part(l.etagere), case: part(l.case), desc: str(l.desc, LIMITS.short) };
    if (!loc.rack && !loc.allee && !loc.etagere && !loc.case) continue;
    out.locations[id] = loc;
  }

  // Articles
  for (const a of Object.values(isObj(raw.articles) ? raw.articles : {})) {
    const ean = String(a?.ean ?? '');
    const name = str(a?.name, LIMITS.name);
    if (!isCode(ean) || !name) { notes.push(`article invalide ignoré (${str(ean, 20)})`); continue; }
    const price = Number(a.price);
    const locations = {};
    for (const [depotId, v] of Object.entries(isObj(a.locations) ? a.locations : {})) {
      if (!out.depots[depotId]) continue;
      const ids = (Array.isArray(v) ? v : [v]).filter((id) => typeof id === 'string' && out.locations[id]?.depotId === depotId);
      if (ids.length) locations[depotId] = [...new Set(ids)];
    }
    out.articles[ean] = {
      ean, name, family: str(a.family, LIMITS.short), ref: str(a.ref, LIMITS.ref),
      price: Number.isFinite(price) && price >= 0 ? Math.round(Math.min(price, 1e6) * 100) / 100 : 0,
      threshold: nonNeg(a.threshold, 100000),
      photo: isImageDataUrl(a.photo) ? a.photo : '',
      locations,
    };
  }

  // Stocks
  for (const [depotId, map] of Object.entries(isObj(raw.stocks) ? raw.stocks : {})) {
    if (!out.depots[depotId] || !isObj(map)) continue;
    for (const [ean, q] of Object.entries(map)) if (out.articles[ean]) out.stocks[depotId][ean] = nonNeg(q);
  }

  // Utilisateurs
  for (const u of Object.values(isObj(raw.users) ? raw.users : {})) {
    const id = safeId(u?.id);
    const name = str(u?.name, LIMITS.short);
    if (!id || !name || !out.depots[u.depotId]) { notes.push('utilisateur invalide ignoré'); continue; }
    const role = ROLES[u.role] ? u.role : 'operator';
    const { pin, pinLegacy } = normPin(u);
    const user = { id, name, role, depotId: u.depotId, pin };
    if (pinLegacy) user.pinLegacy = pinLegacy;
    out.users[id] = user;
  }

  // Historique (le plus récent d'abord)
  const hist = (Array.isArray(raw.history) ? raw.history : []).flatMap((h) => {
    if (!isObj(h) || !MOVES[h.type] || !isCode(String(h.ean ?? '')) || !out.depots[h.depotId]) return [];
    const entry = {
      id: safeId(h.id) || null, ean: String(h.ean), name: str(h.name, LIMITS.name), type: h.type,
      qty: nonNeg(h.qty), delta: 0, depotId: h.depotId, depotName: str(h.depotName || out.depots[h.depotId].name, LIMITS.short),
      operator: str(h.operator, LIMITS.short), date: iso(h.date, nowIso),
    };
    entry.delta = deriveDelta({ ...h, qty: entry.qty });
    if (safeId(h.operatorId)) entry.operatorId = h.operatorId;
    if (safeId(h.transferId)) entry.transferId = h.transferId;
    for (const k of ['loc', 'reason', 'note', 'validatedBy']) if (h[k]) entry[k] = str(h[k], LIMITS.name);
    if (h.undone === true) entry.undone = true;
    if (safeId(h.undoOf)) entry.undoOf = h.undoOf;
    return [entry];
  });
  hist.sort((a, b) => b.date.localeCompare(a.date));
  out.history = hist.slice(0, LIMITS.history);
  for (const h of out.history) if (!h.id) h.id = uid();

  // Transferts
  for (const t of Array.isArray(raw.transfers) ? raw.transfers : []) {
    if (!isObj(t) || !isCode(String(t.ean ?? '')) || !out.depots[t.fromDepotId] || !out.depots[t.toDepotId]) continue;
    const status = ['pending', 'done', 'cancelled', 'refused'].includes(t.status) ? t.status : 'pending';
    const tr = {
      id: safeId(t.id) || uid(), ean: String(t.ean), name: str(t.name, LIMITS.name),
      qty: Math.max(1, nonNeg(t.qty)), fromDepotId: t.fromDepotId, fromDepotName: str(t.fromDepotName || out.depots[t.fromDepotId].name, LIMITS.short),
      toDepotId: t.toDepotId, toDepotName: str(t.toDepotName || out.depots[t.toDepotId].name, LIMITS.short),
      operator: str(t.operator, LIMITS.short), date: iso(t.date, nowIso), status,
    };
    if (safeId(t.operatorId)) tr.operatorId = t.operatorId;
    for (const k of ['receivedBy', 'cancelledBy', 'note']) if (t[k]) tr[k] = str(t[k], LIMITS.name);
    for (const k of ['receivedDate', 'cancelledDate']) if (t[k]) tr[k] = iso(t[k], nowIso);
    out.transfers.push(tr);
  }

  // Audit
  out.audit = (Array.isArray(raw.audit) ? raw.audit : []).flatMap((e) => {
    if (!isObj(e) || !e.action) return [];
    const type = ['in', 'out', 'inv', 'transfer', 'login', 'admin'].includes(e.type) ? e.type : 'admin';
    const entry = { id: safeId(e.id) || uid(), type, action: str(e.action, 200), operator: str(e.operator, LIMITS.short) || 'système', depotId: out.depots[e.depotId] ? e.depotId : '', date: iso(e.date, nowIso), meta: {} };
    if (safeId(e.operatorId)) entry.operatorId = e.operatorId;
    if (isObj(e.meta)) {
      for (const [k, v] of Object.entries(e.meta)) {
        if (k === 'sig') { if (isImageDataUrl(v)) entry.meta.sig = v; continue; }
        if (typeof v === 'string') entry.meta[k] = str(v, 200);
        else if (typeof v === 'number' && Number.isFinite(v)) entry.meta[k] = v;
        else if (typeof v === 'boolean') entry.meta[k] = v;
      }
    }
    return [entry];
  });
  out.audit.sort((a, b) => b.date.localeCompare(a.date));
  out.audit = out.audit.slice(0, LIMITS.audit);

  if (wasLegacy) notes.push('données migrées depuis l\'ancien format');
  return { db: out, notes };
}

/** Enveloppe d'une sauvegarde exportée. */
export function makeBackup(db, now = new Date()) {
  return JSON.stringify({ app: 'mode-stock', schema: DB_VERSION, exportedAt: now.toISOString(), data: db });
}

/** Lit et valide une sauvegarde (texte JSON). Lève une Error au message affichable. */
export function parseBackup(text, now = new Date()) {
  if (typeof text !== 'string' || text.length > LIMITS.backupBytes) throw new Error('Fichier trop volumineux ou illisible');
  let json;
  try { json = JSON.parse(text); } catch { throw new Error('Ce fichier n\'est pas une sauvegarde valide (JSON illisible)'); }
  if (json?.app !== 'mode-stock' || !isObj(json.data)) throw new Error('Ce fichier n\'est pas une sauvegarde MODE Stock');
  if (!Number.isInteger(json.schema) || json.schema > DB_VERSION) throw new Error('Sauvegarde créée par une version plus récente de l\'application');
  const { db, notes } = normalizeDb(json.data, now);
  if (!Object.keys(db.depots).length) throw new Error('La sauvegarde ne contient aucun dépôt');
  if (!Object.values(db.users).some((u) => u.role === 'admin' && (u.pin || u.pinLegacy))) throw new Error('La sauvegarde ne contient aucun administrateur utilisable');
  return { db, notes, exportedAt: json.exportedAt };
}
