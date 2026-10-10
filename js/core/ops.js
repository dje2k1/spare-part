// Opérations métier : SEUL endroit où le stock et les données de référence sont modifiés.
//
// Contrat de chaque opération `op(db, ctx, params)` :
//   1. vérifie permission, accès au dépôt et paramètres, et lève `OpError` AVANT toute mutation ;
//   2. mute ensuite `db` (jamais d'erreur attendue à ce stade) ;
//   3. journalise (historique de stock + audit) et retourne un résumé.
// `ctx = { user:{id,name,role,depotId}, depotId, now:Date }` — `store.run()` rend l'ensemble transactionnel.
import { LIMITS, ROLES } from './config.js';
import { can } from './auth.js';
import { locCode, stockOf, totalStock, isAlert } from './queries.js';
import { isCode, nextInternalEan } from '../lib/ean.js';
import { isImageDataUrl } from '../lib/image.js';
import { uid } from '../lib/id.js';
import { toInt, intIn, toMoney } from '../lib/text.js';
import { parse as parseCsv } from '../lib/csv.js';

export class OpError extends Error {
  constructor(message, code = 'invalid') { super(message); this.name = 'OpError'; this.code = code; this.isOpError = true; }
}
const fail = (message, code) => { throw new OpError(message, code); };

// ── Gardes ──
function need(ctx, permission) {
  if (!ctx?.user || !can(ctx.user.role, permission)) fail('Action non autorisée pour votre rôle.', 'forbidden');
}
function depotFor(db, ctx, depotId) {
  const d = db.depots[depotId];
  if (!d) fail('Dépôt introuvable.', 'notfound');
  if (!can(ctx.user.role, 'depot.any') && ctx.user.depotId !== depotId) fail('Accès refusé à ce dépôt.', 'forbidden');
  return d;
}
const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

function qtyOf(v, label = 'Quantité') {
  const n = toInt(v);
  if (Number.isNaN(n) || n < 1 || n > LIMITS.maxQty) fail(`${label} invalide : entier entre 1 et ${LIMITS.maxQty.toLocaleString('fr-FR')}.`);
  return n;
}
const eanOf = (v) => {
  const s = String(v ?? '').trim();
  if (!isCode(s)) fail('Code invalide : 8 à 14 chiffres attendus.');
  return s;
};

// ── Journalisation ──
function cleanMeta(meta) {
  const out = {};
  for (const [k, v] of Object.entries(meta || {})) {
    if (typeof v === 'string') out[k] = k === 'sig' ? v : v.slice(0, 200);
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v;
  }
  return out;
}
function audit(db, ctx, type, action, meta = {}, depotId = ctx.depotId) {
  db.audit.unshift({ id: uid(ctx.now.getTime()), type, action: clean(action, 200), operator: ctx.user.name, operatorId: ctx.user.id, depotId: depotId ?? '', date: ctx.now.toISOString(), meta: cleanMeta(meta) });
  if (db.audit.length > LIMITS.audit) db.audit.length = LIMITS.audit;
}
function logMove(db, ctx, entry) {
  const h = { id: uid(ctx.now.getTime()), operator: ctx.user.name, operatorId: ctx.user.id, date: ctx.now.toISOString(), ...entry };
  db.history.unshift(h);
  if (db.history.length > LIMITS.history) db.history.length = LIMITS.history;
  return h;
}
function setStock(db, depotId, ean, qty) {
  if (qty < 0 || qty > LIMITS.maxStock) fail(`Stock hors limites (0 à ${LIMITS.maxStock.toLocaleString('fr-FR')}).`);
  (db.stocks[depotId] ??= {})[ean] = qty;
}

/** Trace de connexion/déconnexion (appelée par la couche session). */
export function recordAuth(db, ctx, action) {
  audit(db, ctx, 'login', action, { role: ctx.user.role });
}

// ── Emplacements ──
export function parseLocCode(input) {
  // Espaces, « _ », « / » et « . » valent séparateur : « r2 a3 e1 » → R2-A3-E1
  const code = String(input ?? '').trim().toUpperCase().replace(/[\s_/.]+/g, '-');
  if (!/^[A-Z0-9]{1,8}(-[A-Z0-9]{1,8}){0,3}$/.test(code)) fail('Emplacement invalide (exemple : R1-A2-E3-C1).');
  const [rack = '', allee = '', etagere = '', cas = ''] = code.split('-');
  return { code, rack, allee, etagere, case: cas };
}

