// Opérations métier : SEUL endroit où le stock et les données de référence sont modifiés.
// (Commandes, fournisseurs et seuils : ops-orders.js.)
//
// Contrat de chaque opération `op(db, ctx, params)` :
//   1. vérifie permission, accès au dépôt et paramètres, et lève `OpError` AVANT toute mutation ;
//   2. mute ensuite `db` (jamais d'erreur attendue à ce stade) ;
//   3. journalise (historique de stock + audit) et retourne un résumé.
// `ctx = { user:{id,name,role,depotId}, depotId, now:Date, uid?, limits? }`.
// Les paramètres sont traités comme NON FIABLES (ils peuvent venir d'un appareil distant) : tout est validé.
import { LIMITS, ROLES, DEPOT_KINDS } from './config.js';
import { can, isStrongPinRecord, ADMIN_PIN_MIN } from './auth.js';
import { locCode, stockOf, totalStock, levelOf, isLow } from './queries.js';
import { isCode, nextInternalEan } from '../lib/ean.js';
import { isImageDataUrl } from '../lib/image.js';
import { toInt, intIn, toMoney } from '../lib/text.js';
import { parse as parseCsv } from '../lib/csv.js';
import {
  fail, own, obj, list, need, depotFor, centralDepot, clean, qtyOf, eanOf, newId, audit, logMove, setStock, addUsage,
} from './ops-kit.js';

/**
 * Trace de connexion, de déconnexion ou de verrouillage d'un compte (PIN erronés). `kind` borné : aucun texte
 * libre n'entre dans le journal par ce biais. Avec un serveur, seul le serveur l'émet (jamais un appareil).
 */
export function recordAuth(db, ctx, p) {
  const f = obj(p);
  if (f.kind === 'lockout') {
    const n = Math.min(1000, Math.max(0, toInt(f.failures) || 0));
    audit(db, ctx, 'login', `Compte verrouillé après ${n} PIN erronés : ${ctx.user.name}`, { role: ctx.user.role, failures: n });
    return;
  }
  const kind = f.kind === 'logout' ? 'logout' : 'login';
  audit(db, ctx, 'login', `${kind === 'login' ? 'Connexion' : 'Déconnexion'} de ${ctx.user.name}`, { role: ctx.user.role });
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
    loc = { id: newId(ctx), depotId, rack: p.rack, allee: p.allee, etagere: p.etagere, case: p.case, desc: '' };
    db.locations[loc.id] = loc;
    audit(db, ctx, 'admin', `Emplacement créé : ${p.code}`, { locId: loc.id }, depotId);
  }
  return loc;
}

function linkLoc(db, ean, depotId, locId, asDefault) {
  const a = db.articles[ean];
  const cur = (own(a.locations, depotId) ?? []).filter((id) => id !== locId);
  a.locations[depotId] = asDefault ? [locId, ...cur] : [...cur, locId];
}

// ── Articles ──
function articleFields(db, f, { keep = {} } = {}) {
  const name = clean(f.name, LIMITS.name);
  if (!name) fail('La désignation est obligatoire.');
  const price = f.price === '' || f.price == null ? 0 : toMoney(f.price);
  if (Number.isNaN(price) || price > 1_000_000) fail('Prix invalide (nombre positif).');
  const threshold = f.threshold === '' || f.threshold == null ? 0 : intIn(f.threshold, 0, 100000);
  if (Number.isNaN(threshold)) fail('Seuil d\'alerte invalide (entier ≥ 0).');
  let photo = keep.photo ?? '';
  if (f.photo !== undefined) {
    if (f.photo && !isImageDataUrl(f.photo)) fail('Photo invalide.');
    photo = f.photo || '';
  }
  const supplierId = f.supplierId === undefined ? (keep.supplierId ?? '') : String(f.supplierId ?? '');
  if (supplierId && !own(db.suppliers, supplierId)) fail('Fournisseur inconnu.');
  const pack = f.pack === undefined || f.pack === '' || f.pack === null ? (keep.pack ?? 1) : intIn(f.pack, 1, 10000);
  if (Number.isNaN(pack)) fail('Conditionnement invalide (entier de 1 à 10 000).');
  return {
    name, family: clean(f.family, LIMITS.short), ref: clean(f.ref, LIMITS.ref), price, threshold, photo,
    supplierId, supplierRef: f.supplierRef === undefined ? (keep.supplierRef ?? '') : clean(f.supplierRef, LIMITS.ref), pack,
  };
}

const initStocks = (db, ean) => { for (const id of Object.keys(db.depots)) (db.stocks[id] ??= {})[ean] ??= 0; };

