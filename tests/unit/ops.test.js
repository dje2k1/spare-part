import test from 'node:test';
import assert from 'node:assert/strict';
import * as ops from '../../js/core/ops.js';
import { stockOf, locCode, totalStock } from '../../js/core/queries.js';
import { LIMITS } from '../../js/core/config.js';
import { isImageDataUrl } from '../../js/lib/image.js';
import { NOW, IDS, EAN, FAKE_PIN, smallDb, ctxFor, expectOpError, prng } from './helpers.js';

const at = (ms) => new Date(NOW.getTime() + ms);

// ── moveStock ──
test('entrée : stock, historique (delta), audit, emplacement existant', () => {
  const db = smallDb();
  const r = ops.moveStock(db, ctxFor(db, 'opParis'), { type: 'in', ean: EAN.zip, qty: '5', reason: 'Réception fournisseur' });
  assert.equal(r.stock, 25);
  assert.equal(stockOf(db, IDS.paris, EAN.zip), 25);
  const h = db.history[0];
  assert.deepEqual([h.type, h.qty, h.delta, h.depotId, h.operator, h.operatorId, h.reason, h.loc], ['in', 5, 5, IDS.paris, 'Julie Laurent', IDS.opParis, 'Réception fournisseur', 'R1-A1-E1-C1']);
  assert.match(h.id, /^[0-9a-z]{20}$/);
  assert.equal(db.audit[0].type, 'in');
  assert.match(db.audit[0].action, /Entrée \+5 × Zip YKK 20cm/);
});

test('sortie : refuse si stock insuffisant, sans rien modifier', () => {
  const db = smallDb();
  const before = JSON.stringify(db);
  expectOpError(() => ops.moveStock(db, ctxFor(db, 'opParis'), { type: 'out', ean: EAN.zip, qty: 21 }), /Stock insuffisant : 20 disponible/);
  assert.equal(JSON.stringify(db), before);
  const r = ops.moveStock(db, ctxFor(db, 'opParis'), { type: 'out', ean: EAN.zip, qty: 20 });
  assert.equal(r.stock, 0);
  assert.equal(r.alert, true, 'sous le seuil d\'alerte');
});

test('quantités : seuls les entiers 1..1 000 000 sont acceptés', () => {
  const db = smallDb();
  const ctx = ctxFor(db, 'opParis');
  for (const bad of [0, -3, '1.5', '1e3', '', 'abc', null, undefined, NaN, LIMITS.maxQty + 1, '12abc']) {
    expectOpError(() => ops.moveStock(db, ctx, { type: 'in', ean: EAN.zip, qty: bad }), /Quantité invalide/);
  }
  assert.equal(stockOf(db, IDS.paris, EAN.zip), 20);
  assert.equal(ops.moveStock(db, ctx, { type: 'in', ean: EAN.zip, qty: LIMITS.maxQty }).stock, 20 + LIMITS.maxQty, 'borne haute acceptée');
  db.stocks[IDS.paris][EAN.zip] = LIMITS.maxStock - 5;
  expectOpError(() => ops.moveStock(db, ctx, { type: 'in', ean: EAN.zip, qty: 6 }), /Stock maximal/);
  assert.equal(ops.moveStock(db, ctx, { type: 'in', ean: EAN.zip, qty: 5 }).stock, LIMITS.maxStock);
});

test('codes invalides et types invalides refusés', () => {
  const db = smallDb();
  const ctx = ctxFor(db, 'opParis');
  for (const bad of ['', 'abc', '1234567', "1234');alert(1);//", '<img>', null]) expectOpError(() => ops.moveStock(db, ctx, { type: 'in', ean: bad, qty: 1 }), /Code invalide/);
  expectOpError(() => ops.moveStock(db, ctx, { type: 'transfer', ean: EAN.zip, qty: 1 }), /Type de mouvement/);
});

test('article inconnu : créé à l\'entrée (nom par défaut), refusé à la sortie', () => {
  const db = smallDb();
  const ctx = ctxFor(db, 'opParis');
  expectOpError(() => ops.moveStock(db, ctx, { type: 'out', ean: EAN.ghost, qty: 1 }), /Stock insuffisant/);
  assert.ok(!db.articles[EAN.ghost], 'aucune création sur une sortie refusée');
  const r = ops.moveStock(db, ctx, { type: 'in', ean: EAN.ghost, qty: 4 });
  assert.equal(r.created, true);
  assert.equal(db.articles[EAN.ghost].name, `Pièce ${EAN.ghost}`);
  assert.equal(stockOf(db, IDS.paris, EAN.ghost), 4);
  assert.equal(stockOf(db, IDS.lyon, EAN.ghost), 0, 'présent à 0 dans les autres dépôts');
  const r2 = ops.moveStock(db, ctx, { type: 'in', ean: '20000009', qty: 1, article: { name: 'Rivet <b>cuivre</b>', family: 'Rivets', price: '0,35', threshold: '10' } });
  assert.deepEqual([db.articles['20000009'].name, db.articles['20000009'].price, db.articles['20000009'].threshold], ['Rivet <b>cuivre</b>', 0.35, 10], 'stocké tel quel (échappé à l\'affichage)');
  assert.ok(r2.created);
});