function findLoc(db, depotId, code) {
  return Object.values(db.locations).find((l) => l.depotId === depotId && locCode(l) === code);
}

function ensureLoc(db, ctx, depotId, input) {
  const p = parseLocCode(input);
  let loc = findLoc(db, depotId, p.code);
  if (!loc) {
    loc = { id: uid(ctx.now.getTime()), depotId, rack: p.rack, allee: p.allee, etagere: p.etagere, case: p.case, desc: '' };
    db.locations[loc.id] = loc;
    audit(db, ctx, 'admin', `Emplacement créé : ${p.code}`, { locId: loc.id }, depotId);
  }
  return loc;
}

function linkLoc(db, ean, depotId, locId, asDefault) {
  const a = db.articles[ean];
  const cur = (a.locations[depotId] ?? []).filter((id) => id !== locId);
  a.locations[depotId] = asDefault ? [locId, ...cur] : [...cur, locId];
}

// ── Articles ──
function articleFields(f, { photoKeep } = {}) {
  const name = clean(f.name, LIMITS.name);
  if (!name) fail('La désignation est obligatoire.');
  const price = f.price === '' || f.price == null ? 0 : toMoney(f.price);
  if (Number.isNaN(price) || price > 1_000_000) fail('Prix invalide (nombre positif).');
  const threshold = f.threshold === '' || f.threshold == null ? 0 : intIn(f.threshold, 0, 100000);
  if (Number.isNaN(threshold)) fail('Seuil d\'alerte invalide (entier ≥ 0).');
  let photo = photoKeep ?? '';
  if (f.photo !== undefined) {
    if (f.photo && !isImageDataUrl(f.photo)) fail('Photo invalide.');
    photo = f.photo || '';
  }
  return { name, family: clean(f.family, LIMITS.short), ref: clean(f.ref, LIMITS.ref), price, threshold, photo };
}

/** `createOnly` : le formulaire « Nouvelle pièce » ne doit jamais écraser une pièce existante portant le même code. */
export function upsertArticle(db, ctx, f) {
  const ean = eanOf(f.ean);
  const isNew = !db.articles[ean];
  if (f.createOnly && !isNew) fail(`Ce code existe déjà : « ${db.articles[ean].name} ». Ouvrez la fiche de cette pièce pour la modifier.`);
  need(ctx, isNew ? 'article.create' : 'article.edit');
  const fields = articleFields(f, { photoKeep: db.articles[ean]?.photo });
  db.articles[ean] = { ...(db.articles[ean] ?? { locations: {} }), ean, ...fields };
  for (const id of Object.keys(db.depots)) (db.stocks[id] ??= {})[ean] ??= 0;
  audit(db, ctx, 'admin', `Article ${isNew ? 'créé' : 'modifié'} : ${fields.name}`, { ean });
  return { ean, created: isNew };
}

export function deleteArticle(db, ctx, ean) {
  need(ctx, 'article.edit');
  const a = db.articles[eanOf(ean)];
  if (!a) fail('Article introuvable.', 'notfound');
  const units = totalStock(db, ean);
  if (units > 0) fail(`Suppression impossible : ${units} unité(s) en stock. Ramenez le stock à 0 d'abord.`);
  if (db.transfers.some((t) => t.status === 'pending' && t.ean === ean)) fail('Suppression impossible : un transfert en cours concerne cet article.');
  delete db.articles[ean];
  for (const m of Object.values(db.stocks)) delete m[ean];
  audit(db, ctx, 'admin', `Article supprimé : ${a.name}`, { ean });
}

/** Rattache un emplacement (par code) à un article, éventuellement comme emplacement par défaut. */
export function setArticleLocation(db, ctx, { ean, depotId = ctx.depotId, code, makeDefault = false }) {
  need(ctx, 'location.edit');
  depotFor(db, ctx, depotId);
  if (!db.articles[eanOf(ean)]) fail('Article introuvable.', 'notfound');
  const loc = ensureLoc(db, ctx, depotId, code);
  linkLoc(db, ean, depotId, loc.id, makeDefault);
  audit(db, ctx, 'admin', `Emplacement ${locCode(loc)} associé à ${db.articles[ean].name}`, { ean }, depotId);
  return loc;
}

