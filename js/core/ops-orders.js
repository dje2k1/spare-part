// Opérations : approvisionnement des ateliers par l'entrepôt central, commandes fournisseurs, seuils par dépôt.
//
// Commande interne (atelier → entrepôt central)
//   brouillon (panier partagé de l'atelier) → envoyée → en préparation (prise en charge par un préparateur)
//   → expédiée (le stock quitte l'entrepôt, reliquat éventuel = nouvelle commande) → reçue (écarts tracés)
//   Annulation possible tant que la préparation n'a pas commencé ; l'entrepôt peut refuser avec un motif.
// Commande fournisseur (entrepôt central → fournisseur)
//   brouillon → envoyée → reçue en partie / reçue → soldée (reste abandonné) ou annulée.
import { LIMITS, ORDER_LIMITS } from './config.js';
import { can } from './auth.js';
import { stockOf } from './queries.js';
import { intIn } from '../lib/text.js';
import {
  fail, own, obj, list, need, depotFor, centralDepot, clean, qtyOf, qty0, eanOf, newId, audit, logMove, setStock, addUsage,
} from './ops-kit.js';

const orderLabel = (o) => `${o.kind === 'supplier' ? 'ACH' : 'CMD'} ${o.no || '—'}`;

function orderOf(db, p, kind) {
  const id = typeof p === 'object' && p ? p.id : p;
  const o = own(db.orders, id);
  if (!o || o.kind !== kind) fail('Commande introuvable.', 'notfound');
  return o;
}

/** Lignes {ean, qty} validées (articles existants, sans doublon). */
function readLines(db, raw, { allowZero = false, max = ORDER_LIMITS.lines } = {}) {
  list(raw, max);
  const out = new Map();
  for (const r of raw) {
    const l = obj(r);
    const ean = eanOf(l.ean);
    const a = own(db.articles, ean);
    if (!a) fail(`Article ${ean} inconnu du catalogue.`, 'notfound');
    const qty = allowZero ? qty0(l.qty) : qtyOf(l.qty);
    out.set(ean, { ean, name: a.name, qty, price: l.price });
  }
  return [...out.values()];
}

// ── Fournisseurs ──
export function saveSupplier(db, ctx, p) {
  const { id, name, email = '', phone = '', note = '', leadDays = '' } = obj(p);
  need(ctx, 'supplier.manage');
  const n = clean(name, LIMITS.short);
  if (!n) fail('Le nom du fournisseur est obligatoire.');
  const existing = id ? own(db.suppliers, id) : null;
  if (id && !existing) fail('Fournisseur introuvable.', 'notfound');
  if (Object.values(db.suppliers).some((s) => s.id !== id && s.name.toLowerCase() === n.toLowerCase())) fail('Un fournisseur porte déjà ce nom.');
  const mail = clean(email, 120);
  if (mail && !/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(mail)) fail('Adresse e-mail invalide.');
  const lead = leadDays === '' || leadDays === null ? null : intIn(leadDays, 0, 365);
  if (Number.isNaN(lead)) fail('Délai de livraison invalide (0 à 365 jours).');
  const sid = existing?.id ?? newId(ctx);
  db.suppliers[sid] = { id: sid, name: n, email: mail, phone: clean(phone, 30), note: clean(note, 200), leadDays: lead };
  audit(db, ctx, 'admin', `Fournisseur ${existing ? 'modifié' : 'créé'} : ${n}`, { supplierId: sid });
  return db.suppliers[sid];
}

export function deleteSupplier(db, ctx, p) {
  need(ctx, 'supplier.manage');
  const id = typeof p === 'object' && p ? p.id : p;
  const s = own(db.suppliers, id);
  if (!s) fail('Fournisseur introuvable.', 'notfound');
  if (Object.values(db.orders).some((o) => o.kind === 'supplier' && o.supplierId === id && ['draft', 'sent', 'partial'].includes(o.status))) fail('Des commandes en cours concernent ce fournisseur.');
  delete db.suppliers[id];
  for (const a of Object.values(db.articles)) if (a.supplierId === id) a.supplierId = '';
  audit(db, ctx, 'admin', `Fournisseur supprimé : ${s.name}`, {});
}