test('emplacement saisi : créé, rattaché ; par défaut seulement si l\'article n\'en avait pas', () => {
  const db = smallDb();
  const ctx = ctxFor(db, 'opParis');
  ops.moveStock(db, ctx, { type: 'in', ean: EAN.button, qty: 2, locCode: ' r2-a3 e1 ' });
  const loc = Object.values(db.locations).find((l) => locCode(l) === 'R2-A3-E1');
  assert.ok(loc && loc.depotId === IDS.paris);
  assert.deepEqual(db.articles[EAN.button].locations[IDS.paris], [loc.id]);
  ops.moveStock(db, ctx, { type: 'in', ean: EAN.button, qty: 1, locCode: 'R1-A2-E1-C1' });
  assert.equal(db.articles[EAN.button].locations[IDS.paris].length, 2);
  assert.equal(db.articles[EAN.button].locations[IDS.paris][0], loc.id, 'le défaut ne change pas');
  ops.moveStock(db, ctx, { type: 'in', ean: EAN.button, qty: 1, locCode: 'R1-A2-E1-C1', setDefaultLoc: true });
  assert.equal(db.articles[EAN.button].locations[IDS.paris][0], IDS.locB);
  const n = Object.keys(db.locations).length;
  ops.moveStock(db, ctx, { type: 'in', ean: EAN.button, qty: 1, locCode: 'R1-A2-E1-C1' });
  assert.equal(Object.keys(db.locations).length, n, 'pas de doublon d\'emplacement');
  for (const bad of ['R1-A1-E1-C1-X9', 'R 1;DROP', '<x>', 'R1--A1', '   ', 'ÉTAGÈRE-1']) expectOpError(() => ops.moveStock(db, ctx, { type: 'in', ean: EAN.button, qty: 1, locCode: bad }), /Emplacement invalide/);
});

test('rôles : un opérateur ne modifie pas la fiche d\'un article existant ; un responsable si', () => {
  const db = smallDb();
  ops.moveStock(db, ctxFor(db, 'opParis'), { type: 'in', ean: EAN.zip, qty: 1, article: { name: 'PIRATÉ', price: '0', threshold: '0' } });
  assert.equal(db.articles[EAN.zip].name, 'Zip YKK 20cm');
  ops.moveStock(db, ctxFor(db, 'mgrParis'), { type: 'in', ean: EAN.zip, qty: 1, article: { name: 'Zip renommé', family: 'Zips', price: '2', threshold: '8' } });
  assert.equal(db.articles[EAN.zip].name, 'Zip renommé');
  assert.equal(db.articles[EAN.zip].threshold, 8);
});

test('cloisonnement des dépôts : un opérateur ne travaille que dans le sien ; l\'admin partout', () => {
  const db = smallDb();
  expectOpError(() => ops.moveStock(db, ctxFor(db, 'opParis', { depotId: IDS.lyon }), { type: 'in', ean: EAN.zip, qty: 1 }), /Accès refusé/);
  expectOpError(() => ops.moveStock(db, ctxFor(db, 'mgrParis', { depotId: IDS.lyon }), { type: 'in', ean: EAN.zip, qty: 1 }), /Accès refusé/);
  ops.moveStock(db, ctxFor(db, 'admin', { depotId: IDS.lyon }), { type: 'in', ean: EAN.zip, qty: 1 });
  assert.equal(stockOf(db, IDS.lyon, EAN.zip), 6);
  expectOpError(() => ops.moveStock(db, ctxFor(db, 'admin', { depotId: 'depotinconnu' }), { type: 'in', ean: EAN.zip, qty: 1 }), /introuvable/);
});

test('sans utilisateur ou rôle inconnu : refusé', () => {
  const db = smallDb();
  expectOpError(() => ops.moveStock(db, { user: null, depotId: IDS.paris, now: NOW }, { type: 'in', ean: EAN.zip, qty: 1 }), /non autorisée/);
  expectOpError(() => ops.moveStock(db, { user: { id: 'x', name: 'x', role: 'root', depotId: IDS.paris }, depotId: IDS.paris, now: NOW }, { type: 'in', ean: EAN.zip, qty: 1 }), /non autorisée/);
});

// ── Annulation ──
test('annulation : contre-mouvement tracé, original marqué, double annulation refusée', () => {
  const db = smallDb();
  const ctx = ctxFor(db, 'opParis');
  const { historyId } = ops.moveStock(db, ctx, { type: 'in', ean: EAN.zip, qty: 5 });
  const r = ops.undoMovement(db, ctx, historyId);
  assert.equal(r.stock, 20);
  assert.equal(db.history.find((h) => h.id === historyId).undone, true);
  const counter = db.history[0];
  assert.deepEqual([counter.type, counter.delta, counter.note, counter.undoOf], ['out', -5, 'Annulation', historyId]);
  expectOpError(() => ops.undoMovement(db, ctx, historyId), /déjà annulé/);
  expectOpError(() => ops.undoMovement(db, ctx, counter.id), /déjà annulé|annulation/);
  expectOpError(() => ops.undoMovement(db, ctx, 'inconnu00000'), /introuvable/);
});

