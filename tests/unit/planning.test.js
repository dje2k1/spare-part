// Planification : consommation, seuils intelligents, prévisions, préparation, briefing du jour, rapport.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as p from '../../js/core/planning.js';
import * as o from '../../js/core/ops-orders.js';
import * as ops from '../../js/core/ops.js';
import { weekOf } from '../../js/core/ops-kit.js';
import { buildDemoDb } from '../../js/core/seed.js';
import { NOW, IDS, EAN, ORG, orgDb, ctxFor } from './helpers.js';

const DAY = 86_400_000;
const W = weekOf(NOW);

test('niveau de service → coefficient de sécurité (croissant, bornes)', () => {
  assert.equal(p.zFor(50), 0);
  assert.ok(Math.abs(p.zFor(95) - 1.645) < 1e-9);
  assert.ok(p.zFor(96) > p.zFor(95) && p.zFor(96) < p.zFor(97));
  assert.equal(p.zFor(120), p.zFor(99));
  assert.equal(p.zFor('n/a'), p.zFor(95), 'valeur absurde → 95 %');
});

test('consommation : moyenne journalière, régularité, fenêtre raccourcie pour un article récent', () => {
  const db = orgDb();
  db.usage[IDS.paris] = { [EAN.zip]: Object.fromEntries(Array.from({ length: 13 }, (_, i) => [W - 13 + i, 14])) };
  const st = p.usageStats(db, IDS.paris, EAN.zip, NOW);
  assert.equal(st.weeks, 13);
  assert.ok(Math.abs(st.avgDaily - (13 * 14) / (13 * 7 + st.series.length * 0 + ((NOW.getUTCDay() + 6) % 7) + 1)) < 1e-9);
  assert.equal(st.sdDaily, 0, 'consommation parfaitement régulière');
  assert.equal(st.confidence, 'high');
  // Article récent : 2 semaines de données → fenêtre de 4 semaines (pas 13)
  db.usage[IDS.paris][EAN.button] = { [W - 2]: 20, [W - 1]: 20 };
  const recent = p.usageStats(db, IDS.paris, EAN.button, NOW);
  assert.equal(recent.weeks, 4);
  assert.equal(recent.confidence, 'low');
  assert.equal(p.usageStats(db, IDS.paris, EAN.clasp, NOW).confidence, 'none');
});

test('seuils proposés : délai × consommation + stock de sécurité, couverture, conditionnement', () => {
  const db = orgDb();
  const paris = db.depots[IDS.paris];
  // 2/jour régulier, délai interne par défaut 2 j, couverture 14 j
  db.usage[IDS.paris] = { [EAN.button]: Object.fromEntries(Array.from({ length: 13 }, (_, i) => [W - 13 + i, 14])) };
  const pr = p.proposeLevel(db, paris, db.articles[EAN.button], NOW);
  assert.equal(pr.lead, 2);
  assert.equal(pr.safety, 0);
  assert.equal(pr.min, Math.ceil(pr.avgDaily * 2));
  assert.equal(pr.max, Math.ceil(pr.min + pr.avgDaily * 14));
  // Irrégulier → stock de sécurité > 0 ; conditionnement de 10 pour le zip
  db.usage[IDS.paris][EAN.zip] = Object.fromEntries(Array.from({ length: 13 }, (_, i) => [W - 13 + i, i % 2 ? 30 : 2]));
  const z = p.proposeLevel(db, paris, db.articles[EAN.zip], NOW);
  assert.ok(z.safety > 0);
  assert.equal(z.max % 10, 0, 'maximum arrondi au conditionnement');
  // L'entrepôt utilise le délai du fournisseur (10 j pour YKK)
  db.usage[ORG.central] = { [EAN.zip]: { [W - 1]: 70, [W - 2]: 70, [W - 3]: 70, [W - 4]: 70 } };
  assert.equal(p.proposeLevel(db, db.depots[ORG.central], db.articles[EAN.zip], NOW).lead, 10);
  // Niveau de service plus exigeant → seuil plus haut
  db.meta.settings.serviceLevel = 99;
  assert.ok(p.proposeLevel(db, paris, db.articles[EAN.zip], NOW).min > z.min);
  assert.equal(p.proposeLevel(db, paris, db.articles[EAN.clasp], NOW), null, 'aucune consommation → aucune proposition');
});