// ── Seuils par dépôt (application des seuils intelligents ou saisie manuelle) ──
/** `items` : [{ean, min, max}] ou [{ean, reset:true}] (retour au seuil de la fiche article). */
export function setLevels(db, ctx, p) {
  const { depotId = ctx.depotId, items } = obj(p);
  need(ctx, 'levels.manage');
  const depot = depotFor(db, ctx, depotId);
  list(items, 10000, 'articles');
  const plan = items.map((r) => {
    const it = obj(r);
    const ean = eanOf(it.ean);
    if (!own(db.articles, ean)) fail(`Article ${ean} inconnu du catalogue.`, 'notfound');
    if (it.reset === true) return { ean, reset: true };
    const min = intIn(it.min, 0, LIMITS.maxStock);
    const max = intIn(it.max, 0, LIMITS.maxStock);
    if (Number.isNaN(min) || Number.isNaN(max)) fail(`Seuils invalides pour ${db.articles[ean].name}.`);
    if (max < min) fail(`Le maximum doit être supérieur ou égal au seuil pour ${db.articles[ean].name}.`);
    return { ean, min, max };
  });
  const map = (db.levels[depot.id] ??= {});
  for (const l of plan) {
    if (l.reset) delete map[l.ean]; else map[l.ean] = { min: l.min, max: l.max };
  }
  if (!Object.keys(map).length) delete db.levels[depot.id];
  audit(db, ctx, 'admin', `Seuils mis à jour : ${plan.length} article(s) — ${depot.name}`, { count: plan.length }, depot.id);
  return { count: plan.length };
}

// ── Commandes internes (atelier → entrepôt central) ──
const draftOf = (db, depotId) => Object.values(db.orders).find((o) => o.kind === 'internal' && o.status === 'draft' && o.depotId === depotId) ?? null;

function requester(db, ctx) {
  need(ctx, 'order.request');
  const depot = depotFor(db, ctx, ctx.depotId);
  if (depot.kind === 'central') fail('L\'entrepôt central s\'approvisionne auprès des fournisseurs (commandes fournisseurs).');
  const central = centralDepot(db);
  if (!central) fail('Aucun entrepôt central n\'est défini : demandez à un administrateur de le désigner.');
  return { depot, central };
}

/**
 * Panier de l'atelier (brouillon partagé par tous ses appareils). Chaque ligne fixe une quantité ABSOLUE
 * (0 = retirer) : deux personnes qui complètent le panier en même temps ne s'écrasent pas.
 * `replace` : vide d'abord le panier.
 */
export function setDraftLines(db, ctx, p) {
  const { lines, replace = false, note } = obj(p);
  const { depot, central } = requester(db, ctx);
  const items = readLines(db, lines, { allowZero: true });
  let o = draftOf(db, depot.id);
  const next = new Map(replace === true || !o ? [] : o.lines.map((l) => [l.ean, l]));
  for (const l of items) {
    if (l.qty === 0) next.delete(l.ean); else next.set(l.ean, { ean: l.ean, name: l.name, qty: l.qty });
  }
  if (next.size > ORDER_LIMITS.lines) fail(`Une commande compte au plus ${ORDER_LIMITS.lines} lignes.`);
  if (!next.size) {
    if (o) delete db.orders[o.id];
    return { orderId: null, lines: 0 };
  }
  if (!o) {
    o = { id: newId(ctx), kind: 'internal', no: 0, status: 'draft', depotId: depot.id, sourceId: central.id, lines: [], createdAt: ctx.now.toISOString(), createdBy: ctx.user.name };
    db.orders[o.id] = o;
  }
  o.lines = [...next.values()];
  o.sourceId = central.id;
  if (note !== undefined) o.note = clean(note, 200);
  return { orderId: o.id, lines: o.lines.length };
}