test('annulation d\'une sortie, délai dépassé, stock consommé, propriété', () => {
  const db = smallDb();
  const op = ctxFor(db, 'opParis');
  const out = ops.moveStock(db, op, { type: 'out', ean: EAN.zip, qty: 4 });
  assert.equal(ops.undoMovement(db, op, out.historyId).stock, 20);

  const inn = ops.moveStock(db, op, { type: 'in', ean: EAN.button, qty: 2 }); // 3 → 5
  ops.moveStock(db, op, { type: 'out', ean: EAN.button, qty: 4 }); // 5 → 1
  expectOpError(() => ops.undoMovement(db, op, inn.historyId), /déjà été consommé/);

  const late = ops.moveStock(db, op, { type: 'in', ean: EAN.zip, qty: 1 });
  expectOpError(() => ops.undoMovement(db, { ...op, now: at(LIMITS.undoWindowMs + 1) }, late.historyId), /Délai/);

  expectOpError(() => ops.undoMovement(db, ctxFor(db, 'opParis', { now: NOW }), 'x'.repeat(20)), /introuvable/);
  const mine = ops.moveStock(db, ctxFor(db, 'mgrParis'), { type: 'in', ean: EAN.zip, qty: 1 });
  expectOpError(() => ops.undoMovement(db, op, mine.historyId), /vos propres mouvements/);
  assert.doesNotThrow(() => ops.undoMovement(db, ctxFor(db, 'mgrParis'), mine.historyId));
  const byOp = ops.moveStock(db, op, { type: 'in', ean: EAN.zip, qty: 1 });
  assert.doesNotThrow(() => ops.undoMovement(db, ctxFor(db, 'mgrParis'), byOp.historyId), 'un responsable peut annuler celui d\'un opérateur');
});

// ── Correction de stock ──
test('correction : responsable seulement, valeur absolue, tracée en « inv »', () => {
  const db = smallDb();
  expectOpError(() => ops.adjustStock(db, ctxFor(db, 'opParis'), { ean: EAN.zip, qty: 7 }), /non autorisée/);
  const r = ops.adjustStock(db, ctxFor(db, 'mgrParis'), { ean: EAN.zip, qty: '7', reason: 'Casse' });
  assert.deepEqual([r.stock, r.diff], [7, -13]);
  assert.deepEqual([db.history[0].type, db.history[0].delta, db.history[0].qty, db.history[0].reason], ['inv', -13, 7, 'Casse']);
  expectOpError(() => ops.adjustStock(db, ctxFor(db, 'mgrParis'), { ean: EAN.zip, qty: 7 }), /identique/);
  expectOpError(() => ops.adjustStock(db, ctxFor(db, 'mgrParis'), { ean: EAN.zip, qty: -1 }), /invalide/);
  expectOpError(() => ops.adjustStock(db, ctxFor(db, 'mgrParis'), { ean: EAN.zip, qty: 2.5 }), /invalide/);
  expectOpError(() => ops.adjustStock(db, ctxFor(db, 'mgrParis'), { ean: EAN.ghost, qty: 1 }), /introuvable/);
  assert.equal(ops.adjustStock(db, ctxFor(db, 'mgrParis'), { ean: EAN.zip, qty: 0 }).stock, 0, 'zéro autorisé');
});

// ── Transferts ──
test('transfert : débit immédiat, réception crédite, historique des deux côtés', () => {
  const db = smallDb();
  const { transferId } = ops.createTransfer(db, ctxFor(db, 'opParis'), { ean: EAN.zip, qty: 8, toDepotId: IDS.lyon });
  assert.equal(stockOf(db, IDS.paris, EAN.zip), 12);
  assert.equal(stockOf(db, IDS.lyon, EAN.zip), 5, 'pas encore reçu');
  assert.equal(Object.values(db.transfers)[0].status, 'pending');
  expectOpError(() => ops.receiveTransfer(db, ctxFor(db, 'opParis'), transferId), /Accès refusé/);
  const rec = ops.receiveTransfer(db, ctxFor(db, 'opLyon'), transferId);
  assert.equal(rec.stock, 13);
  const tr = Object.values(db.transfers)[0];
  assert.deepEqual([tr.status, tr.receivedBy], ['done', 'Pierre Blanc']);
  assert.deepEqual(db.history.slice(0, 2).map((h) => [h.type, h.delta, h.depotId]), [['transfer_in', 8, IDS.lyon], ['transfer', -8, IDS.paris]]);
  expectOpError(() => ops.receiveTransfer(db, ctxFor(db, 'opLyon'), transferId), /déjà traité/);
});