/** `createOnly` : le formulaire « Nouvelle pièce » ne doit jamais écraser une pièce existante portant le même code. */
export function upsertArticle(db, ctx, p) {
  const f = obj(p);
  const ean = eanOf(f.ean);
  const existing = own(db.articles, ean);
  if (f.createOnly && existing) fail(`Ce code existe déjà : « ${existing.name} ». Ouvrez la fiche de cette pièce pour la modifier.`);
  need(ctx, existing ? 'article.edit' : 'article.create');
  const fields = articleFields(db, f, { keep: existing ?? {} });
  db.articles[ean] = { ...(existing ?? { locations: {} }), ean, ...fields };
  initStocks(db, ean);
  audit(db, ctx, 'admin', `Article ${existing ? 'modifié' : 'créé'} : ${fields.name}`, { ean });
  return { ean, created: !existing };
}

const CLOSED = ['received', 'cancelled', 'closed'];
const openOrderWith = (db, ean) => Object.values(db.orders).some((o) => !CLOSED.includes(o.status) && o.lines.some((l) => l.ean === ean));

export function deleteArticle(db, ctx, p) {
  need(ctx, 'article.edit');
  const ean = eanOf(typeof p === 'object' && p ? p.ean : p);
  const a = own(db.articles, ean);
  if (!a) fail('Article introuvable.', 'notfound');
  const units = totalStock(db, ean);
  if (units > 0) fail(`Suppression impossible : ${units} unité(s) en stock. Ramenez le stock à 0 d'abord.`);
  if (Object.values(db.transfers).some((t) => t.status === 'pending' && t.ean === ean)) fail('Suppression impossible : un transfert en cours concerne cet article.');
  if (openOrderWith(db, ean)) fail('Suppression impossible : une commande en cours contient cet article.');
  delete db.articles[ean];
  for (const m of Object.values(db.stocks)) delete m[ean];
  for (const m of Object.values(db.levels)) delete m[ean];
  audit(db, ctx, 'admin', `Article supprimé : ${a.name}`, { ean });
}

/** Rattache un emplacement (par code) à un article, éventuellement comme emplacement par défaut. */
export function setArticleLocation(db, ctx, p) {
  const { depotId = ctx.depotId, code, makeDefault = false } = obj(p);
  need(ctx, 'location.edit');
  depotFor(db, ctx, depotId);
  const ean = eanOf(obj(p).ean);
  if (!own(db.articles, ean)) fail('Article introuvable.', 'notfound');
  const loc = ensureLoc(db, ctx, depotId, code);
  linkLoc(db, ean, depotId, loc.id, makeDefault === true);
  audit(db, ctx, 'admin', `Emplacement ${locCode(loc)} associé à ${db.articles[ean].name}`, { ean }, depotId);
  return loc;
}

export function removeArticleLocation(db, ctx, p) {
  const { depotId = ctx.depotId, locId } = obj(p);
  need(ctx, 'location.edit');
  depotFor(db, ctx, depotId);
  const a = own(db.articles, eanOf(obj(p).ean));
  if (!a) fail('Article introuvable.', 'notfound');
  const next = (own(a.locations, depotId) ?? []).filter((id) => id !== locId);
  if (next.length) a.locations[depotId] = next; else delete a.locations[depotId];
}

// ── Mouvements ──
/**
 * Entrée ou sortie de stock. Crée l'article s'il est inconnu (nom facultatif → « Pièce <EAN> »).
 * @param {{type:'in'|'out', ean:string, qty:number|string, reason?:string, locCode?:string, article?:object}} p
 */
export function moveStock(db, ctx, p) {
  p = obj(p);
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
  const draft = obj(p.article);

  let created = false;
  let article = own(db.articles, ean);
  let edits = null;
  if (!article) {
    need(ctx, 'article.create');
    const f = articleFields(db, { ...draft, supplierId: undefined, name: clean(draft.name, LIMITS.name) || `Pièce ${ean}` });
    article = db.articles[ean] = { ean, ...f, locations: {} };
    initStocks(db, ean);
    audit(db, ctx, 'admin', `Article créé : ${article.name}`, { ean }, depot.id);
    created = true;
  } else if (p.article && can(ctx.user.role, 'article.edit')) {
    edits = articleFields(db, { ...article, ...draft, photo: undefined, supplierId: undefined }, { keep: article });
  }
  if (edits) Object.assign(article, edits);

  let locLabel = '';
  if (loc) {
    const l = ensureLoc(db, ctx, depot.id, loc.code);
    linkLoc(db, ean, depot.id, l.id, (own(article.locations, depot.id) ?? [])[0] === undefined || p.setDefaultLoc === true);
    locLabel = locCode(l);
  } else {
    const first = (own(article.locations, depot.id) ?? [])[0];
    if (first && own(db.locations, first)) locLabel = locCode(db.locations[first]);
  }

  setStock(db, depot.id, ean, next);
  if (p.type === 'out') addUsage(db, ctx, depot.id, ean, qty);
  const h = logMove(db, ctx, {
    ean, name: article.name, type: p.type, qty, delta: next - cur, depotId: depot.id, depotName: depot.name,
    ...(locLabel && { loc: locLabel }), ...(p.reason && { reason: clean(p.reason, 60) }),
  });
  audit(db, ctx, p.type, `${p.type === 'in' ? 'Entrée +' : 'Sortie −'}${qty} × ${article.name}`, { ean, qty, depotName: depot.name }, depot.id);
  return { historyId: h.id, ean, name: article.name, type: p.type, qty, stock: next, created, alert: isLow(levelOf(db, depot.id, article).min, next) };
}