export function submitOrder(db, ctx, p) {
  const { note } = obj(p);
  const { central } = requester(db, ctx);
  const o = orderOf(db, p, 'internal');
  depotFor(db, ctx, o.depotId);
  if (o.status !== 'draft') fail('Cette commande a déjà été envoyée.');
  const lines = o.lines.filter((l) => own(db.articles, l.ean) && l.qty > 0);
  if (!lines.length) fail('La commande est vide.');
  o.lines = lines.map((l) => ({ ean: l.ean, name: db.articles[l.ean].name, qty: l.qty }));
  o.sourceId = central.id;
  o.no = ++db.meta.orderSeq;
  o.status = 'submitted';
  o.submittedAt = ctx.now.toISOString();
  o.submittedBy = ctx.user.name;
  if (note !== undefined) o.note = clean(note, 200);
  audit(db, ctx, 'order', `Commande ${orderLabel(o)} envoyée à ${central.name} : ${o.lines.length} ligne(s)`, { orderId: o.id, lines: o.lines.length }, o.depotId);
  return { orderId: o.id, no: o.no };
}

export function discardDraft(db, ctx, p) {
  need(ctx, 'order.request');
  const o = orderOf(db, p, 'internal');
  depotFor(db, ctx, o.depotId);
  if (o.status !== 'draft') fail('Seul un brouillon peut être supprimé.');
  delete db.orders[o.id];
}

/**
 * Annulation par l'atelier (son auteur ou un responsable, avant le début de la préparation),
 * ou refus par l'entrepôt central (responsable, avec motif) tant que rien n'est expédié.
 */
export function cancelOrder(db, ctx, p) {
  const { reason = '' } = obj(p);
  const o = orderOf(db, p, 'internal');
  if (!['submitted', 'picking'].includes(o.status)) fail(o.status === 'draft' ? 'Supprimez le brouillon plutôt.' : 'Cette commande ne peut plus être annulée.');
  const atCentral = ctx.user.depotId === o.sourceId || (can(ctx.user.role, 'depot.any') && ctx.depotId === o.sourceId);
  if (atCentral) {
    need(ctx, 'order.manage');
    depotFor(db, ctx, o.sourceId);
    if (!clean(reason, 200)) fail('Indiquez le motif du refus : il sera affiché à l\'atelier.');
  } else {
    depotFor(db, ctx, o.depotId);
    if (o.status === 'picking') fail('La préparation a commencé : contactez l\'entrepôt central.');
    if (o.submittedBy !== ctx.user.name) need(ctx, 'order.manage');
  }
  o.status = 'cancelled';
  o.cancelledAt = ctx.now.toISOString();
  o.cancelledBy = ctx.user.name;
  if (clean(reason, 200)) o.reason = clean(reason, 200);
  delete o.pickedBy;
  audit(db, ctx, 'order', `Commande ${orderLabel(o)} ${atCentral ? 'refusée par l\'entrepôt' : 'annulée'}${o.reason ? ` : ${o.reason}` : ''}`, { orderId: o.id }, atCentral ? o.sourceId : o.depotId);
}

function fulfiller(db, ctx, o) {
  need(ctx, 'order.fulfil');
  const central = depotFor(db, ctx, o.sourceId);
  if (central.kind !== 'central') fail('Seul l\'entrepôt central prépare les commandes.');
  return central;
}

/** Prise en charge par un préparateur : évite que deux personnes préparent la même commande. */
export function claimOrder(db, ctx, p) {
  const o = orderOf(db, p, 'internal');
  fulfiller(db, ctx, o);
  if (o.status === 'picking' && o.pickedBy !== ctx.user.name) fail(`Commande déjà en préparation par ${o.pickedBy}.`);
  if (o.status !== 'submitted' && o.status !== 'picking') fail('Cette commande n\'est pas à préparer.');
  o.status = 'picking';
  o.pickedBy = ctx.user.name;
  o.pickingAt = ctx.now.toISOString();
  return { orderId: o.id };
}

export function releaseOrder(db, ctx, p) {
  const o = orderOf(db, p, 'internal');
  fulfiller(db, ctx, o);
  if (o.status !== 'picking') fail('Cette commande n\'est pas en préparation.');
  if (o.pickedBy !== ctx.user.name) need(ctx, 'order.manage');
  o.status = 'submitted';
  delete o.pickedBy;
  delete o.pickingAt;
}