test('transfert : validations (stock, destination, article, quantité)', () => {
  const db = smallDb();
  const op = ctxFor(db, 'opParis');
  expectOpError(() => ops.createTransfer(db, op, { ean: EAN.zip, qty: 21, toDepotId: IDS.lyon }), /Stock insuffisant/);
  expectOpError(() => ops.createTransfer(db, op, { ean: EAN.zip, qty: 1, toDepotId: IDS.paris }), /différent/);
  expectOpError(() => ops.createTransfer(db, op, { ean: EAN.zip, qty: 1, toDepotId: 'inconnu' }), /destinataire/);
  expectOpError(() => ops.createTransfer(db, op, { ean: EAN.ghost, qty: 1, toDepotId: IDS.lyon }), /inconnu/);
  expectOpError(() => ops.createTransfer(db, op, { ean: EAN.zip, qty: 0, toDepotId: IDS.lyon }), /Quantité/);
  assert.equal(Object.keys(db.transfers).length, 0);
  assert.equal(stockOf(db, IDS.paris, EAN.zip), 20);
});

test('transfert : annulation par l\'expéditeur / refus par le destinataire restituent le stock à la source', () => {
  const db = smallDb();
  const a = ops.createTransfer(db, ctxFor(db, 'opParis'), { ean: EAN.zip, qty: 8, toDepotId: IDS.lyon }).transferId;
  const b = ops.createTransfer(db, ctxFor(db, 'opParis'), { ean: EAN.zip, qty: 2, toDepotId: IDS.lyon }).transferId;
  assert.equal(stockOf(db, IDS.paris, EAN.zip), 10);
  ops.cancelTransfer(db, ctxFor(db, 'opParis'), a); // son auteur
  assert.equal(stockOf(db, IDS.paris, EAN.zip), 18);
  assert.equal(db.transfers[a].status, 'cancelled');
  expectOpError(() => ops.cancelTransfer(db, ctxFor(db, 'opParis'), a), /déjà traité/);
  expectOpError(() => ops.cancelTransfer(db, ctxFor(db, 'opLyon'), b), /Accès refusé/);
  ops.refuseTransfer(db, ctxFor(db, 'opLyon'), b);
  assert.equal(stockOf(db, IDS.paris, EAN.zip), 20);
  assert.equal(stockOf(db, IDS.lyon, EAN.zip), 5, 'le destinataire n\'a jamais été crédité');
  const t = db.transfers[b];
  assert.deepEqual([t.status, t.cancelledBy], ['refused', 'Pierre Blanc']);
  assert.equal(db.history[0].type, 'transfer_cancel');
  assert.equal(db.history[0].depotId, IDS.paris);
});

test('transfert : seul son auteur ou un responsable peut annuler', () => {
  const db = smallDb();
  const t = ops.createTransfer(db, ctxFor(db, 'mgrParis'), { ean: EAN.zip, qty: 1, toDepotId: IDS.lyon }).transferId;
  expectOpError(() => ops.cancelTransfer(db, ctxFor(db, 'opParis'), t), /non autorisée/);
  assert.doesNotThrow(() => ops.cancelTransfer(db, ctxFor(db, 'mgrParis'), t));
});

// ── Inventaire ──
test('inventaire validé : corrections tracées, conflits signalés, signature contrôlée', () => {
  const db = smallDb();
  expectOpError(() => ops.commitInventory(db, ctxFor(db, 'opParis'), { depotId: IDS.paris, lines: [{ ean: EAN.zip, real: 1, sys: 20 }], validator: { name: 'x' } }), /non autorisée/);
  db.stocks[IDS.paris][EAN.button] = 4; // quelqu'un a bougé le stock pendant le comptage
  const sig = 'data:image/png;base64,iVBORw0KGgo=';
  const r = ops.commitInventory(db, ctxFor(db, 'mgrParis'), {
    depotId: IDS.paris, validator: { name: 'Sophie Martin' }, signature: sig,
    lines: [{ ean: EAN.zip, real: 18, sys: 20 }, { ean: EAN.button, real: 3, sys: 3 }, { ean: EAN.clasp, real: 0, sys: 0 }, { ean: EAN.ghost, real: 5, sys: 0 }],
  });
  assert.deepEqual(r, { corrections: 2, total: 3, conflicts: 1 });
  assert.equal(stockOf(db, IDS.paris, EAN.zip), 18);
  assert.equal(stockOf(db, IDS.paris, EAN.button), 3, 'la valeur physique comptée prévaut');
  const invs = db.history.filter((h) => h.type === 'inv');
  assert.deepEqual(invs.map((h) => h.delta).sort((a, b) => a - b), [-2, -1]);
  assert.ok(invs.every((h) => h.validatedBy === 'Sophie Martin'));
  assert.equal(db.audit[0].meta.sig, sig);
  ops.commitInventory(db, ctxFor(db, 'mgrParis'), { depotId: IDS.paris, validator: { name: 'x' }, signature: 'javascript:alert(1)', lines: [{ ean: EAN.zip, real: 17 }] });
  assert.equal(db.audit[0].meta.sig, undefined, 'signature non image : ignorée');
  expectOpError(() => ops.commitInventory(db, ctxFor(db, 'mgrParis'), { depotId: IDS.lyon, validator: { name: 'x' }, lines: [{ ean: EAN.zip, real: 1 }] }), /Accès refusé/);
  expectOpError(() => ops.commitInventory(db, ctxFor(db, 'mgrParis'), { depotId: IDS.paris, validator: { name: 'x' }, lines: [{ ean: EAN.zip, real: -4 }] }), /invalide/);
  expectOpError(() => ops.commitInventory(db, ctxFor(db, 'mgrParis'), { depotId: IDS.paris, validator: { name: 'x' }, lines: [] }), /Aucune ligne/);
});