/** Annule une entrée/sortie récente (contre-mouvement tracé ; l'historique n'est jamais réécrit). */
export function undoMovement(db, ctx, p) {
  need(ctx, 'move');
  const historyId = typeof p === 'object' && p ? p.historyId : p;
  const h = typeof historyId === 'string' ? db.history.find((x) => x.id === historyId) : undefined;
  if (!h) fail('Mouvement introuvable.', 'notfound');
  if (h.type !== 'in' && h.type !== 'out') fail('Seules les entrées et sorties peuvent être annulées.');
  // Une réception de commande fait partie d'un document (quantités reçues, écarts) : l'annuler ici
  // désynchroniserait la commande et le stock.
  if (h.orderId || h.transferId) fail('Ce mouvement fait partie d\'une commande ou d\'un transfert : corrigez le stock depuis la fiche de la pièce.');
  if (h.undone || h.undoOf) fail('Ce mouvement est déjà annulé ou est une annulation.');
  const depot = depotFor(db, ctx, h.depotId);
  if (h.operatorId !== ctx.user.id && !can(ctx.user.role, 'stock.adjust')) fail('Vous ne pouvez annuler que vos propres mouvements.', 'forbidden');
  if (ctx.now.getTime() - new Date(h.date).getTime() > LIMITS.undoWindowMs) fail('Délai d\'annulation dépassé : utilisez une correction de stock.');
  const cur = stockOf(db, depot.id, h.ean);
  const next = cur - h.delta;
  if (next < 0) fail('Annulation impossible : le stock a déjà été consommé.');
  if (next > LIMITS.maxStock) fail('Stock maximal dépassé.');
  setStock(db, depot.id, h.ean, next);
  if (h.type === 'out') addUsage(db, ctx, depot.id, h.ean, -h.qty, h.date);
  h.undone = true;
  logMove(db, ctx, { ean: h.ean, name: h.name, type: h.type === 'in' ? 'out' : 'in', qty: h.qty, delta: -h.delta, depotId: depot.id, depotName: depot.name, note: 'Annulation', undoOf: h.id });
  audit(db, ctx, h.type === 'in' ? 'out' : 'in', `Annulation de ${h.type === 'in' ? 'l\'entrée' : 'la sortie'} ${h.qty} × ${h.name}`, { ean: h.ean, qty: h.qty }, depot.id);
  return { ean: h.ean, stock: next };
}