/**
 * Expédition : `lines` = quantités préparées ({ean, qty}, au plus la quantité demandée, 0 = non fournie).
 * Le stock quitte l'entrepôt et part « en transit ». `backorder` (par défaut) : ce qui manque devient
 * une nouvelle commande envoyée (reliquat), sans rien ressaisir.
 */
export function shipOrder(db, ctx, p) {
  const { lines, backorder = true } = obj(p);
  const o = orderOf(db, p, 'internal');
  const central = fulfiller(db, ctx, o);
  if (o.status !== 'submitted' && o.status !== 'picking') fail('Cette commande n\'est pas à expédier.');
  if (o.status === 'picking' && o.pickedBy !== ctx.user.name && !can(ctx.user.role, 'order.manage')) fail(`Commande en préparation par ${o.pickedBy}.`);
  const atelier = own(db.depots, o.depotId);
  if (!atelier) fail('Atelier destinataire supprimé.');
  const given = new Map(readLines(db, lines, { allowZero: true }).map((l) => [l.ean, l.qty]));
  for (const ean of given.keys()) if (!o.lines.some((l) => l.ean === ean)) fail(`${db.articles[ean].name} ne fait pas partie de la commande.`);
  const plan = o.lines.map((l) => {
    const s = given.get(l.ean) ?? 0;
    if (s > l.qty) fail(`${l.name} : ${s} préparé(s) pour ${l.qty} demandé(s). Expédiez au plus la quantité demandée.`);
    if (s > 0 && !own(db.articles, l.ean)) fail(`${l.name} a été supprimé du catalogue.`);
    const cur = stockOf(db, central.id, l.ean);
    if (s > cur) fail(`${l.name} : stock insuffisant à l'entrepôt (${cur} disponible(s), ${s} préparé(s)).`);
    return { line: l, s, cur };
  });
  const units = plan.reduce((n, x) => n + x.s, 0);
  if (!units) fail('Aucune quantité préparée : refusez la commande si rien n\'est disponible.');

  for (const { line, s, cur } of plan) {
    line.shipped = s;
    if (!s) continue;
    setStock(db, central.id, line.ean, cur - s);
    addUsage(db, ctx, central.id, line.ean, s);
    logMove(db, ctx, { ean: line.ean, name: line.name, type: 'transfer', qty: s, delta: -s, depotId: central.id, depotName: central.name, note: `→ ${atelier.name} · ${orderLabel(o)}`, orderId: o.id });
  }
  o.status = 'shipped';
  o.shippedAt = ctx.now.toISOString();
  o.shippedBy = ctx.user.name;
  delete o.pickedBy;

  let backorderId = null;
  const rest = plan.filter((x) => x.s < x.line.qty).map((x) => ({ ean: x.line.ean, name: x.line.name, qty: x.line.qty - x.s }));
  if (backorder !== false && rest.length) {
    const b = {
      id: newId(ctx), kind: 'internal', no: ++db.meta.orderSeq, status: 'submitted', depotId: o.depotId, sourceId: o.sourceId, lines: rest,
      createdAt: ctx.now.toISOString(), createdBy: ctx.user.name, submittedAt: ctx.now.toISOString(), submittedBy: o.submittedBy || ctx.user.name,
      backorderOf: o.id, note: `Reliquat de la commande ${orderLabel(o)}`,
    };
    db.orders[b.id] = b;
    backorderId = b.id;
  }
  audit(db, ctx, 'order', `Commande ${orderLabel(o)} expédiée à ${atelier.name} : ${units} unité(s)${backorderId ? `, reliquat ${rest.length} ligne(s)` : ''}`, { orderId: o.id, units }, central.id);
  return { orderId: o.id, units, backorderId };
}

/**
 * Réception à l'atelier : `lines` = quantités réellement reçues ({ean, qty}). Une ligne absente
 * vaut « reçu comme expédié ». Les écarts (manquants, surplus) sont tracés sur la commande et au journal.
 */