// ── Articles ──
test('article : création/édition validées, photo contrôlée, droits', () => {
  const db = smallDb();
  const mgr = ctxFor(db, 'mgrParis');
  const r = ops.upsertArticle(db, mgr, { ean: '20000017', name: '  Rivet   cuivre ', family: 'Rivets', ref: 'RIV-1', price: '0,35', threshold: '12', photo: 'data:image/jpeg;base64,/9j/4AAQ' });
  assert.equal(r.created, true);
  const a = db.articles['20000017'];
  assert.deepEqual([a.name, a.price, a.threshold], ['Rivet cuivre', 0.35, 12]);
  assert.equal(stockOf(db, IDS.lyon, '20000017'), 0);
  for (const bad of [{ name: '' }, { name: 'x', price: 'abc' }, { name: 'x', price: '-1' }, { name: 'x', threshold: '1.5' }, { name: 'x', threshold: '-2' }, { name: 'x', photo: 'http://evil/x.png' }, { name: 'x', photo: 'data:text/html;base64,PHNjcmlwdD4=' }, { name: 'x', ean: 'abc' }]) {
    expectOpError(() => ops.upsertArticle(db, mgr, { ean: '20000018', ...bad }), /obligatoire|invalide/);
  }
  assert.ok(!db.articles['20000018']);
  const kept = ops.upsertArticle(db, mgr, { ean: '20000017', name: 'Rivet cuivre 2' }); // photo non fournie : conservée
  assert.equal(kept.created, false);
  assert.ok(isImageDataUrl(db.articles['20000017'].photo));
  ops.upsertArticle(db, mgr, { ean: '20000017', name: 'Rivet cuivre 2', photo: '' });
  assert.equal(db.articles['20000017'].photo, '', 'photo supprimée explicitement');
  expectOpError(() => ops.upsertArticle(db, ctxFor(db, 'opParis'), { ean: '20000017', name: 'Modif opérateur' }), /non autorisée/);
  expectOpError(() => ops.upsertArticle(db, mgr, { ean: '20000017', name: 'Écrasement', createOnly: true }), /existe déjà/);
  assert.equal(db.articles['20000017'].name, 'Rivet cuivre 2', 'la pièce existante n\'est pas écrasée');
  assert.doesNotThrow(() => ops.upsertArticle(db, ctxFor(db, 'opParis'), { ean: '20000019', name: 'Création opérateur' }));
});

test('suppression d\'article : refusée tant qu\'il reste du stock ou un transfert en cours', () => {
  const db = smallDb();
  const mgr = ctxFor(db, 'mgrParis');
  expectOpError(() => ops.deleteArticle(db, mgr, EAN.zip), /unité\(s\) en stock/);
  db.stocks[IDS.paris][EAN.clasp] = 0; db.stocks[IDS.lyon][EAN.clasp] = 0;
  db.transfers.transferxx01 = { id: 'transferxx01', ean: EAN.clasp, status: 'pending' };
  expectOpError(() => ops.deleteArticle(db, mgr, EAN.clasp), /transfert en cours/);
  db.transfers = {};
  ops.deleteArticle(db, mgr, EAN.clasp);
  assert.ok(!db.articles[EAN.clasp] && !(EAN.clasp in db.stocks[IDS.paris]) && !(EAN.clasp in db.stocks[IDS.lyon]));
  expectOpError(() => ops.deleteArticle(db, ctxFor(db, 'opParis'), EAN.button), /non autorisée/);
});

test('emplacements : création, doublon, suppression qui nettoie les articles', () => {
  const db = smallDb();
  const mgr = ctxFor(db, 'mgrParis');
  const loc = ops.saveLocation(db, mgr, { depotId: IDS.paris, rack: 'r2', allee: 'a1', etagere: '', case: '', desc: 'Réserve' });
  assert.equal(locCode(loc), 'R2-A1');
  expectOpError(() => ops.saveLocation(db, mgr, { depotId: IDS.paris, rack: 'R2', allee: 'A1' }), /existe déjà/);
  expectOpError(() => ops.saveLocation(db, mgr, { depotId: IDS.paris, rack: '', allee: '' }), /invalide/);
  expectOpError(() => ops.saveLocation(db, mgr, { depotId: IDS.lyon, rack: 'R9' }), /Accès refusé/);
  ops.setArticleLocation(db, mgr, { ean: EAN.zip, code: 'R2-A1' });
  assert.equal(db.articles[EAN.zip].locations[IDS.paris].length, 2);
  ops.deleteLocation(db, mgr, IDS.locA);
  assert.deepEqual(db.articles[EAN.zip].locations[IDS.paris], [loc.id]);
  ops.deleteLocation(db, mgr, loc.id);
  assert.equal(db.articles[EAN.zip].locations[IDS.paris], undefined, 'plus aucun emplacement → clé retirée');
  ops.setArticleLocation(db, mgr, { ean: EAN.zip, code: 'R1-A2-E1-C1', makeDefault: true });
  ops.removeArticleLocation(db, mgr, { ean: EAN.zip, locId: IDS.locB });
  assert.equal(db.articles[EAN.zip].locations[IDS.paris], undefined);
});