/** Correction de stock (valeur absolue constatée). */
export function adjustStock(db, ctx, p) {
  const { qty, reason = '' } = obj(p);
  need(ctx, 'stock.adjust');
  const ean = eanOf(obj(p).ean);
  const a = own(db.articles, ean);
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
export function commitInventory(db, ctx, p) {
  const { depotId, lines, validator, signature = '' } = obj(p);
  need(ctx, 'inventory');
  const depot = depotFor(db, ctx, depotId);
  list(lines, 20000);
  if (!lines.length) fail('Aucune ligne à valider.');
  const validatorName = clean(obj(validator).name, LIMITS.short);
  if (!validatorName) fail('Responsable validant manquant.');
  const todo = [];
  for (const raw of lines) {
    const l = obj(raw);
    const ean = eanOf(l.ean);
    if (!own(db.articles, ean)) continue;
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
    logMove(db, ctx, { ean: l.ean, name: db.articles[l.ean].name, type: 'inv', qty: l.real, delta: l.real - cur, depotId: depot.id, depotName: depot.name, validatedBy: validatorName });
    corrections++;
  }
  audit(db, ctx, 'inv', `Inventaire validé par ${validatorName} — ${corrections} correction(s)`, {
    corrections, total: todo.length, conflicts, validator: validatorName, depotName: depot.name,
    ...(isImageDataUrl(signature) && { sig: signature }),
  }, depot.id);
  return { corrections, total: todo.length, conflicts };
}

// ── Transferts ──
export function createTransfer(db, ctx, p) {
  const { qty, toDepotId } = obj(p);
  need(ctx, 'transfer.create');
  const ean = eanOf(obj(p).ean);
  const n = qtyOf(qty);
  const from = depotFor(db, ctx, ctx.depotId);
  const to = own(db.depots, toDepotId);
  if (!to) fail('Choisissez un dépôt destinataire.');
  if (to.id === from.id) fail('Le dépôt destinataire doit être différent du dépôt source.');
  const a = own(db.articles, ean);
  if (!a) fail('Article inconnu : créez-le avant de le transférer.', 'notfound');
  const cur = stockOf(db, from.id, ean);
  if (cur < n) fail(`Stock insuffisant pour le transfert : ${cur} disponible(s), ${n} demandé(s).`);
  setStock(db, from.id, ean, cur - n);
  addUsage(db, ctx, from.id, ean, n);
  const tr = {
    id: newId(ctx), ean, name: a.name, qty: n, fromDepotId: from.id, fromDepotName: from.name, toDepotId: to.id, toDepotName: to.name,
    operator: ctx.user.name, operatorId: ctx.user.id, date: ctx.now.toISOString(), status: 'pending',
  };
  db.transfers[tr.id] = tr;
  logMove(db, ctx, { ean, name: a.name, type: 'transfer', qty: n, delta: -n, depotId: from.id, depotName: from.name, note: `→ ${to.name}`, transferId: tr.id });
  audit(db, ctx, 'transfer', `Transfert ${n} × ${a.name} → ${to.name}`, { ean, qty: n, fromDepot: from.name, toDepot: to.name }, from.id);
  return { transferId: tr.id, stock: cur - n };
}

function pendingTransfer(db, p) {
  const id = typeof p === 'object' && p ? p.id : p;
  const tr = own(db.transfers, id);
  if (!tr) fail('Transfert introuvable.', 'notfound');
  if (tr.status !== 'pending') fail('Ce transfert est déjà traité.');
  return tr;
}

export function receiveTransfer(db, ctx, p) {
  need(ctx, 'transfer.receive');
  const tr = pendingTransfer(db, p);
  const to = depotFor(db, ctx, tr.toDepotId);
  const cur = stockOf(db, to.id, tr.ean);
  if (cur + tr.qty > LIMITS.maxStock) fail('Stock maximal dépassé.');
  if (!own(db.articles, tr.ean)) fail('Article supprimé du catalogue : réception impossible.');
  setStock(db, to.id, tr.ean, cur + tr.qty);
  tr.status = 'done'; tr.receivedBy = ctx.user.name; tr.receivedDate = ctx.now.toISOString();
  logMove(db, ctx, { ean: tr.ean, name: tr.name, type: 'transfer_in', qty: tr.qty, delta: tr.qty, depotId: to.id, depotName: to.name, note: `← ${tr.fromDepotName}`, transferId: tr.id });
  audit(db, ctx, 'transfer', `Réception ${tr.qty} × ${tr.name} depuis ${tr.fromDepotName}`, { ean: tr.ean, qty: tr.qty }, to.id);
  return { stock: cur + tr.qty };
}

function returnToSender(db, ctx, tr, status, note) {
  const from = own(db.depots, tr.fromDepotId);
  if (!from) fail('Dépôt d\'origine supprimé : opération impossible.');
  const cur = stockOf(db, from.id, tr.ean);
  setStock(db, from.id, tr.ean, Math.min(LIMITS.maxStock, cur + tr.qty));
  addUsage(db, ctx, from.id, tr.ean, -tr.qty, tr.date);
  tr.status = status; tr.cancelledBy = ctx.user.name; tr.cancelledDate = ctx.now.toISOString();
  logMove(db, ctx, { ean: tr.ean, name: tr.name, type: 'transfer_cancel', qty: tr.qty, delta: tr.qty, depotId: from.id, depotName: from.name, note, transferId: tr.id });
  audit(db, ctx, 'transfer', `${note} : ${tr.qty} × ${tr.name}`, { ean: tr.ean, qty: tr.qty }, from.id);
}

/** Annulation par l'expéditeur (son auteur, ou un responsable du dépôt source). Le stock revient à la source. */
export function cancelTransfer(db, ctx, p) {
  const tr = pendingTransfer(db, p);
  depotFor(db, ctx, tr.fromDepotId);
  if (tr.operatorId !== ctx.user.id) need(ctx, 'transfer.cancel');
  returnToSender(db, ctx, tr, 'cancelled', 'Transfert annulé');
}

/** Refus par le destinataire (colis non reçu, erreur…). Le stock revient à la source. */
export function refuseTransfer(db, ctx, p) {
  need(ctx, 'transfer.receive');
  const tr = pendingTransfer(db, p);
  depotFor(db, ctx, tr.toDepotId);
  returnToSender(db, ctx, tr, 'refused', `Transfert refusé par ${ctx.user.name}`);
}

// ── Emplacements (administration) ──
export function saveLocation(db, ctx, p) {
  const { id, depotId, rack, allee, etagere, case: cas, desc } = obj(p);
  need(ctx, 'location.edit');
  const depot = depotFor(db, ctx, depotId);
  const parsed = parseLocCode([rack, allee, etagere, cas].map((s) => String(s ?? '').trim()).filter(Boolean).join('-'));
  const dup = findLoc(db, depot.id, parsed.code);
  if (dup && dup.id !== id) fail(`L'emplacement ${parsed.code} existe déjà dans ce dépôt.`);
  const existing = id ? own(db.locations, id) : null;
  if (id && !existing) fail('Emplacement introuvable.', 'notfound');
  if (existing && existing.depotId !== depot.id) fail('Un emplacement ne peut pas changer de dépôt.');
  const loc = { id: existing?.id ?? newId(ctx), depotId: depot.id, rack: parsed.rack, allee: parsed.allee, etagere: parsed.etagere, case: parsed.case, desc: clean(desc, LIMITS.short) };
  db.locations[loc.id] = loc;
  audit(db, ctx, 'admin', `Emplacement ${existing ? 'modifié' : 'créé'} : ${parsed.code}`, { locId: loc.id }, depot.id);
  return loc;
}

export function deleteLocation(db, ctx, p) {
  need(ctx, 'location.edit');
  const id = typeof p === 'object' && p ? p.id : p;
  const loc = own(db.locations, id);
  if (!loc) fail('Emplacement introuvable.', 'notfound');
  depotFor(db, ctx, loc.depotId);
  delete db.locations[id];
  for (const a of Object.values(db.articles)) {
    const arr = own(a.locations, loc.depotId);
    if (!arr) continue;
    const next = arr.filter((x) => x !== id);
    if (next.length) a.locations[loc.depotId] = next; else delete a.locations[loc.depotId];
  }
  audit(db, ctx, 'admin', `Emplacement supprimé : ${locCode(loc)}`, { locId: id }, loc.depotId);
}

// ── Dépôts ──
export function saveDepot(db, ctx, p) {
  const { id, name, location, code, kind = 'atelier' } = obj(p);
  need(ctx, 'depot.manage');
  const n = clean(name, LIMITS.short);
  if (!n) fail('Le nom du dépôt est obligatoire.');
  if (typeof kind !== 'string' || !Object.hasOwn(DEPOT_KINDS, kind)) fail('Type de dépôt invalide.');
  const c = clean(code, 10).toUpperCase();
  const existing = id ? own(db.depots, id) : null;
  if (id && !existing) fail('Dépôt introuvable.', 'notfound');
  if (Object.values(db.depots).some((d) => d.id !== id && d.name.toLowerCase() === n.toLowerCase())) fail('Un dépôt porte déjà ce nom.');
  if (c && Object.values(db.depots).some((d) => d.id !== id && d.code === c)) fail('Ce code de dépôt est déjà utilisé.');
  const central = centralDepot(db);
  if (kind === 'central' && central && central.id !== id) fail(`« ${central.name} » est déjà l'entrepôt central : un seul entrepôt central est possible.`);
  if (existing?.kind === 'central' && kind !== 'central' && Object.values(db.orders).some((o) => o.kind === 'internal' && o.sourceId === id && !CLOSED.includes(o.status) && o.status !== 'draft')) {
    fail('Des commandes des ateliers sont en cours auprès de cet entrepôt.');
  }
  const depotId = existing?.id ?? newId(ctx);
  db.depots[depotId] = { id: depotId, name: n, location: clean(location, LIMITS.short), code: c, kind };
  db.stocks[depotId] ??= {};
  audit(db, ctx, 'admin', `Dépôt ${existing ? 'modifié' : 'créé'} : ${n}`, { depotId }, depotId);
  return db.depots[depotId];
}

export function deleteDepot(db, ctx, p) {
  need(ctx, 'depot.manage');
  const id = typeof p === 'object' && p ? p.id : p;
  const d = own(db.depots, id);
  if (!d) fail('Dépôt introuvable.', 'notfound');
  if (Object.keys(db.depots).length <= 1) fail('Impossible de supprimer le dernier dépôt.');
  if (ctx.depotId === id) fail('Impossible de supprimer votre dépôt actif : changez de dépôt avant.');
  const users = Object.values(db.users).filter((u) => u.depotId === id);
  if (users.length) fail(`${users.length} utilisateur(s) sont rattachés à ce dépôt : réassignez-les d'abord.`);
  const units = Object.values(db.stocks[id] ?? {}).reduce((s, v) => s + v, 0);
  if (units > 0) fail(`Ce dépôt contient ${units} unité(s) : transférez ou corrigez le stock avant suppression.`);
  if (Object.values(db.transfers).some((t) => t.status === 'pending' && (t.fromDepotId === id || t.toDepotId === id))) fail('Des transferts en cours concernent ce dépôt.');
  if (Object.values(db.orders).some((o) => (o.depotId === id || o.sourceId === id) && !CLOSED.includes(o.status))) fail('Des commandes en cours concernent ce dépôt.');
  delete db.depots[id]; delete db.stocks[id]; delete db.levels[id]; delete db.usage[id];
  for (const l of Object.values(db.locations)) if (l.depotId === id) delete db.locations[l.id];
  for (const a of Object.values(db.articles)) if (own(a.locations, id)) delete a.locations[id];
  audit(db, ctx, 'admin', `Dépôt supprimé : ${d.name}`, {}, ctx.depotId);
}

// ── Utilisateurs ──
const adminCount = (db) => Object.values(db.users).filter((u) => u.role === 'admin').length;

/** `pin` : enregistrement déjà haché (voir auth.hashPin) ; null = conserver l'existant. */
export function saveUser(db, ctx, p) {
  const { id, name, role, depotId, pin } = obj(p);
  need(ctx, 'user.manage');
  const n = clean(name, LIMITS.short);
  if (!n) fail('Le nom est obligatoire.');
  if (typeof role !== 'string' || !Object.hasOwn(ROLES, role)) fail('Rôle invalide.');
  if (!own(db.depots, depotId)) fail('Dépôt invalide.');
  if (pin != null && !isStrongPinRecord(pin)) fail('PIN invalide.');
  const existing = id ? own(db.users, id) : null;
  if (id && !existing) fail('Utilisateur introuvable.', 'notfound');
  if (Object.values(db.users).some((u) => u.id !== id && u.name.toLowerCase() === n.toLowerCase())) fail('Un utilisateur porte déjà ce nom.');
  if (!existing && !pin) fail('Un PIN est obligatoire pour un nouvel utilisateur.');
  if (existing && existing.role === 'admin' && role !== 'admin' && adminCount(db) <= 1) fail('Il doit rester au moins un administrateur.');
  // Un administrateur a accès à tout : PIN plus long (les PIN existants plus courts restent valables jusqu'au prochain changement)
  if (role === 'admin' && pin && pin.len < ADMIN_PIN_MIN) fail(`Un administrateur doit avoir un PIN de ${ADMIN_PIN_MIN} chiffres ou plus.`);
  if (role === 'admin' && !pin && existing && existing.role !== 'admin' && !(existing.pin?.len >= ADMIN_PIN_MIN)) fail(`Pour nommer ${n} administrateur, saisissez un nouveau PIN de ${ADMIN_PIN_MIN} chiffres ou plus.`);
  const uidv = existing?.id ?? newId(ctx);
  db.users[uidv] = { id: uidv, name: n, role, depotId, pin: pin ?? existing.pin };
  if (pin && db.meta.demoPins) db.meta.demoPins = db.meta.demoPins.filter((x) => x.name.toLowerCase() !== n.toLowerCase());
  audit(db, ctx, 'admin', `Utilisateur ${existing ? 'modifié' : 'créé'} : ${n} (${ROLES[role].label})`, { userId: uidv });
  return { id: uidv, name: n, role, depotId };
}

export function deleteUser(db, ctx, p) {
  need(ctx, 'user.manage');
  const id = typeof p === 'object' && p ? p.id : p;
  const u = own(db.users, id);
  if (!u) fail('Utilisateur introuvable.', 'notfound');
  if (u.id === ctx.user.id) fail('Vous ne pouvez pas supprimer votre propre compte.');
  if (u.role === 'admin' && adminCount(db) <= 1) fail('Il doit rester au moins un administrateur.');
  delete db.users[id];
  audit(db, ctx, 'admin', `Utilisateur supprimé : ${u.name}`, {});
}

/** Changement de son propre PIN (l'ancien PIN a été vérifié par l'appelant). `p` : { pin } ou l'empreinte. */
export function changeOwnPin(db, ctx, p) {
  const pin = p && typeof p === 'object' && 'pin' in p ? p.pin : p;
  if (!isStrongPinRecord(pin)) fail('PIN invalide.');
  const u = own(db.users, ctx.user.id);
  if (!u) fail('Utilisateur introuvable.', 'notfound');
  if (u.role === 'admin' && pin.len < ADMIN_PIN_MIN) fail(`Un administrateur doit avoir un PIN de ${ADMIN_PIN_MIN} chiffres ou plus.`);
  u.pin = pin;
  if (db.meta.demoPins) db.meta.demoPins = db.meta.demoPins.filter((x) => x.name.toLowerCase() !== u.name.toLowerCase());
  audit(db, ctx, 'admin', `PIN modifié : ${u.name}`, {});
}

/** Réglages de l'organisation (verrouillage, délais et niveau de service des seuils, briefing). */
export function updateSettings(db, ctx, p) {
  const f = obj(p);
  need(ctx, 'data.manage');
  const s = db.meta.settings;
  const next = { ...s };
  const num = (key, min, max, label) => {
    if (f[key] === undefined) return;
    const v = intIn(f[key], min, max);
    if (Number.isNaN(v)) fail(`${label} invalide (${min} à ${max}).`);
    next[key] = v;
  };
  num('sessionMinutes', 0, 240, 'Durée de verrouillage');
  num('leadDaysInternal', 0, 60, 'Délai de livraison de l\'entrepôt');
  num('leadDaysSupplier', 0, 180, 'Délai fournisseur par défaut');
  num('coverDaysAtelier', 1, 120, 'Couverture des ateliers');
  num('coverDaysCentral', 1, 180, 'Couverture de l\'entrepôt');
  num('serviceLevel', 50, 99, 'Niveau de service');
  if (f.briefing !== undefined) next.briefing = f.briefing === true;
  db.meta.settings = next;
  const changed = Object.keys(next).filter((k) => next[k] !== s[k]);
  audit(db, ctx, 'admin', `Réglages modifiés : ${changed.join(', ') || 'aucun changement'}`, { minutes: next.sessionMinutes });
  return next;
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
  pack: ['pack', 'conditionnement', 'colisage', 'lot'],
  supplier: ['supplier', 'fournisseur'],
  supplierRef: ['supplierref', 'reffournisseur', 'referencefournisseur'],
};
const pick = (row, keys) => { for (const k of keys) if (Object.hasOwn(row, k) && String(row[k]).trim() !== '') return row[k]; return ''; };

/**
 * Importe des lignes CSV (déjà lues par `csv.parse`). `dryRun` : aperçu sans écriture.
 * `applyStock` : applique aussi la colonne de quantités au dépôt courant (écart tracé en « inventaire »).
 */
export function importCatalogue(db, ctx, rows, { dryRun = false, applyStock = false } = {}) {
  need(ctx, 'import');
  const depot = depotFor(db, ctx, ctx.depotId);
  if (!Array.isArray(rows)) fail('Fichier illisible.');
  if (rows.length > LIMITS.rows) fail(`Fichier trop volumineux : ${LIMITS.rows} lignes maximum.`);
  const report = { total: rows.length, created: 0, updated: 0, unchanged: 0, stockSet: 0, skipped: [] };
  const seen = new Map();
  const plan = [];
  for (const raw of rows) {
    const row = obj(raw);
    const line = Number.isInteger(row._line) ? row._line : 0;
    const ean = String(pick(row, ALIASES.ean)).trim();
    const name = clean(pick(row, ALIASES.name), LIMITS.name);
    if (!ean && !name) continue;
    if (!isCode(ean)) { report.skipped.push({ line, reason: `code « ${clean(ean, 20) || 'vide'} » invalide (8 à 14 chiffres)` }); continue; }
    if (!name) { report.skipped.push({ line, reason: 'désignation manquante' }); continue; }
    if (seen.has(ean)) { report.skipped.push({ line, reason: `doublon du code ${ean} (déjà ligne ${seen.get(ean)})` }); continue; }
    seen.set(ean, line);
    const priceRaw = pick(row, ALIASES.price), thrRaw = pick(row, ALIASES.threshold), stockRaw = pick(row, ALIASES.stock), packRaw = pick(row, ALIASES.pack);
    const price = priceRaw === '' ? null : toMoney(priceRaw);
    const threshold = thrRaw === '' ? null : intIn(thrRaw, 0, 100000);
    const pack = packRaw === '' ? null : intIn(packRaw, 1, 10000);
    if (price !== null && Number.isNaN(price)) { report.skipped.push({ line, reason: `prix « ${clean(priceRaw, 20)} » invalide` }); continue; }
    if (threshold !== null && Number.isNaN(threshold)) { report.skipped.push({ line, reason: `seuil « ${clean(thrRaw, 20)} » invalide` }); continue; }
    if (pack !== null && Number.isNaN(pack)) { report.skipped.push({ line, reason: `conditionnement « ${clean(packRaw, 20)} » invalide` }); continue; }
    const qty = stockRaw === '' ? null : intIn(stockRaw, 0, LIMITS.maxStock);
    if (applyStock && qty !== null && Number.isNaN(qty)) { report.skipped.push({ line, reason: `quantité « ${clean(stockRaw, 20)} » invalide` }); continue; }
    // Fournisseur désigné par son nom (colonne de l'export du catalogue) : il doit déjà exister
    const supplierName = clean(pick(row, ALIASES.supplier), LIMITS.short);
    const supplier = supplierName ? Object.values(db.suppliers).find((x) => x.name.toLowerCase() === supplierName.toLowerCase()) : null;
    if (supplierName && !supplier) { report.skipped.push({ line, reason: `fournisseur « ${supplierName} » inconnu (créez-le d'abord)` }); continue; }
    plan.push({ ean, name, family: clean(pick(row, ALIASES.family), LIMITS.short), ref: clean(pick(row, ALIASES.ref), LIMITS.ref), price, threshold, pack, qty: Number.isNaN(qty) ? null : qty,
      supplierId: supplier?.id ?? null, supplierRef: clean(pick(row, ALIASES.supplierRef), LIMITS.ref) });
  }
  for (const p of plan) {
    const a = own(db.articles, p.ean);
    const next = {
      name: p.name, family: p.family || a?.family || '', ref: p.ref || a?.ref || '', price: p.price ?? a?.price ?? 0, threshold: p.threshold ?? a?.threshold ?? 0, pack: p.pack ?? a?.pack ?? 1,
      supplierId: p.supplierId ?? a?.supplierId ?? '', supplierRef: p.supplierRef || a?.supplierRef || '',
    };
    const changed = !a || Object.keys(next).some((k) => a[k] !== next[k]);
    if (!a) report.created++; else if (changed) report.updated++; else report.unchanged++;
    const cur = stockOf(db, depot.id, p.ean);
    const willSet = applyStock === true && p.qty !== null && p.qty !== cur;
    if (willSet) report.stockSet++;
    if (dryRun === true) continue;
    if (changed) {
      db.articles[p.ean] = { ...(a ?? { locations: {}, photo: '', supplierId: '', supplierRef: '' }), ean: p.ean, ...next };
      initStocks(db, p.ean);
    }
    if (willSet) {
      setStock(db, depot.id, p.ean, p.qty);
      logMove(db, ctx, { ean: p.ean, name: p.name, type: 'inv', qty: p.qty, delta: p.qty - cur, depotId: depot.id, depotName: depot.name, note: 'Import CSV' });
    }
  }
  if (dryRun !== true) audit(db, ctx, 'admin', `Import catalogue : ${report.created} créé(s), ${report.updated} modifié(s)`, { created: report.created, updated: report.updated, skipped: report.skipped.length });
  return report;
}

/** Texte CSV brut → aperçu/import (raccourci pratique pour l'interface). */
export const importCatalogueText = (db, ctx, text, opts) => importCatalogue(db, ctx, parseCsv(text).rows, opts);

/** Pièces suggérées par l'IA → nouveaux articles (codes internes ; les EAN proposés par le modèle sont ignorés). */
export function importSuggestedParts(db, ctx, parts) {
  need(ctx, 'article.edit');
  depotFor(db, ctx, ctx.depotId);
  if (!Array.isArray(parts)) fail('Liste de pièces invalide.');
  const created = [];
  for (const raw of parts.slice(0, 50)) {
    const p = obj(raw);
    const name = clean(p.name, LIMITS.name);
    if (!name) continue;
    const ean = nextInternalEan(Object.keys(db.articles));
    const threshold = Math.max(0, intIn(p.typical_threshold ?? p.threshold, 0, 100000, 5));
    db.articles[ean] = { ean, name, family: clean(p.family, LIMITS.short), ref: '', price: 0, threshold, photo: '', supplierId: '', supplierRef: '', pack: 1, locations: {} };
    initStocks(db, ean);
    created.push(ean);
  }
  audit(db, ctx, 'admin', `Import de ${created.length} pièce(s) suggérée(s) par l'analyse photo`, { count: created.length });
  return created;
}