export function receiveOrder(db, ctx, p) {
  const { lines = [] } = obj(p);
  need(ctx, 'order.receive');
  const o = orderOf(db, p, 'internal');
  const atelier = depotFor(db, ctx, o.depotId);
  if (o.status !== 'shipped') fail(o.status === 'received' ? 'Cette commande est déjà réceptionnée.' : 'Cette commande n\'est pas encore expédiée.');
  const given = new Map(readLines(db, lines, { allowZero: true }).map((l) => [l.ean, l.qty]));
  const central = own(db.depots, o.sourceId);
  const plan = o.lines.map((l) => {
    const r = given.has(l.ean) ? given.get(l.ean) : (l.shipped ?? 0);
    const cur = stockOf(db, atelier.id, l.ean);
    if (r > 0 && !own(db.articles, l.ean)) fail(`${l.name} a été supprimé du catalogue : réception impossible.`);
    if (cur + r > LIMITS.maxStock) fail('Stock maximal dépassé.');
    return { line: l, r, cur };
  });
  let units = 0, gaps = 0;
  for (const { line, r, cur } of plan) {
    line.received = r;
    if (r !== (line.shipped ?? 0)) gaps++;
    if (!r) continue;
    units += r;
    setStock(db, atelier.id, line.ean, cur + r);
    logMove(db, ctx, { ean: line.ean, name: line.name, type: 'transfer_in', qty: r, delta: r, depotId: atelier.id, depotName: atelier.name, note: `← ${central?.name ?? 'Entrepôt'} · ${orderLabel(o)}`, orderId: o.id });
  }
  o.status = 'received';
  o.receivedAt = ctx.now.toISOString();
  o.receivedBy = ctx.user.name;
  o.gaps = gaps;
  audit(db, ctx, 'order', `Commande ${orderLabel(o)} réceptionnée : ${units} unité(s)${gaps ? ` — ${gaps} écart(s)` : ''}`, { orderId: o.id, units, gaps }, atelier.id);
  return { orderId: o.id, units, gaps };
}

// ── Commandes fournisseurs (entrepôt central) ──
function buyer(db, ctx) {
  need(ctx, 'purchase.manage');
  const depot = depotFor(db, ctx, ctx.depotId);
  if (depot.kind !== 'central') fail('Les commandes fournisseurs se passent depuis l\'entrepôt central.');
  return depot;
}

export function savePurchaseDraft(db, ctx, p) {
  const { id, supplierId, lines, note } = obj(p);
  const depot = buyer(db, ctx);
  const supplier = own(db.suppliers, supplierId);
  if (!supplier) fail('Choisissez un fournisseur.');
  const items = readLines(db, lines);
  if (!items.length) fail('Ajoutez au moins une ligne.');
  const existing = id ? own(db.orders, id) : null;
  if (id && (!existing || existing.kind !== 'supplier')) fail('Commande introuvable.', 'notfound');
  if (existing && existing.status !== 'draft') fail('Cette commande a déjà été envoyée au fournisseur.');
  if (existing && existing.depotId !== depot.id) fail('Commande d\'un autre dépôt.', 'forbidden');
  const priced = items.map((l) => {
    const price = l.price === undefined || l.price === '' || l.price === null ? db.articles[l.ean].price : Number(l.price);
    if (!Number.isFinite(price) || price < 0 || price > 1_000_000) fail(`Prix invalide pour ${l.name}.`);
    return { ean: l.ean, name: l.name, qty: l.qty, price: Math.round(price * 100) / 100 };
  });
  const o = existing ?? { id: newId(ctx), kind: 'supplier', no: 0, status: 'draft', depotId: depot.id, createdAt: ctx.now.toISOString(), createdBy: ctx.user.name };
  o.supplierId = supplier.id;
  o.lines = priced;
  if (note !== undefined) o.note = clean(note, 200);
  db.orders[o.id] = o;
  return { orderId: o.id };
}

export function deletePurchaseDraft(db, ctx, p) {
  const depot = buyer(db, ctx);
  const o = orderOf(db, p, 'supplier');
  if (o.depotId !== depot.id) fail('Commande d\'un autre dépôt.', 'forbidden');
  if (o.status !== 'draft') fail('Seul un brouillon peut être supprimé.');
  delete db.orders[o.id];
}

