// Outils communs aux opérations métier (ops.js, ops-orders.js). Aucune opération n'est exportée ici.
//
// Robustesse : les paramètres peuvent venir d'un appareil distant (synchronisation) — ils ne sont jamais
// supposés bien formés. Toute recherche par clé passe par `own()` : « __proto__ », « constructor »…
// ne résolvent jamais vers un objet du prototype.
import { LIMITS } from './config.js';
import { can } from './auth.js';
import { isCode } from '../lib/ean.js';
import { uid } from '../lib/id.js';
import { toInt } from '../lib/text.js';

const DAY = 86_400_000;

export class OpError extends Error {
  constructor(message, code = 'invalid') { super(message); this.name = 'OpError'; this.code = code; this.isOpError = true; }
}
export const fail = (message, code) => { throw new OpError(message, code); };

/** Valeur propre d'une table (jamais héritée du prototype). */
export const own = (map, key) => (map && typeof key === 'string' && Object.hasOwn(map, key) ? map[key] : undefined);

/** Paramètres d'opération : toujours un objet (un appareil distant peut envoyer n'importe quoi). */
export const obj = (p) => (p && typeof p === 'object' && !Array.isArray(p) ? p : {});
export const list = (v, max, label = 'lignes') => {
  if (!Array.isArray(v)) fail(`Liste de ${label} invalide.`);
  if (v.length > max) fail(`Trop de ${label} (${max} au maximum).`);
  return v;
};

// ── Gardes ──
export function need(ctx, permission) {
  if (!ctx?.user || !can(ctx.user.role, permission)) fail('Action non autorisée pour votre rôle.', 'forbidden');
}
export function depotFor(db, ctx, depotId) {
  const d = own(db.depots, depotId);
  if (!d) fail('Dépôt introuvable.', 'notfound');
  if (!can(ctx.user.role, 'depot.any') && ctx.user.depotId !== depotId) fail('Accès refusé à ce dépôt.', 'forbidden');
  return d;
}
export const centralDepot = (db) => Object.values(db.depots).find((d) => d.kind === 'central') ?? null;

export const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

export function qtyOf(v, label = 'Quantité') {
  const n = toInt(v);
  if (Number.isNaN(n) || n < 1 || n > LIMITS.maxQty) fail(`${label} invalide : entier entre 1 et ${LIMITS.maxQty.toLocaleString('fr-FR')}.`);
  return n;
}
/** Quantité ≥ 0 (une ligne à 0 = supprimée / rien de reçu). */
export function qty0(v, label = 'Quantité') {
  const n = toInt(v);
  if (Number.isNaN(n) || n < 0 || n > LIMITS.maxQty) fail(`${label} invalide : entier entre 0 et ${LIMITS.maxQty.toLocaleString('fr-FR')}.`);
  return n;
}
export function eanOf(v) {
  const s = String(v ?? '').trim();
  if (!isCode(s)) fail('Code invalide : 8 à 14 chiffres attendus.');
  return s;
}

/**
 * Identifiant d'un nouvel objet. Avec synchronisation, `ctx.uid` est dérivé de l'identifiant de
 * l'opération : l'appareil (exécution anticipée) et le serveur (exécution qui fait foi) produisent
 * les MÊMES identifiants — une annulation saisie hors ligne retrouve donc son mouvement.
 */
export const newId = (ctx) => (typeof ctx.uid === 'function' ? ctx.uid() : uid(ctx.now.getTime()));

/** Générateur d'identifiants déterministe pour une opération (voir newId). */
export function seededIds(opId) {
  let n = 0;
  return () => `${opId}${(n++).toString(36)}`.slice(0, 40);
}

// ── Journalisation ──
const limitOf = (ctx, key) => ctx.limits?.[key] ?? LIMITS[key];

function cleanMeta(meta) {
  const out = {};
  for (const [k, v] of Object.entries(meta || {})) {
    if (typeof v === 'string') out[k] = k === 'sig' ? v : v.slice(0, 200);
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v;
  }
  return out;
}
export function audit(db, ctx, type, action, meta = {}, depotId = ctx.depotId) {
  db.audit.unshift({ id: newId(ctx), type, action: clean(action, 200), operator: ctx.user.name, operatorId: ctx.user.id, depotId: depotId ?? '', date: ctx.now.toISOString(), meta: cleanMeta(meta) });
  if (db.audit.length > limitOf(ctx, 'audit')) db.audit.length = limitOf(ctx, 'audit');
}
export function logMove(db, ctx, entry) {
  const h = { id: newId(ctx), operator: ctx.user.name, operatorId: ctx.user.id, date: ctx.now.toISOString(), ...entry };
  db.history.unshift(h);
  if (db.history.length > limitOf(ctx, 'history')) db.history.length = limitOf(ctx, 'history');
  return h;
}
export function setStock(db, depotId, ean, qty) {
  if (qty < 0 || qty > LIMITS.maxStock) fail(`Stock hors limites (0 à ${LIMITS.maxStock.toLocaleString('fr-FR')}).`);
  (db.stocks[depotId] ??= {})[ean] = qty;
}

// ── Consommation (base des seuils intelligents) ──
// usage[dépôt][ean][semaine] = unités sorties (consommées ou expédiées). Indépendant de la durée de
// conservation de l'historique : 27 semaines glissantes, quelques octets par article.
export const USAGE_WEEKS = 27;
/** Numéro de semaine (lundi → dimanche, UTC) depuis 1970. */
export const weekOf = (date) => Math.floor((Math.floor(new Date(date).getTime() / DAY) + 3) / 7);

export function addUsage(db, ctx, depotId, ean, qty, date = ctx.now) {
  if (!qty) return;
  const w = weekOf(date);
  const nowW = weekOf(ctx.now);
  if (w <= nowW - USAGE_WEEKS || w > nowW) return; // trop ancien (déjà sorti de la fenêtre) ou futur
  const byDepot = (db.usage[depotId] ??= {});
  const weeks = (byDepot[ean] ??= {});
  const next = Math.max(0, (weeks[w] ?? 0) + qty);
  if (next) weeks[w] = next; else delete weeks[w];
  for (const k of Object.keys(weeks)) if (Number(k) <= nowW - USAGE_WEEKS) delete weeks[k];
  if (!Object.keys(weeks).length) delete byDepot[ean];
  if (!Object.keys(byDepot).length) delete db.usage[depotId];
}