// ── Dépôts / utilisateurs ──
test('dépôts : garde-fous de suppression', () => {
  const db = smallDb();
  const admin = ctxFor(db, 'admin');
  expectOpError(() => ops.deleteDepot(db, ctxFor(db, 'mgrParis'), IDS.lyon), /non autorisée/);
  expectOpError(() => ops.deleteDepot(db, admin, IDS.paris), /dépôt actif/);
  expectOpError(() => ops.deleteDepot(db, admin, IDS.lyon), /utilisateur\(s\)/);
  delete db.users[IDS.mgrLyon]; delete db.users[IDS.opLyon];
  expectOpError(() => ops.deleteDepot(db, admin, IDS.lyon), /unité\(s\)/);
  db.stocks[IDS.lyon] = {};
  db.transfers.transferxx02 = { id: 'transferxx02', status: 'pending', fromDepotId: IDS.paris, toDepotId: IDS.lyon };
  expectOpError(() => ops.deleteDepot(db, admin, IDS.lyon), /transferts en cours/);
  db.transfers = {};
  ops.deleteDepot(db, admin, IDS.lyon);
  assert.ok(!db.depots[IDS.lyon] && !db.stocks[IDS.lyon] && !db.locations[IDS.locLyon]);
  expectOpError(() => ops.deleteDepot(db, { ...admin, depotId: 'autre' }, IDS.paris), /dernier dépôt/);
});

test('dépôts : unicité du nom et du code', () => {
  const db = smallDb();
  const admin = ctxFor(db, 'admin');
  expectOpError(() => ops.saveDepot(db, admin, { name: 'atelier paris' }), /déjà ce nom/);
  expectOpError(() => ops.saveDepot(db, admin, { name: 'Nice', code: 'dep-01' }), /déjà utilisé/);
  expectOpError(() => ops.saveDepot(db, admin, { name: '  ' }), /obligatoire/);
  const d = ops.saveDepot(db, admin, { name: 'Atelier Nice', code: 'dep-03', location: 'Nice' });
  assert.equal(d.code, 'DEP-03');
  assert.deepEqual(db.stocks[d.id], {});
  expectOpError(() => ops.saveDepot(db, ctxFor(db, 'mgrParis'), { name: 'X' }), /non autorisée/);
});

test('utilisateurs : unicité, dernier administrateur, auto-suppression, PIN obligatoire', () => {
  const db = smallDb();
  const admin = ctxFor(db, 'admin');
  const base = { name: 'Nouveau', role: 'operator', depotId: IDS.paris };
  expectOpError(() => ops.saveUser(db, admin, base), /PIN est obligatoire/);
  expectOpError(() => ops.saveUser(db, admin, { ...base, name: 'sophie martin', pin: FAKE_PIN }), /déjà ce nom/);
  expectOpError(() => ops.saveUser(db, admin, { ...base, role: 'root', pin: FAKE_PIN }), /Rôle invalide/);
  expectOpError(() => ops.saveUser(db, admin, { ...base, depotId: 'inconnu', pin: FAKE_PIN }), /Dépôt invalide/);
  expectOpError(() => ops.saveUser(db, ctxFor(db, 'mgrParis'), { ...base, pin: FAKE_PIN }), /non autorisée/);
  const u = ops.saveUser(db, admin, { ...base, pin: FAKE_PIN });
  assert.equal(db.users[u.id].role, 'operator');
  ops.saveUser(db, admin, { id: u.id, name: 'Nouveau', role: 'manager', depotId: IDS.paris, pin: null });
  assert.deepEqual([db.users[u.id].role, db.users[u.id].pin.alg], ['manager', 'PBKDF2-SHA256'], 'PIN conservé');
  expectOpError(() => ops.saveUser(db, admin, { id: IDS.admin, name: 'Administrateur', role: 'manager', depotId: IDS.paris }), /au moins un administrateur/);
  expectOpError(() => ops.deleteUser(db, admin, IDS.admin), /propre compte/);
  const other = ops.saveUser(db, admin, { name: 'Admin 2', role: 'admin', depotId: IDS.paris, pin: FAKE_PIN });
  assert.doesNotThrow(() => ops.deleteUser(db, ctxFor(db, 'admin'), other.id));
  delete db.users[IDS.admin];
  db.users[other.id] = other;
  expectOpError(() => ops.deleteUser(db, { ...admin, user: { ...admin.user, id: 'zz' } }, other.id), /au moins un administrateur/);
});