export function sendPurchase(db, ctx, p) {
  const depot = buyer(db, ctx);
  const o = orderOf(db, p, 'supplier');
  if (o.depotId !== depot.id) fail('Commande d\'un autre dépôt.', 'forbidden');
  if (o.status !== 'draft') fail('Cette commande a déjà été envoyée.');
  if (!o.lines.length) fail('La commande est vide.');
  if (!own(db.suppliers, o.supplierId)) fail('Fournisseur supprimé.');
  o.no = ++db.meta.purchaseSeq;
  o.status = 'sent';
  o.sentAt = ctx.now.toISOString();
  o.sentBy = ctx.user.name;
  audit(db, ctx, 'order', `Commande fournisseur ${orderLabel(o)} envoyée à ${db.suppliers[o.supplierId].name}`, { orderId: o.id, lines: o.lines.length }, depot.id);
  return { orderId: o.id, no: o.no };
}

/** Réception (partielle ou totale) d'une commande fournisseur. `lines` : quantités reçues ce jour. */
export function receivePurchase(db, ctx, p) {
  const { lines } = obj(p);
  need(ctx, 'order.receive');
  const o = orderOf(db, p, 'supplier');
  const depot = depotFor(db, ctx, o.depotId);
  if (o.status !== 'sent' && o.status !== 'partial') fail('Cette commande n\'attend pas de livraison.');
  const items = readLines(db, lines, { allowZero: true });
  for (const l of items) if (!o.lines.some((x) => x.ean === l.ean)) fail(`${l.name} ne fait pas partie de la commande.`);
  const plan = items.filter((l) => l.qty > 0).map((l) => {
    const cur = stockOf(db, depot.id, l.ean);
    if (cur + l.qty > LIMITS.maxStock) fail('Stock maximal dépassé.');
    return { ...l, cur };
  });
  if (!plan.length) fail('Saisissez au moins une quantité reçue.');
  const supplier = own(db.suppliers, o.supplierId);
  let units = 0;
  for (const l of plan) {
    const line = o.lines.find((x) => x.ean === l.ean);
    line.received = (line.received ?? 0) + l.qty;
    units += l.qty;
    setStock(db, depot.id, l.ean, l.cur + l.qty);
    logMove(db, ctx, { ean: l.ean, name: line.name, type: 'in', qty: l.qty, delta: l.qty, depotId: depot.id, depotName: depot.name, reason: 'Réception fournisseur', note: `${orderLabel(o)}${supplier ? ` · ${supplier.name}` : ''}`, orderId: o.id });
  }
  const complete = o.lines.every((l) => (l.received ?? 0) >= l.qty);
  o.status = complete ? 'received' : 'partial';
  if (complete) { o.receivedAt = ctx.now.toISOString(); o.receivedBy = ctx.user.name; }
  audit(db, ctx, 'order', `Réception fournisseur ${orderLabel(o)} : ${units} unité(s)${complete ? ' — commande soldée' : ''}`, { orderId: o.id, units }, depot.id);
  return { orderId: o.id, units, complete };
}

/** Clôture : le reste n'est plus attendu (soldée), ou annulation si rien n'a été reçu. */
export function closePurchase(db, ctx, p) {
  const { reason = '' } = obj(p);
  const depot = buyer(db, ctx);
  const o = orderOf(db, p, 'supplier');
  if (o.depotId !== depot.id) fail('Commande d\'un autre dépôt.', 'forbidden');
  if (o.status !== 'sent' && o.status !== 'partial') fail('Cette commande n\'est pas en cours.');
  const any = o.lines.some((l) => (l.received ?? 0) > 0);
  o.status = any ? 'closed' : 'cancelled';
  o[any ? 'receivedAt' : 'cancelledAt'] = ctx.now.toISOString();
  o[any ? 'receivedBy' : 'cancelledBy'] = ctx.user.name;
  if (clean(reason, 200)) o.reason = clean(reason, 200);
  audit(db, ctx, 'order', `Commande fournisseur ${orderLabel(o)} ${any ? 'soldée' : 'annulée'}`, { orderId: o.id }, depot.id);
}
