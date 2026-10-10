// Commandes internes (atelier → entrepôt central), commandes fournisseurs, fournisseurs, seuils par dépôt.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as o from '../../js/core/ops-orders.js';
import * as ops from '../../js/core/ops.js';
import { stockOf, reorderList, incomingQty, levelOf } from '../../js/core/queries.js';
import { NOW, IDS, EAN, ORG, orgDb, smallDb, ctxFor, expectOpError } from './helpers.js';

const DAY = 86_400_000;
const later = (ctx, days) => ({ ...ctx, now: new Date(NOW.getTime() + days * DAY) });
const order = (db, id) => db.orders[id];

test('panier de l\'atelier : quantités absolues, partagé, vidé = supprimé', () => {
  const db = orgDb();
  const julie = ctxFor(db, 'opParis');
  const r = o.setDraftLines(db, julie, { lines: [{ ean: EAN.zip, qty: 10 }, { ean: EAN.button, qty: '4' }] });
  assert.equal(r.lines, 2);
  assert.deepEqual(order(db, r.orderId).lines.map((l) => [l.ean, l.qty]), [[EAN.zip, 10], [EAN.button, 4]]);
  assert.equal(order(db, r.orderId).sourceId, ORG.central);
  // Un second appareil de l'atelier complète le MÊME panier sans écraser les autres lignes
  const sophie = ctxFor(db, 'mgrParis');
  assert.equal(o.setDraftLines(db, sophie, { lines: [{ ean: EAN.clasp, qty: 2 }, { ean: EAN.zip, qty: 12 }] }).orderId, r.orderId);
  assert.deepEqual(order(db, r.orderId).lines.map((l) => [l.ean, l.qty]), [[EAN.zip, 12], [EAN.button, 4], [EAN.clasp, 2]]);
  o.setDraftLines(db, julie, { lines: [{ ean: EAN.button, qty: 0 }] });
  assert.equal(order(db, r.orderId).lines.length, 2, 'quantité 0 = ligne retirée');
  o.setDraftLines(db, julie, { lines: [], replace: true });
  assert.equal(order(db, r.orderId), undefined, 'panier vide supprimé');
  // Garde-fous
  expectOpError(() => o.setDraftLines(db, julie, { lines: [{ ean: '12345670', qty: 1 }] }), /inconnu/);
  expectOpError(() => o.setDraftLines(db, julie, { lines: [{ ean: EAN.zip, qty: -1 }] }), /Quantité invalide/);
  expectOpError(() => o.setDraftLines(db, julie, { lines: 'pas une liste' }), /invalide/);
  expectOpError(() => o.setDraftLines(db, ctxFor(db, 'lea'), { lines: [{ ean: EAN.zip, qty: 1 }] }), /fournisseurs/, 'l\'entrepôt ne se commande pas à lui-même');
  expectOpError(() => o.setDraftLines(smallDb(), ctxFor(smallDb(), 'opParis'), { lines: [{ ean: EAN.zip, qty: 1 }] }), /Aucun entrepôt central/);
});