test('changer son PIN retire l\'aide de démo correspondante', () => {
  const db = smallDb();
  db.meta.demo = true;
  db.meta.demoPins = [{ name: 'Julie Laurent', pin: '4567' }, { name: 'Sophie Martin', pin: '2345' }];
  ops.changeOwnPin(db, ctxFor(db, 'opParis'), { ...FAKE_PIN, salt: 'BBBBBBBBBBBBBBBBBBBBBB==' });
  assert.deepEqual(db.meta.demoPins.map((p) => p.name), ['Sophie Martin']);
  assert.equal(db.users[IDS.opParis].pin.salt, 'BBBBBBBBBBBBBBBBBBBBBB==');
});

test('réglage du verrouillage automatique', () => {
  const db = smallDb();
  ops.updateSettings(db, ctxFor(db, 'admin'), { sessionMinutes: '30' });
  assert.equal(db.meta.settings.sessionMinutes, 30);
  ops.updateSettings(db, ctxFor(db, 'admin'), { sessionMinutes: 0 });
  assert.equal(db.meta.settings.sessionMinutes, 0);
  expectOpError(() => ops.updateSettings(db, ctxFor(db, 'admin'), { sessionMinutes: 999 }), /Durée de verrouillage invalide/);
  expectOpError(() => ops.updateSettings(db, ctxFor(db, 'mgrParis'), { sessionMinutes: 5 }), /non autorisée/);
});

// ── Import ──
const CSV_ROWS = [
  { _line: 2, ean13: '40000011', name: 'Zip nouveau', famille: 'Zips', prix: '2,5', seuil: '8', stock: '30' },
  { _line: 3, ean13: EAN.zip, name: 'Zip YKK 20cm', prix: '1,6', seuil: '10', stock: '20' },
  { _line: 4, ean13: EAN.button, name: 'Bouton doré v2', prix: '1.2', seuil: '5', stock: '9' },
  { _line: 5, ean13: 'BADEAN', name: 'Sans EAN valide' },
  { _line: 6, ean13: '40000012', name: '' },
  { _line: 7, ean13: '40000011', name: 'Doublon' },
  { _line: 8, ean13: '40000013', name: 'Prix absurde', prix: '12€' },
  { _line: 9, ean13: '40000014', name: 'Seuil absurde', seuil: '1.5' },
  { _line: 10, ean13: '', name: '' },
];

test('import CSV : l\'aperçu (dryRun) ne modifie rien et annonce le bilan exact', () => {
  const db = smallDb();
  const before = JSON.stringify(db);
  const r = ops.importCatalogue(db, ctxFor(db, 'mgrParis'), CSV_ROWS, { dryRun: true, applyStock: true });
  assert.equal(JSON.stringify(db), before);
  assert.deepEqual([r.created, r.updated, r.unchanged, r.stockSet], [1, 1, 1, 2]);
  assert.deepEqual(r.skipped.map((s) => s.line), [5, 6, 7, 8, 9]);
  assert.match(r.skipped[2].reason, /doublon.*ligne 2/);
});

test('import CSV : application réelle, quantités optionnelles et tracées', () => {
  const db = smallDb();
  const mgr = ctxFor(db, 'mgrParis');
  const r = ops.importCatalogue(db, mgr, CSV_ROWS, { applyStock: false });
  assert.deepEqual([r.created, r.updated, r.stockSet], [1, 1, 0]);
  assert.equal(db.articles['40000011'].price, 2.5);
  assert.equal(stockOf(db, IDS.paris, '40000011'), 0, 'quantités ignorées sans applyStock');
  assert.equal(db.articles[EAN.button].name, 'Bouton doré v2');
  assert.equal(db.articles[EAN.zip].family, 'Zips', 'famille conservée si absente du CSV');
  const r2 = ops.importCatalogue(db, mgr, CSV_ROWS, { applyStock: true });
  assert.equal(r2.stockSet, 2);
  assert.equal(stockOf(db, IDS.paris, '40000011'), 30);
  assert.equal(stockOf(db, IDS.paris, EAN.button), 9);
  assert.deepEqual(db.history.slice(0, 2).map((h) => [h.type, h.note]), [['inv', 'Import CSV'], ['inv', 'Import CSV']]);
  expectOpError(() => ops.importCatalogue(db, ctxFor(db, 'opParis'), CSV_ROWS), /non autorisée/);
  expectOpError(() => ops.importCatalogue(db, mgr, new Array(LIMITS.rows + 1).fill({ _line: 1 })), /volumineux/);
});

test('import de pièces suggérées par l\'IA : codes internes, EAN du modèle ignorés', () => {
  const db = smallDb();
  const mgr = ctxFor(db, 'mgrParis');
  const eans = ops.importSuggestedParts(db, mgr, [
    { name: 'Fermoir', family: 'Fermoirs', typical_ean: '3700089690011', typical_threshold: 7 },
    { name: '<b>Anse</b>', family: 'Anses', typical_threshold: 'x' },
    { name: '' },
  ]);
  assert.equal(eans.length, 2);
  assert.ok(eans.every((e) => /^200\d{10}$/.test(e)));
  assert.equal(db.articles[EAN.zip].name, 'Zip YKK 20cm', 'l\'article existant n\'est pas écrasé par un EAN halluciné');
  assert.equal(db.articles[eans[0]].threshold, 7);
  assert.equal(db.articles[eans[1]].threshold, 5);
  expectOpError(() => ops.importSuggestedParts(db, ctxFor(db, 'opParis'), [{ name: 'x' }]), /non autorisée/);
});