export function removeArticleLocation(db, ctx, { ean, depotId = ctx.depotId, locId }) {
  need(ctx, 'location.edit');
  depotFor(db, ctx, depotId);
  const a = db.articles[eanOf(ean)];
  if (!a) fail('Article introuvable.', 'notfound');
  a.locations[depotId] = (a.locations[depotId] ?? []).filter((id) => id !== locId);
  if (!a.locations[depotId].length) delete a.locations[depotId];
}

// ── Mouvements ──
/**
 * Entrée ou sortie de stock. Crée l'article s'il est inconnu (nom facultatif → « Pièce <EAN> »).
 * @param {{type:'in'|'out', ean:string, qty:number|string, reason?:string, locCode?:string, article?:object}} p
 */
export function moveStock(db, ctx, p) {
  need(ctx, 'move');
  if (p.type !== 'in' && p.type !== 'out') fail('Type de mouvement invalide.');
  const ean = eanOf(p.ean);
  const qty = qtyOf(p.qty);
  const depot = depotFor(db, ctx, ctx.depotId);
  const cur = stockOf(db, depot.id, ean);
  const next = p.type === 'in' ? cur + qty : cur - qty;
  if (next < 0) fail(`Stock insuffisant : ${cur} disponible(s), ${qty} demandé(s).`);
  if (next > LIMITS.maxStock) fail('Stock maximal dépassé.');
  const loc = p.locCode ? parseLocCode(p.locCode) : null; // valide avant toute mutation

  let created = false;
  let article = db.articles[ean];
  if (!article) {
    need(ctx, 'article.create');
    const f = articleFields({ ...(p.article ?? {}), name: clean(p.article?.name, LIMITS.name) || `Pièce ${ean}` });
    article = db.articles[ean] = { ean, ...f, locations: {} };
    for (const id of Object.keys(db.depots)) (db.stocks[id] ??= {})[ean] ??= 0;
    audit(db, ctx, 'admin', `Article créé : ${article.name}`, { ean }, depot.id);
    created = true;
  } else if (p.article && can(ctx.user.role, 'article.edit')) {
    Object.assign(article, articleFields({ ...article, ...p.article, photo: undefined }, { photoKeep: article.photo }));
  }

  let locLabel = '';
  if (loc) {
    const l = ensureLoc(db, ctx, depot.id, loc.code);
    linkLoc(db, ean, depot.id, l.id, (article.locations[depot.id] ?? [])[0] === undefined || p.setDefaultLoc === true);
    locLabel = locCode(l);
  } else {
    const first = (article.locations[depot.id] ?? [])[0];
    if (first && db.locations[first]) locLabel = locCode(db.locations[first]);
  }

  setStock(db, depot.id, ean, next);
  const h = logMove(db, ctx, {
    ean, name: article.name, type: p.type, qty, delta: next - cur, depotId: depot.id, depotName: depot.name,
    ...(locLabel && { loc: locLabel }), ...(p.reason && { reason: clean(p.reason, 60) }),
  });
  audit(db, ctx, p.type, `${p.type === 'in' ? 'Entrée +' : 'Sortie −'}${qty} × ${article.name}`, { ean, qty, depotName: depot.name }, depot.id);
  return { historyId: h.id, ean, name: article.name, type: p.type, qty, stock: next, created, alert: isAlert(article, next) };
}

/** Annule une entrée/sortie récente (contre-mouvement tracé ; l'historique n'est jamais réécrit). */
export function undoMovement(db, ctx, historyId) {
  need(ctx, 'move');
  const h = db.history.find((x) => x.id === historyId);
  if (!h) fail('Mouvement introuvable.', 'notfound');
  if (h.type !== 'in' && h.type !== 'out') fail('Seules les entrées et sorties peuvent être annulées.');
  if (h.undone || h.undoOf) fail('Ce mouvement est déjà annulé ou est une annulation.');
  const depot = depotFor(db, ctx, h.depotId);
  if (h.operatorId !== ctx.user.id && !can(ctx.user.role, 'stock.adjust')) fail('Vous ne pouvez annuler que vos propres mouvements.', 'forbidden');
  if (ctx.now.getTime() - new Date(h.date).getTime() > LIMITS.undoWindowMs) fail('Délai d\'annulation dépassé : utilisez une correction de stock.');
  const cur = stockOf(db, depot.id, h.ean);
  const next = cur - h.delta;
  if (next < 0) fail('Annulation impossible : le stock a déjà été consommé.');
  if (next > LIMITS.maxStock) fail('Stock maximal dépassé.');
  setStock(db, depot.id, h.ean, next);
  h.undone = true;
  logMove(db, ctx, { ean: h.ean, name: h.name, type: h.type === 'in' ? 'out' : 'in', qty: h.qty, delta: -h.delta, depotId: depot.id, depotName: depot.name, note: 'Annulation', undoOf: h.id });
  audit(db, ctx, h.type === 'in' ? 'out' : 'in', `Annulation de ${h.type === 'in' ? 'l\'entrée' : 'la sortie'} ${h.qty} × ${h.name}`, { ean: h.ean, qty: h.qty }, depot.id);
  return { ean: h.ean, stock: next };
}