test('cycle complet : envoi → préparation → expédition partielle + reliquat → réception avec écart', () => {
  const db = orgDb();
  const julie = ctxFor(db, 'opParis');
  const { orderId } = o.setDraftLines(db, julie, { lines: [{ ean: EAN.zip, qty: 30 }, { ean: EAN.button, qty: 20 }] });
  const sent = o.submitOrder(db, julie, { id: orderId, note: 'Urgent' });
  assert.equal(sent.no, 1);
  assert.equal(order(db, orderId).status, 'submitted');
  assert.equal(incomingQty(db, IDS.paris, EAN.zip), 30, 'commande envoyée = en route');
  // Préparation par l'entrepôt : prise en charge exclusive
  const lea = later(ctxFor(db, 'lea'), 1);
  o.claimOrder(db, lea, { id: orderId });
  assert.equal(order(db, orderId).status, 'picking');
  expectOpError(() => o.claimOrder(db, later(ctxFor(db, 'karim'), 1), { id: orderId }), /déjà en préparation par Léa Moreau/);
  expectOpError(() => o.shipOrder(db, lea, { id: orderId, lines: [{ ean: EAN.zip, qty: 31 }] }), /au plus la quantité demandée/);
  expectOpError(() => o.shipOrder(db, lea, { id: orderId, lines: [{ ean: EAN.button, qty: 16 }] }), /stock insuffisant à l'entrepôt \(15/);
  expectOpError(() => o.shipOrder(db, lea, { id: orderId, lines: [{ ean: EAN.clasp, qty: 1 }] }), /ne fait pas partie/);
  expectOpError(() => o.shipOrder(db, lea, { id: orderId, lines: [] }), /Aucune quantité préparée/);
  const shipped = o.shipOrder(db, lea, { id: orderId, lines: [{ ean: EAN.zip, qty: 30 }, { ean: EAN.button, qty: 15 }] });
  assert.equal(shipped.units, 45);
  assert.equal(stockOf(db, ORG.central, EAN.zip), 170);
  assert.equal(stockOf(db, ORG.central, EAN.button), 0);
  assert.equal(order(db, orderId).status, 'shipped');
  assert.equal(db.history[0].orderId, orderId);
  // Reliquat : les 5 boutons manquants deviennent une nouvelle commande envoyée
  const back = order(db, shipped.backorderId);
  assert.deepEqual([back.status, back.backorderOf, back.no, back.lines.map((l) => [l.ean, l.qty])], ['submitted', orderId, 2, [[EAN.button, 5]]]);
  assert.equal(incomingQty(db, IDS.paris, EAN.button), 20, '15 expédiés + 5 en reliquat');
  // Usage de l'entrepôt : les expéditions sont sa consommation
  assert.ok(Object.values(db.usage[ORG.central][EAN.zip]).reduce((a, b) => a + b, 0) === 30);
  // Réception : 1 zip manquant
  const recv = o.receiveOrder(db, later(julie, 2), { id: orderId, lines: [{ ean: EAN.zip, qty: 29 }] });
  assert.deepEqual([recv.units, recv.gaps], [44, 1]);
  assert.equal(stockOf(db, IDS.paris, EAN.zip), 20 + 29);
  assert.equal(stockOf(db, IDS.paris, EAN.button), 3 + 15, 'ligne absente = reçue comme expédiée');
  assert.deepEqual(order(db, orderId).lines.map((l) => [l.shipped, l.received]), [[30, 29], [15, 15]]);
  assert.equal(order(db, orderId).gaps, 1);
  assert.match(db.audit[0].action, /réceptionnée : 44 unité\(s\) — 1 écart/);
  expectOpError(() => o.receiveOrder(db, later(julie, 3), { id: orderId }), /déjà réceptionnée/);
});

test('droits et cloisonnement des commandes', () => {
  const db = orgDb();
  const julie = ctxFor(db, 'opParis');
  const { orderId } = o.setDraftLines(db, julie, { lines: [{ ean: EAN.zip, qty: 5 }] });
  expectOpError(() => o.submitOrder(db, ctxFor(db, 'opLyon'), { id: orderId }), /Accès refusé/, 'Lyon ne touche pas au panier de Paris');
  o.submitOrder(db, julie, { id: orderId });
  // Un atelier ne prépare pas une commande ; Lyon ne réceptionne pas celle de Paris
  expectOpError(() => o.claimOrder(db, ctxFor(db, 'mgrParis'), { id: orderId }), /Accès refusé/);
  expectOpError(() => o.shipOrder(db, ctxFor(db, 'mgrLyon'), { id: orderId, lines: [{ ean: EAN.zip, qty: 5 }] }), /Accès refusé/);
  o.shipOrder(db, ctxFor(db, 'lea'), { id: orderId, lines: [{ ean: EAN.zip, qty: 5 }] });
  expectOpError(() => o.receiveOrder(db, ctxFor(db, 'opLyon'), { id: orderId }), /Accès refusé/);
  // Identifiants piégés
  for (const id of ['__proto__', 'constructor', 'toString', '', null, 42, { id: 'x' }]) expectOpError(() => o.claimOrder(db, ctxFor(db, 'lea'), { id }), /introuvable/);
});

test('annulation (atelier) et refus motivé (entrepôt)', () => {
  const db = orgDb();
  const julie = ctxFor(db, 'opParis');
  const mk = () => { const { orderId } = o.setDraftLines(db, julie, { lines: [{ ean: EAN.zip, qty: 5 }] }); o.submitOrder(db, julie, { id: orderId }); return orderId; };
  const a = mk();
  expectOpError(() => o.cancelOrder(db, ctxFor(db, 'mgrLyon'), { id: a }), /Accès refusé/);
  o.cancelOrder(db, julie, { id: a });
  assert.equal(order(db, a).status, 'cancelled');
  assert.equal(incomingQty(db, IDS.paris, EAN.zip), 0);
  const b = mk();
  o.claimOrder(db, ctxFor(db, 'lea'), { id: b });
  expectOpError(() => o.cancelOrder(db, julie, { id: b }), /préparation a commencé/);
  expectOpError(() => o.cancelOrder(db, ctxFor(db, 'lea'), { id: b, reason: 'x' }), /non autorisée/, 'un opérateur de l\'entrepôt ne refuse pas');
  expectOpError(() => o.cancelOrder(db, ctxFor(db, 'karim'), { id: b }), /motif/);
  o.cancelOrder(db, ctxFor(db, 'karim'), { id: b, reason: 'Article arrêté' });
  assert.deepEqual([order(db, b).status, order(db, b).reason], ['cancelled', 'Article arrêté']);
  // Libération d'une préparation
  const c = mk();
  o.claimOrder(db, ctxFor(db, 'lea'), { id: c });
  o.releaseOrder(db, ctxFor(db, 'lea'), { id: c });
  assert.equal(order(db, c).status, 'submitted');
  assert.equal(order(db, c).pickedBy, undefined);
  // Un brouillon se supprime, il ne s'annule pas
  const { orderId: d } = o.setDraftLines(db, julie, { lines: [{ ean: EAN.zip, qty: 1 }] });
  expectOpError(() => o.cancelOrder(db, julie, { id: d }), /Supprimez le brouillon/);
  o.discardDraft(db, julie, { id: d });
  assert.equal(order(db, d), undefined);
});

test('réassort : tient compte de ce qui est en route et du conditionnement', () => {
  const db = orgDb();
  db.stocks[IDS.paris][EAN.zip] = 4; // seuil 10, max 20, conditionnement 10
  const row = reorderList(db, IDS.paris).find((r) => r.article.ean === EAN.zip);
  assert.deepEqual([row.min, row.max, row.incoming, row.suggested], [10, 20, 0, 20], '16 arrondis au conditionnement (10) → 20');
  const julie = ctxFor(db, 'opParis');
  const { orderId } = o.setDraftLines(db, julie, { lines: [{ ean: EAN.zip, qty: 20 }] });
  assert.ok(reorderList(db, IDS.paris).some((r) => r.article.ean === EAN.zip), 'le brouillon ne compte pas par défaut');
  assert.ok(!reorderList(db, IDS.paris, { withDraft: true }).some((r) => r.article.ean === EAN.zip), '…sauf pour proposer le panier');
  o.submitOrder(db, julie, { id: orderId });
  assert.ok(!reorderList(db, IDS.paris).some((r) => r.article.ean === EAN.zip), 'commande envoyée : plus suggéré');
});

test('fournisseurs : création, unicité, e-mail, suppression protégée', () => {
  const db = orgDb();
  const karim = ctxFor(db, 'karim');
  const s = o.saveSupplier(db, karim, { name: 'Maison Laiton', email: 'contact@laiton.example', leadDays: '14' });
  assert.equal(db.suppliers[s.id].leadDays, 14);
  expectOpError(() => o.saveSupplier(db, karim, { name: 'maison laiton' }), /déjà ce nom/);
  expectOpError(() => o.saveSupplier(db, karim, { name: 'X', email: 'pas un mail' }), /e-mail/);
  expectOpError(() => o.saveSupplier(db, karim, { name: 'X', leadDays: 999 }), /Délai/);
  expectOpError(() => o.saveSupplier(db, ctxFor(db, 'lea'), { name: 'X' }), /non autorisée/);
  ops.upsertArticle(db, karim, { ean: EAN.clasp, name: 'Fermoir clip', supplierId: s.id });
  expectOpError(() => ops.upsertArticle(db, karim, { ean: EAN.clasp, name: 'Fermoir clip', supplierId: 'inconnu00001' }), /Fournisseur inconnu/);
  o.deleteSupplier(db, karim, { id: s.id });
  assert.equal(db.articles[EAN.clasp].supplierId, '', 'articles détachés');
});

test('commande fournisseur : brouillon → envoi → réception partielle → soldée', () => {
  const db = orgDb();
  const karim = ctxFor(db, 'karim');
  expectOpError(() => o.savePurchaseDraft(db, ctxFor(db, 'mgrParis'), { supplierId: ORG.ykk, lines: [{ ean: EAN.zip, qty: 10 }] }), /depuis l'entrepôt central/);
  const { orderId } = o.savePurchaseDraft(db, karim, { supplierId: ORG.ykk, lines: [{ ean: EAN.zip, qty: 100, price: '1.55' }, { ean: EAN.button, qty: 50 }] });
  assert.deepEqual(order(db, orderId).lines.map((l) => l.price), [1.55, 1.2], 'prix saisi ou prix de la fiche');
  expectOpError(() => o.receivePurchase(db, karim, { id: orderId, lines: [{ ean: EAN.zip, qty: 1 }] }), /n'attend pas/);
  assert.equal(o.sendPurchase(db, karim, { id: orderId }).no, 1);
  assert.equal(incomingQty(db, ORG.central, EAN.zip), 100);
  const lea = later(ctxFor(db, 'lea'), 10);
  const r1 = o.receivePurchase(db, lea, { id: orderId, lines: [{ ean: EAN.zip, qty: 60 }] });
  assert.deepEqual([r1.units, r1.complete, order(db, orderId).status], [60, false, 'partial']);
  assert.equal(stockOf(db, ORG.central, EAN.zip), 260);
  assert.equal(db.history[0].reason, 'Réception fournisseur');
  // La réception fait partie de la commande : l'annuler comme une simple entrée désynchroniserait les quantités reçues
  expectOpError(() => ops.undoMovement(db, lea, { historyId: db.history[0].id }), /fait partie d'une commande/);
  assert.equal(stockOf(db, ORG.central, EAN.zip), 260, 'stock intact');
  assert.equal(incomingQty(db, ORG.central, EAN.zip), 40, 'reste à recevoir');
  expectOpError(() => o.receivePurchase(db, lea, { id: orderId, lines: [{ ean: EAN.zip, qty: 0 }] }), /au moins une quantité/);
  o.closePurchase(db, later(karim, 12), { id: orderId, reason: 'Fin de série' });
  assert.equal(order(db, orderId).status, 'closed');
  assert.equal(incomingQty(db, ORG.central, EAN.zip), 0);
  // Rien reçu → annulée
  const { orderId: b } = o.savePurchaseDraft(db, karim, { supplierId: ORG.ykk, lines: [{ ean: EAN.zip, qty: 10 }] });
  o.sendPurchase(db, karim, { id: b });
  o.closePurchase(db, karim, { id: b });
  assert.equal(order(db, b).status, 'cancelled');
});

test('seuils par dépôt : application, retour au seuil de la fiche, validations', () => {
  const db = orgDb();
  const sophie = ctxFor(db, 'mgrParis');
  o.setLevels(db, sophie, { items: [{ ean: EAN.zip, min: 6, max: 30 }] });
  assert.deepEqual(levelOf(db, IDS.paris, db.articles[EAN.zip]), { min: 6, max: 30, source: 'depot' });
  assert.equal(levelOf(db, IDS.lyon, db.articles[EAN.zip]).min, 10, 'Lyon inchangé');
  expectOpError(() => o.setLevels(db, sophie, { items: [{ ean: EAN.zip, min: 10, max: 5 }] }), /maximum/);
  expectOpError(() => o.setLevels(db, sophie, { depotId: IDS.lyon, items: [] }), /Accès refusé/);
  expectOpError(() => o.setLevels(db, ctxFor(db, 'opParis'), { items: [] }), /non autorisée/);
  o.setLevels(db, sophie, { items: [{ ean: EAN.zip, reset: true }] });
  assert.equal(levelOf(db, IDS.paris, db.articles[EAN.zip]).source, 'article');
  assert.equal(db.levels[IDS.paris], undefined, 'table vide supprimée');
});

test('consommation : sorties et expéditions comptées, annulations décomptées', () => {
  const db = orgDb();
  const julie = ctxFor(db, 'opParis');
  const r = ops.moveStock(db, julie, { type: 'out', ean: EAN.zip, qty: 4 });
  ops.moveStock(db, julie, { type: 'in', ean: EAN.zip, qty: 10 });
  const total = () => Object.values(db.usage[IDS.paris]?.[EAN.zip] ?? {}).reduce((a, b) => a + b, 0);
  assert.equal(total(), 4, 'une entrée n\'est pas une consommation');
  ops.undoMovement(db, julie, { historyId: r.historyId });
  assert.equal(total(), 0);
  assert.equal(db.usage[IDS.paris], undefined, 'données vides nettoyées');
  const t = ops.createTransfer(db, julie, { ean: EAN.zip, qty: 3, toDepotId: IDS.lyon });
  assert.equal(total(), 3);
  ops.cancelTransfer(db, julie, { id: t.transferId });
  assert.equal(total(), 0);
});

test('dépôts : un seul entrepôt central ; suppression bloquée par une commande en cours', () => {
  const db = orgDb();
  const admin = ctxFor(db, 'admin');
  expectOpError(() => ops.saveDepot(db, admin, { name: 'Second entrepôt', kind: 'central' }), /un seul entrepôt central/);
  expectOpError(() => ops.saveDepot(db, admin, { name: 'X', kind: 'hangar' }), /Type de dépôt/);
  const julie = ctxFor(db, 'opParis');
  const { orderId } = o.setDraftLines(db, julie, { lines: [{ ean: EAN.zip, qty: 5 }] });
  o.submitOrder(db, julie, { id: orderId });
  expectOpError(() => ops.saveDepot(db, admin, { id: ORG.central, name: 'Entrepôt central', kind: 'atelier' }), /commandes des ateliers sont en cours/);
  expectOpError(() => ops.deleteArticle(db, ctxFor(db, 'mgrParis'), { ean: EAN.clasp }), /unité/);
});