// ── Propriété : invariants sur de longues séquences aléatoires ──
test('invariants : stock = initial + Σ deltas, jamais négatif, conservation des unités (800 opérations)', () => {
  const rnd = prng(2026);
  const db = smallDb();
  const init = JSON.parse(JSON.stringify(db.stocks));
  const eans = [EAN.zip, EAN.button, EAN.clasp];
  const users = ['admin', 'mgrParis', 'opParis', 'mgrLyon', 'opLyon'];
  let external = 0; // entrées - sorties (seules variations de la quantité totale hors transferts/inventaire)
  let applied = 0, refused = 0;
  const inTransit = () => Object.values(db.transfers).filter((t) => t.status === 'pending').reduce((s, t) => s + t.qty, 0);
  const total = () => Object.keys(db.depots).reduce((s, d) => s + Object.values(db.stocks[d]).reduce((a, b) => a + b, 0), 0);
  const startTotal = total();
  let adjustDelta = 0;
  for (let i = 0; i < 800; i++) {
    const key = users[Math.floor(rnd() * users.length)];
    const depotId = key === 'admin' ? [IDS.paris, IDS.lyon][Math.floor(rnd() * 2)] : undefined;
    const ctx = { ...ctxFor(db, key, { depotId }), now: at(i * 60_000) };
    const ean = eans[Math.floor(rnd() * eans.length)];
    const qty = 1 + Math.floor(rnd() * 12);
    const roll = rnd();
    try {
      if (roll < 0.3) { const r = ops.moveStock(db, ctx, { type: 'in', ean, qty }); external += qty; applied++; }
      else if (roll < 0.55) { ops.moveStock(db, ctx, { type: 'out', ean, qty }); external -= qty; applied++; }
      else if (roll < 0.7) { ops.createTransfer(db, ctx, { ean, qty, toDepotId: ctx.depotId === IDS.paris ? IDS.lyon : IDS.paris }); applied++; }
      else if (roll < 0.82) { const t = Object.values(db.transfers).filter((x) => x.status === 'pending'); if (t.length) { ops.receiveTransfer(db, { ...ctxFor(db, 'admin'), now: ctx.now }, t[Math.floor(rnd() * t.length)].id); applied++; } }
      else if (roll < 0.88) { const t = Object.values(db.transfers).filter((x) => x.status === 'pending'); if (t.length) { ops.cancelTransfer(db, { ...ctxFor(db, 'admin'), now: ctx.now }, t[Math.floor(rnd() * t.length)].id); applied++; } }
      else if (roll < 0.92) { const t = Object.values(db.transfers).filter((x) => x.status === 'pending'); if (t.length) { ops.refuseTransfer(db, { ...ctxFor(db, 'admin'), now: ctx.now }, t[Math.floor(rnd() * t.length)].id); applied++; } }
      else if (roll < 0.96) { const cur = stockOf(db, ctx.depotId, ean); const r = ops.adjustStock(db, { ...ctxFor(db, 'admin', { depotId: ctx.depotId }), now: ctx.now }, { ean, qty: Math.max(0, cur + Math.floor(rnd() * 11) - 5) }); adjustDelta += r.diff; applied++; }
      else { const h = db.history.find((x) => (x.type === 'in' || x.type === 'out') && !x.undone && !x.undoOf); if (h) { const cur = db.history.length; ops.undoMovement(db, { ...ctxFor(db, 'admin', { depotId: h.depotId }), now: ctx.now }, h.id); external -= h.delta; applied++; } }
    } catch (e) {
      if (!e.isOpError) throw e;
      refused++;
    }
    // Invariants à chaque pas
    for (const d of Object.keys(db.depots)) for (const e of eans) assert.ok(db.stocks[d][e] >= 0, `stock négatif (${d}, ${e}) à l'étape ${i}`);
  }
  assert.ok(applied > 300 && refused > 20, `séquence trop pauvre : ${applied} appliquées, ${refused} refusées`);
  // 1) stock = initial + somme des deltas de l'historique (rien n'est modifié sans trace)
  for (const d of Object.keys(db.depots)) for (const e of eans) {
    const sum = db.history.filter((h) => h.depotId === d && h.ean === e).reduce((s, h) => s + h.delta, 0);
    assert.equal(db.stocks[d][e], init[d][e] + sum, `historique incohérent (${d}, ${e})`);
  }
  // 2) conservation : total + en transit = départ + entrées − sorties + corrections
  assert.equal(total() + inTransit(), startTotal + external + adjustDelta, 'conservation des unités');
  // 3) chaque transfert terminé est cohérent
  for (const t of Object.values(db.transfers)) assert.ok(['pending', 'done', 'cancelled', 'refused'].includes(t.status));
  assert.ok(db.history.length <= LIMITS.history && db.audit.length <= LIMITS.audit);
  assert.ok(totalStock(db, EAN.zip) >= 0);
});