/** Correction de stock (valeur absolue constatée). */
export function adjustStock(db, ctx, { ean, qty, reason = '' }) {
  need(ctx, 'stock.adjust');
  ean = eanOf(ean);
  const a = db.articles[ean];
  if (!a) fail('Article introuvable.', 'notfound');
  const depot = depotFor(db, ctx, ctx.depotId);
  const next = intIn(qty, 0, LIMITS.maxStock);
  if (Number.isNaN(next)) fail('Quantité invalide : entier ≥ 0.');
  const cur = stockOf(db, depot.id, ean);
  if (next === cur) fail('Aucune modification : la quantité est identique.');
  setStock(db, depot.id, ean, next);
  logMove(db, ctx, { ean, name: a.name, type: 'inv', qty: next, delta: next - cur, depotId: depot.id, depotName: depot.name, ...(reason && { reason: clean(reason, 60) }) });
  audit(db, ctx, 'inv', `Correction de stock : ${a.name} ${cur}→${next}`, { ean, old: cur, new: next }, depot.id);
  return { ean, stock: next, diff: next - cur };
}

/**
 * Valide un inventaire compté. `lines` : [{ean, real, sys}] ; `validator` : responsable ayant saisi son PIN
 * (la vérification du PIN est faite par l'appelant). Retourne aussi les articles dont le stock a bougé
 * pendant le comptage (`conflicts`) : la valeur physique comptée prévaut.
 */
export function commitInventory(db, ctx, { depotId, lines, validator, signature = '' }) {
  need(ctx, 'inventory');
  const depot = depotFor(db, ctx, depotId);
  if (!Array.isArray(lines) || !lines.length) fail('Aucune ligne à valider.');
  const todo = [];
  for (const l of lines) {
    const ean = eanOf(l.ean);
    if (!db.articles[ean]) continue;
    const real = intIn(l.real, 0, LIMITS.maxStock);
    if (Number.isNaN(real)) fail(`Quantité comptée invalide pour ${db.articles[ean].name}.`);
    todo.push({ ean, real, sys: toInt(l.sys) });
  }
  let corrections = 0, conflicts = 0;
  for (const l of todo) {
    const cur = stockOf(db, depot.id, l.ean);
    if (!Number.isNaN(l.sys) && l.sys !== cur) conflicts++;
    if (l.real === cur) continue;
    setStock(db, depot.id, l.ean, l.real);
    logMove(db, ctx, { ean: l.ean, name: db.articles[l.ean].name, type: 'inv', qty: l.real, delta: l.real - cur, depotId: depot.id, depotName: depot.name, validatedBy: validator.name });
    corrections++;
  }
  audit(db, ctx, 'inv', `Inventaire validé par ${validator.name} — ${corrections} correction(s)`, {
    corrections, total: todo.length, conflicts, validator: validator.name, depotName: depot.name,
    ...(isImageDataUrl(signature) && { sig: signature }),
  }, depot.id);
  return { corrections, total: todo.length, conflicts };
}