test('tableau des seuils et prévision de rupture', () => {
  const db = orgDb();
  db.usage[IDS.paris] = { [EAN.zip]: Object.fromEntries(Array.from({ length: 13 }, (_, i) => [W - 13 + i, 35])) }; // 5/jour
  const rows = p.levelProposals(db, IDS.paris, NOW);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].current.min, 10);
  assert.ok(rows[0].proposed.min >= 10);
  assert.ok(Math.abs(rows[0].daysLeft - 20 / rows[0].proposed.avgDaily) < 1e-9);
  const soon = p.stockoutForecast(db, IDS.paris, NOW, { horizon: 7 });
  assert.equal(soon.length, 1, '20 en stock à ~5/jour : rupture sous 7 jours');
  assert.ok(soon[0].date > NOW);
  // Une commande en route repousse la rupture
  const julie = ctxFor(db, 'opParis');
  const { orderId } = o.setDraftLines(db, julie, { lines: [{ ean: EAN.zip, qty: 100 }] });
  o.submitOrder(db, julie, { id: orderId });
  assert.equal(p.stockoutForecast(db, IDS.paris, NOW).length, 0);
});

test('délai mesuré : moyenne des 10 dernières réceptions (au moins 3)', () => {
  const db = orgDb();
  const mk = (sub, rec) => { const id = `ordertest${Object.keys(db.orders).length}`.padEnd(12, '0'); db.orders[id] = { id, kind: 'internal', no: 1, status: 'received', depotId: IDS.paris, sourceId: ORG.central, lines: [], createdAt: sub, submittedAt: sub, receivedAt: rec }; };
  mk(new Date(NOW - 10 * DAY).toISOString(), new Date(NOW - 8 * DAY).toISOString());
  mk(new Date(NOW - 6 * DAY).toISOString(), new Date(NOW - 3 * DAY).toISOString());
  assert.equal(p.measuredLeadDays(db, IDS.paris), null, 'pas assez de données');
  mk(new Date(NOW - 5 * DAY).toISOString(), new Date(NOW - 1 * DAY).toISOString());
  assert.equal(p.measuredLeadDays(db, IDS.paris), 3);
  assert.equal(p.leadDaysFor(db, db.depots[IDS.paris], db.articles[EAN.zip]), 3, 'le délai mesuré remplace le réglage');
});

test('liste de préparation : rupture signalée, tri par emplacement de l\'entrepôt', () => {
  const db = orgDb();
  const julie = ctxFor(db, 'opParis');
  const { orderId } = o.setDraftLines(db, julie, { lines: [{ ean: EAN.button, qty: 20 }, { ean: EAN.zip, qty: 5 }] });
  o.submitOrder(db, julie, { id: orderId });
  db.locations.loccentral01 = { id: 'loccentral01', depotId: ORG.central, rack: 'R1', allee: 'A1', etagere: '', case: '', desc: '' };
  db.articles[EAN.button].locations[ORG.central] = ['loccentral01'];
  const list = p.pickList(db, db.orders[orderId]);
  assert.deepEqual(list.map((l) => [l.ean, l.avail, l.short]), [[EAN.button, 15, true], [EAN.zip, 200, false]], 'rangé d\'abord, rupture signalée');
});

test('briefing du jour : atelier (livraison à réceptionner, à commander) et entrepôt (à préparer, achats)', () => {
  const db = orgDb();
  db.stocks[IDS.paris][EAN.zip] = 2;
  const julie = ctxFor(db, 'opParis');
  let items = p.briefing(db, { depotId: IDS.paris, role: 'operator', now: NOW });
  assert.ok(items.some((i) => i.key === 'order' && i.count >= 1), JSON.stringify(items));
  assert.ok(!items.some((i) => i.key === 'levels'), 'seuils : réservé aux responsables');
  const { orderId } = o.setDraftLines(db, julie, { lines: [{ ean: EAN.zip, qty: 20 }] });
  o.submitOrder(db, julie, { id: orderId });
  const central = p.briefing(db, { depotId: ORG.central, role: 'manager', now: NOW });
  assert.equal(central.find((i) => i.key === 'prepare').count, 1);
  assert.ok(central.find((i) => i.key === 'prepare').text.includes('Atelier Paris'));
  o.shipOrder(db, ctxFor(db, 'lea'), { id: orderId, lines: [{ ean: EAN.zip, qty: 20 }] });
  items = p.briefing(db, { depotId: IDS.paris, role: 'operator', now: NOW });
  assert.equal(items.find((i) => i.key === 'receive').count, 1);
  assert.ok(items.every((i) => i.count > 0), 'jamais d\'élément vide');
  // Tri : alertes d'abord
  const tones = items.map((i) => i.tone);
  assert.deepEqual(tones, [...tones].sort((a, b) => ['low', 'info', 'gold'].indexOf(a) - ['low', 'info', 'gold'].indexOf(b)));
});

test('rapport hebdomadaire : sorties, valeur, taux de service, écarts', () => {
  const db = orgDb();
  const julie = ctxFor(db, 'opParis');
  ops.moveStock(db, julie, { type: 'out', ean: EAN.zip, qty: 5 });
  const { orderId } = o.setDraftLines(db, julie, { lines: [{ ean: EAN.button, qty: 20 }] });
  o.submitOrder(db, julie, { id: orderId });
  o.shipOrder(db, ctxFor(db, 'lea'), { id: orderId, lines: [{ ean: EAN.button, qty: 15 }], backorder: false });
  o.receiveOrder(db, julie, { id: orderId, lines: [{ ean: EAN.button, qty: 14 }] });
  const r = p.weeklyReport(db, IDS.paris, new Date(NOW.getTime() + 1000));
  assert.equal(r.outUnits, 5);
  assert.equal(r.outValue, 5 * 1.6);
  assert.equal(r.orders.serviceRate, 75);
  assert.equal(r.orders.gaps, 1);
  assert.equal(r.top[0].ean, EAN.zip);
  const c = p.weeklyReport(db, ORG.central, new Date(NOW.getTime() + 1000));
  assert.deepEqual(c.perAtelier.map((x) => [x.depot.id, x.orders, x.units]), [[IDS.paris, 1, 15]]);
});

test('démo : tout le module tourne sur des données réalistes sans exception', async () => {
  const db = await buildDemoDb(NOW, { pinIterations: 1000 });
  for (const d of Object.values(db.depots)) {
    for (const role of ['operator', 'manager']) assert.ok(Array.isArray(p.briefing(db, { depotId: d.id, role, now: NOW })));
    p.levelProposals(db, d.id, NOW);
    p.stockoutForecast(db, d.id, NOW);
    p.weeklyReport(db, d.id, NOW);
  }
  const central = Object.values(db.depots).find((d) => d.kind === 'central');
  assert.ok(p.centralQueue(db, central.id).toPrepare.length >= 1);
  assert.ok(p.purchaseSuggestions(db, central.id).every((g) => g.rows.length));
  assert.ok(p.purchaseOverview(db, central.id, NOW).open.length >= 1);
});

test('briefing entrepôt : pièces manquantes selon la demande CUMULÉE des commandes à servir', () => {
  const db = orgDb();
  db.stocks[ORG.central][EAN.button] = 8;
  for (const key of ['opParis', 'opLyon']) {
    const c = ctxFor(db, key);
    const { orderId } = o.setDraftLines(db, c, { lines: [{ ean: EAN.button, qty: 5 }] });
    o.submitOrder(db, c, { id: orderId });
  }
  const items = p.briefing(db, { depotId: ORG.central, role: 'manager', now: NOW });
  const short = items.find((i) => i.key === 'shortage');
  assert.ok(short, 'deux commandes de 5 face à un stock de 8 : la pièce manque');
  assert.equal(short.count, 1);
  db.stocks[ORG.central][EAN.button] = 10;
  assert.equal(p.briefing(db, { depotId: ORG.central, role: 'manager', now: NOW }).find((i) => i.key === 'shortage'), undefined);
});