// ── Transferts ──
export function createTransfer(db, ctx, { ean, qty, toDepotId }) {
  need(ctx, 'transfer.create');
  ean = eanOf(ean);
  const n = qtyOf(qty);
  const from = depotFor(db, ctx, ctx.depotId);
  const to = db.depots[toDepotId];
  if (!to) fail('Choisissez un dépôt destinataire.');
  if (to.id === from.id) fail('Le dépôt destinataire doit être différent du dépôt source.');
  const a = db.articles[ean];
  if (!a) fail('Article inconnu : créez-le avant de le transférer.', 'notfound');
  const cur = stockOf(db, from.id, ean);
  if (cur < n) fail(`Stock insuffisant pour le transfert : ${cur} disponible(s), ${n} demandé(s).`);
  setStock(db, from.id, ean, cur - n);
  const tr = {
    id: uid(ctx.now.getTime()), ean, name: a.name, qty: n, fromDepotId: from.id, fromDepotName: from.name, toDepotId: to.id, toDepotName: to.name,
    operator: ctx.user.name, operatorId: ctx.user.id, date: ctx.now.toISOString(), status: 'pending',
  };
  db.transfers.push(tr);
  logMove(db, ctx, { ean, name: a.name, type: 'transfer', qty: n, delta: -n, depotId: from.id, depotName: from.name, note: `→ ${to.name}`, transferId: tr.id });
  audit(db, ctx, 'transfer', `Transfert ${n} × ${a.name} → ${to.name}`, { ean, qty: n, fromDepot: from.name, toDepot: to.name }, from.id);
  return { transferId: tr.id, stock: cur - n };
}

function pendingTransfer(db, id) {
  const tr = db.transfers.find((t) => t.id === id);
  if (!tr) fail('Transfert introuvable.', 'notfound');
  if (tr.status !== 'pending') fail('Ce transfert est déjà traité.');
  return tr;
}

export function receiveTransfer(db, ctx, id) {
  need(ctx, 'transfer.receive');
  const tr = pendingTransfer(db, id);
  const to = depotFor(db, ctx, tr.toDepotId);
  const cur = stockOf(db, to.id, tr.ean);
  if (cur + tr.qty > LIMITS.maxStock) fail('Stock maximal dépassé.');
  if (!db.articles[tr.ean]) fail('Article supprimé du catalogue : réception impossible.');
  setStock(db, to.id, tr.ean, cur + tr.qty);
  tr.status = 'done'; tr.receivedBy = ctx.user.name; tr.receivedDate = ctx.now.toISOString();
  logMove(db, ctx, { ean: tr.ean, name: tr.name, type: 'transfer_in', qty: tr.qty, delta: tr.qty, depotId: to.id, depotName: to.name, note: `← ${tr.fromDepotName}`, transferId: tr.id });
  audit(db, ctx, 'transfer', `Réception ${tr.qty} × ${tr.name} depuis ${tr.fromDepotName}`, { ean: tr.ean, qty: tr.qty }, to.id);
  return { stock: cur + tr.qty };
}

function returnToSender(db, ctx, tr, status, note) {
  const from = db.depots[tr.fromDepotId];
  const cur = stockOf(db, from.id, tr.ean);
  setStock(db, from.id, tr.ean, Math.min(LIMITS.maxStock, cur + tr.qty));
  tr.status = status; tr.cancelledBy = ctx.user.name; tr.cancelledDate = ctx.now.toISOString();
  logMove(db, ctx, { ean: tr.ean, name: tr.name, type: 'transfer_cancel', qty: tr.qty, delta: tr.qty, depotId: from.id, depotName: from.name, note, transferId: tr.id });
  audit(db, ctx, 'transfer', `${note} : ${tr.qty} × ${tr.name}`, { ean: tr.ean, qty: tr.qty }, from.id);
}

/** Annulation par l'expéditeur (son auteur, ou un responsable du dépôt source). Le stock revient à la source. */
export function cancelTransfer(db, ctx, id) {
  const tr = pendingTransfer(db, id);
  depotFor(db, ctx, tr.fromDepotId);
  if (tr.operatorId !== ctx.user.id) need(ctx, 'transfer.cancel');
  returnToSender(db, ctx, tr, 'cancelled', 'Transfert annulé');
}

/** Refus par le destinataire (colis non reçu, erreur…). Le stock revient à la source. */
export function refuseTransfer(db, ctx, id) {
  need(ctx, 'transfer.receive');
  const tr = pendingTransfer(db, id);
  depotFor(db, ctx, tr.toDepotId);
  returnToSender(db, ctx, tr, 'refused', `Transfert refusé par ${ctx.user.name}`);
}

// ── Emplacements (administration) ──
export function saveLocation(db, ctx, { id, depotId, rack, allee, etagere, case: cas, desc }) {
  need(ctx, 'location.edit');
  const depot = depotFor(db, ctx, depotId);
  const p = parseLocCode([rack, allee, etagere, cas].map((s) => String(s ?? '').trim()).filter(Boolean).join('-'));
  const dup = findLoc(db, depot.id, p.code);
  if (dup && dup.id !== id) fail(`L'emplacement ${p.code} existe déjà dans ce dépôt.`);
  const existing = id ? db.locations[id] : null;
  if (id && !existing) fail('Emplacement introuvable.', 'notfound');
  if (existing && existing.depotId !== depot.id) fail('Un emplacement ne peut pas changer de dépôt.');
  const loc = { id: existing?.id ?? uid(ctx.now.getTime()), depotId: depot.id, rack: p.rack, allee: p.allee, etagere: p.etagere, case: p.case, desc: clean(desc, LIMITS.short) };
  db.locations[loc.id] = loc;
  audit(db, ctx, 'admin', `Emplacement ${existing ? 'modifié' : 'créé'} : ${p.code}`, { locId: loc.id }, depot.id);
  return loc;
}

export function deleteLocation(db, ctx, id) {
  need(ctx, 'location.edit');
  const loc = db.locations[id];
  if (!loc) fail('Emplacement introuvable.', 'notfound');
  depotFor(db, ctx, loc.depotId);
  delete db.locations[id];
  for (const a of Object.values(db.articles)) {
    const arr = a.locations[loc.depotId];
    if (!arr) continue;
    const next = arr.filter((x) => x !== id);
    if (next.length) a.locations[loc.depotId] = next; else delete a.locations[loc.depotId];
  }
  audit(db, ctx, 'admin', `Emplacement supprimé : ${locCode(loc)}`, { locId: id }, loc.depotId);
}

// ── Dépôts ──
export function saveDepot(db, ctx, { id, name, location, code }) {
  need(ctx, 'depot.manage');
  const n = clean(name, LIMITS.short);
  if (!n) fail('Le nom du dépôt est obligatoire.');
  const c = clean(code, 10).toUpperCase();
  if (Object.values(db.depots).some((d) => d.id !== id && d.name.toLowerCase() === n.toLowerCase())) fail('Un dépôt porte déjà ce nom.');
  if (c && Object.values(db.depots).some((d) => d.id !== id && d.code === c)) fail('Ce code de dépôt est déjà utilisé.');
  if (id && !db.depots[id]) fail('Dépôt introuvable.', 'notfound');
  const depotId = id ?? uid(ctx.now.getTime());
  db.depots[depotId] = { id: depotId, name: n, location: clean(location, LIMITS.short), code: c };
  db.stocks[depotId] ??= {};
  audit(db, ctx, 'admin', `Dépôt ${id ? 'modifié' : 'créé'} : ${n}`, { depotId }, depotId);
  return db.depots[depotId];
}

export function deleteDepot(db, ctx, id) {
  need(ctx, 'depot.manage');
  const d = db.depots[id];
  if (!d) fail('Dépôt introuvable.', 'notfound');
  if (Object.keys(db.depots).length <= 1) fail('Impossible de supprimer le dernier dépôt.');
  if (ctx.depotId === id) fail('Impossible de supprimer votre dépôt actif : changez de dépôt avant.');
  const users = Object.values(db.users).filter((u) => u.depotId === id);
  if (users.length) fail(`${users.length} utilisateur(s) sont rattachés à ce dépôt : réassignez-les d'abord.`);
  const units = Object.values(db.stocks[id] ?? {}).reduce((s, v) => s + v, 0);
  if (units > 0) fail(`Ce dépôt contient ${units} unité(s) : transférez ou corrigez le stock avant suppression.`);
  if (db.transfers.some((t) => t.status === 'pending' && (t.fromDepotId === id || t.toDepotId === id))) fail('Des transferts en cours concernent ce dépôt.');
  delete db.depots[id]; delete db.stocks[id];
  for (const l of Object.values(db.locations)) if (l.depotId === id) delete db.locations[l.id];
  for (const a of Object.values(db.articles)) delete a.locations[id];
  audit(db, ctx, 'admin', `Dépôt supprimé : ${d.name}`, {}, ctx.depotId);
}

// ── Utilisateurs ──
const adminCount = (db) => Object.values(db.users).filter((u) => u.role === 'admin').length;

/** `pin` : enregistrement déjà haché (voir auth.hashPin) ; null = conserver l'existant. */
export function saveUser(db, ctx, { id, name, role, depotId, pin }) {
  need(ctx, 'user.manage');
  const n = clean(name, LIMITS.short);
  if (!n) fail('Le nom est obligatoire.');
  if (!ROLES[role]) fail('Rôle invalide.');
  if (!db.depots[depotId]) fail('Dépôt invalide.');
  if (Object.values(db.users).some((u) => u.id !== id && u.name.toLowerCase() === n.toLowerCase())) fail('Un utilisateur porte déjà ce nom.');
  const existing = id ? db.users[id] : null;
  if (id && !existing) fail('Utilisateur introuvable.', 'notfound');
  if (!existing && !pin) fail('Un PIN est obligatoire pour un nouvel utilisateur.');
  if (existing && existing.role === 'admin' && role !== 'admin' && adminCount(db) <= 1) fail('Il doit rester au moins un administrateur.');
  const uidv = existing?.id ?? uid(ctx.now.getTime());
  db.users[uidv] = { id: uidv, name: n, role, depotId, pin: pin ?? existing.pin };
  if (pin && db.meta.demoPins) db.meta.demoPins = db.meta.demoPins.filter((p) => p.name.toLowerCase() !== n.toLowerCase());
  audit(db, ctx, 'admin', `Utilisateur ${existing ? 'modifié' : 'créé'} : ${n} (${ROLES[role].label})`, { userId: uidv });
  return db.users[uidv];
}

export function deleteUser(db, ctx, id) {
  need(ctx, 'user.manage');
  const u = db.users[id];
  if (!u) fail('Utilisateur introuvable.', 'notfound');
  if (u.id === ctx.user.id) fail('Vous ne pouvez pas supprimer votre propre compte.');
  if (u.role === 'admin' && adminCount(db) <= 1) fail('Il doit rester au moins un administrateur.');
  delete db.users[id];
  audit(db, ctx, 'admin', `Utilisateur supprimé : ${u.name}`, {});
}

/** Changement de son propre PIN (l'ancien PIN a été vérifié par l'appelant). */
export function changeOwnPin(db, ctx, pin) {
  const u = db.users[ctx.user.id];
  if (!u) fail('Utilisateur introuvable.', 'notfound');
  u.pin = pin;
  if (db.meta.demoPins) db.meta.demoPins = db.meta.demoPins.filter((p) => p.name.toLowerCase() !== u.name.toLowerCase());
  audit(db, ctx, 'admin', `PIN modifié : ${u.name}`, {});
}

export function updateSettings(db, ctx, { sessionMinutes }) {
  need(ctx, 'data.manage');
  const m = intIn(sessionMinutes, 0, 240);
  if (Number.isNaN(m)) fail('Durée invalide (0 à 240 minutes).');
  db.meta.settings.sessionMinutes = m;
  audit(db, ctx, 'admin', `Verrouillage automatique : ${m ? `${m} min` : 'désactivé'}`, { minutes: m });
}

// ── Import de catalogue (CSV) ──
const ALIASES = {
  ean: ['ean13', 'ean', 'code', 'gtin', 'codebarres', 'codebarre', 'barcode'],
  name: ['name', 'nom', 'designation', 'libelle', 'article'],
  family: ['family', 'famille', 'categorie'],
  ref: ['ref', 'reference'],
  price: ['price', 'prix', 'prixunitaire', 'pu'],
  threshold: ['threshold', 'seuil', 'seuilalerte', 'min'],
  stock: ['stock', 'quantite', 'qte', 'qty'],
};
const pick = (row, keys) => { for (const k of keys) if (row[k] !== undefined && String(row[k]).trim() !== '') return row[k]; return ''; };

/**
 * Importe des lignes CSV (déjà lues par `csv.parse`). `dryRun` : aperçu sans écriture.
 * `applyStock` : applique aussi la colonne de quantités au dépôt courant (écart tracé en « inventaire »).
 */
export function importCatalogue(db, ctx, rows, { dryRun = false, applyStock = false } = {}) {
  need(ctx, 'import');
  const depot = depotFor(db, ctx, ctx.depotId);
  if (rows.length > LIMITS.rows) fail(`Fichier trop volumineux : ${LIMITS.rows} lignes maximum.`);
  const report = { total: rows.length, created: 0, updated: 0, unchanged: 0, stockSet: 0, skipped: [] };
  const seen = new Map();
  const plan = [];
  for (const row of rows) {
    const line = row._line ?? 0;
    const ean = String(pick(row, ALIASES.ean)).trim();
    const name = clean(pick(row, ALIASES.name), LIMITS.name);
    if (!ean && !name) continue;
    if (!isCode(ean)) { report.skipped.push({ line, reason: `code « ${clean(ean, 20) || 'vide'} » invalide (8 à 14 chiffres)` }); continue; }
    if (!name) { report.skipped.push({ line, reason: 'désignation manquante' }); continue; }
    if (seen.has(ean)) { report.skipped.push({ line, reason: `doublon du code ${ean} (déjà ligne ${seen.get(ean)})` }); continue; }
    seen.set(ean, line);
    const priceRaw = pick(row, ALIASES.price), thrRaw = pick(row, ALIASES.threshold), stockRaw = pick(row, ALIASES.stock);
    const price = priceRaw === '' ? null : toMoney(priceRaw);
    const threshold = thrRaw === '' ? null : intIn(thrRaw, 0, 100000);
    if (price !== null && Number.isNaN(price)) { report.skipped.push({ line, reason: `prix « ${clean(priceRaw, 20)} » invalide` }); continue; }
    if (threshold !== null && Number.isNaN(threshold)) { report.skipped.push({ line, reason: `seuil « ${clean(thrRaw, 20)} » invalide` }); continue; }
    const qty = stockRaw === '' ? null : intIn(stockRaw, 0, LIMITS.maxStock);
    if (applyStock && qty !== null && Number.isNaN(qty)) { report.skipped.push({ line, reason: `quantité « ${clean(stockRaw, 20)} » invalide` }); continue; }
    plan.push({ ean, name, family: clean(pick(row, ALIASES.family), LIMITS.short), ref: clean(pick(row, ALIASES.ref), LIMITS.ref), price, threshold, qty: Number.isNaN(qty) ? null : qty });
  }
  for (const p of plan) {
    const a = db.articles[p.ean];
    const next = { name: p.name, family: p.family || a?.family || '', ref: p.ref || a?.ref || '', price: p.price ?? a?.price ?? 0, threshold: p.threshold ?? a?.threshold ?? 0 };
    const changed = !a || Object.keys(next).some((k) => a[k] !== next[k]);
    if (!a) report.created++; else if (changed) report.updated++; else report.unchanged++;
    const cur = stockOf(db, depot.id, p.ean);
    const willSet = applyStock && p.qty !== null && p.qty !== cur;
    if (willSet) report.stockSet++;
    if (dryRun) continue;
    if (changed) {
      db.articles[p.ean] = { ...(a ?? { locations: {}, photo: '' }), ean: p.ean, ...next };
      for (const id of Object.keys(db.depots)) (db.stocks[id] ??= {})[p.ean] ??= 0;
    }
    if (willSet) {
      setStock(db, depot.id, p.ean, p.qty);
      logMove(db, ctx, { ean: p.ean, name: p.name, type: 'inv', qty: p.qty, delta: p.qty - cur, depotId: depot.id, depotName: depot.name, note: 'Import CSV' });
    }
  }
  if (!dryRun) audit(db, ctx, 'admin', `Import catalogue : ${report.created} créé(s), ${report.updated} modifié(s)`, { created: report.created, updated: report.updated, skipped: report.skipped.length });
  return report;
}

/** Texte CSV brut → aperçu/import (raccourci pratique pour l'interface). */
export const importCatalogueText = (db, ctx, text, opts) => importCatalogue(db, ctx, parseCsv(text).rows, opts);

/** Pièces suggérées par l'IA → nouveaux articles (codes internes ; les EAN proposés par le modèle sont ignorés). */
export function importSuggestedParts(db, ctx, parts) {
  need(ctx, 'article.edit');
  depotFor(db, ctx, ctx.depotId);
  const created = [];
  for (const p of parts.slice(0, 50)) {
    const name = clean(p.name, LIMITS.name);
    if (!name) continue;
    const ean = nextInternalEan(Object.keys(db.articles));
    const threshold = Math.max(0, intIn(p.typical_threshold ?? p.threshold, 0, 100000, 5));
    db.articles[ean] = { ean, name, family: clean(p.family, LIMITS.short), ref: '', price: 0, threshold, photo: '', locations: {} };
    for (const id of Object.keys(db.depots)) (db.stocks[id] ??= {})[ean] ??= 0;
    created.push(ean);
  }
  audit(db, ctx, 'admin', `Import de ${created.length} pièce(s) suggérée(s) par l'analyse photo`, { count: created.length });
  return created;
}

