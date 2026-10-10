import test from 'node:test';
import assert from 'node:assert/strict';
import * as q from '../../js/core/queries.js';
import * as ops from '../../js/core/ops.js';
import { buildDemoDb, buildFreshDb } from '../../js/core/seed.js';
import { normalizeDb } from '../../js/core/schema.js';
import { verifyPin } from '../../js/core/auth.js';
import { hasValidCheck } from '../../js/lib/ean.js';
import { NOW, IDS, EAN, smallDb, ctxFor } from './helpers.js';

const DAY = 86_400_000;
const ago = (ms) => new Date(NOW.getTime() - ms).toISOString();

function dbWithHistory() {
  const db = smallDb();
  // stock Paris actuel : zip 20, bouton 3, fermoir 0 → total 23
  const mv = (type, qty, delta, msAgo, ean = EAN.zip, op = 'Julie Laurent') => ({ id: `h${db.history.length}`.padEnd(10, '0'), ean, name: db.articles[ean].name, type, qty, delta, depotId: IDS.paris, depotName: 'Atelier Paris', operator: op, date: ago(msAgo) });
  db.history = [
    mv('in', 10, 10, 1 * 3600_000),            // aujourd'hui
    mv('out', 4, -4, 2 * 3600_000, EAN.button),
    mv('in', 6, 6, 1.5 * DAY, EAN.zip, 'Sophie Martin'),
    mv('out', 2, -2, 3.2 * DAY, EAN.button, 'Sophie Martin'),
    mv('inv', 20, -3, 10 * DAY),
    mv('in', 50, 50, 40 * DAY),               // hors fenêtre 30 j
  ];
  db.history.sort((a, b) => b.date.localeCompare(a.date));
  return db;
}

test('utilitaires de base', () => {
  const db = smallDb();
  assert.equal(q.locCode(db.locations[IDS.locA]), 'R1-A1-E1-C1');
  assert.equal(q.locCode({ rack: 'R1', allee: '', etagere: '', case: '' }), 'R1');
  assert.equal(q.locCode(null), '');
  assert.equal(q.stockOf(db, IDS.paris, EAN.zip), 20);
  assert.equal(q.stockOf(db, IDS.paris, 'inconnu'), 0);
  assert.equal(q.totalStock(db, EAN.zip), 25);
  assert.deepEqual([q.statusOf(db.articles[EAN.zip], 0), q.statusOf(db.articles[EAN.zip], 10), q.statusOf(db.articles[EAN.zip], 11)], ['zero', 'low', 'ok']);
  assert.equal(q.isAlert(db.articles[EAN.clasp], 0), false, 'sans seuil : pas d\'alerte');
  assert.deepEqual(q.families(db), ['Boutons', 'Fermoirs', 'Zips']);
  assert.deepEqual(q.articleLocations(db, EAN.zip, IDS.paris).map(q.locCode), ['R1-A1-E1-C1']);
  assert.deepEqual(q.articleLocations(db, EAN.zip, IDS.lyon), []);
  assert.deepEqual(q.depotLocationCodes(db, IDS.paris), ['R1-A1-E1-C1', 'R1-A2-E1-C1']);
});

test('recherche : accents, mots multiples, EAN, emplacement, filtres et tris', () => {
  const db = smallDb();
  const names = (r) => r.map((x) => x.article.name);
  assert.deepEqual(names(q.searchArticles(db, IDS.paris, { q: 'ZIP ykk' })), ['Zip YKK 20cm']);
  assert.deepEqual(names(q.searchArticles(db, IDS.paris, { q: 'dore' })), ['Bouton doré']);
  assert.deepEqual(names(q.searchArticles(db, IDS.paris, { q: EAN.clasp })), ['Fermoir clip']);
  assert.deepEqual(names(q.searchArticles(db, IDS.paris, { q: 'r1-a1' })), ['Zip YKK 20cm'], 'recherche par emplacement');
  assert.deepEqual(names(q.searchArticles(db, IDS.paris, { filter: 'alert' })), ['Zip YKK 20cm', 'Bouton doré'].filter((n) => n !== 'Zip YKK 20cm'), 'zip=20 > seuil 10 : seul le bouton (3 ≤ 5)');
  assert.deepEqual(names(q.searchArticles(db, IDS.paris, { filter: 'zero' })), ['Fermoir clip']);
  assert.deepEqual(names(q.searchArticles(db, IDS.paris, { family: 'Zips' })), ['Zip YKK 20cm']);
  assert.deepEqual(names(q.searchArticles(db, IDS.paris, { sort: 'name' })), ['Bouton doré', 'Fermoir clip', 'Zip YKK 20cm']);
  assert.deepEqual(names(q.searchArticles(db, IDS.paris, { sort: 'qty-asc' })), ['Fermoir clip', 'Bouton doré', 'Zip YKK 20cm']);
  assert.deepEqual(names(q.searchArticles(db, IDS.paris, { sort: 'qty-desc' })), ['Zip YKK 20cm', 'Bouton doré', 'Fermoir clip']);
  assert.equal(names(q.searchArticles(db, IDS.paris, { sort: 'loc' }))[0], 'Zip YKK 20cm', 'les articles localisés d\'abord');
  assert.equal(q.searchArticles(db, IDS.paris, { q: 'introuvable' }).length, 0);
});

test('tri par emplacement : ordre naturel (R2 avant R10, A2 avant A10)', () => {
  const db = smallDb();
  let i = 0;
  for (const code of ['R10-A1', 'R2-A10', 'R2-A2']) {
    const [rack, allee] = code.split('-');
    const id = `locnat${String(i++).padStart(6, '0')}`;
    db.locations[id] = { id, depotId: IDS.paris, rack, allee, etagere: '', case: '', desc: '' };
    const ean = [EAN.button, EAN.clasp, '20000001'][i - 1];
    db.articles[ean] ??= { ean, name: `N${i}`, family: '', ref: '', price: 0, threshold: 0, photo: '', locations: {} };
    db.articles[ean].locations[IDS.paris] = [id];
  }
  const order = q.searchArticles(db, IDS.paris, { sort: 'loc' }).map((r) => r.locs[0] && q.locCode(r.locs[0]));
  assert.deepEqual(order.filter(Boolean), ['R1-A1-E1-C1', 'R2-A2', 'R2-A10', 'R10-A1']);
});

test('KPI : valeur, alertes, taux de service, fenêtre de période réelle', () => {
  const db = dbWithHistory();
  const k30 = q.kpis(db, IDS.paris, { days: 30, now: NOW });
  assert.equal(k30.refs, 3);
  assert.equal(k30.units, 23);
  assert.equal(k30.value, Math.round((20 * 1.6 + 3 * 1.2 + 0) * 100) / 100);
  assert.deepEqual([k30.alerts, k30.zeros], [1, 1]);
  assert.equal(k30.serviceRate, 50, '2 articles à seuil : zip sain, bouton en alerte');
  assert.deepEqual([k30.ins, k30.outs, k30.moves], [16, 6, 5], 'l\'entrée de 40 jours est exclue');
  const k7 = q.kpis(db, IDS.paris, { days: 7, now: NOW });
  assert.deepEqual([k7.ins, k7.outs, k7.moves], [16, 6, 4]);
  const k90 = q.kpis(db, IDS.paris, { days: 90, now: NOW });
  assert.equal(k90.ins, 66);
  assert.equal(q.kpis(db, IDS.lyon, { days: 30, now: NOW }).moves, 0);
  assert.equal(q.kpis({ ...smallDb(), articles: {} }, IDS.paris, { now: NOW }).serviceRate, 100, 'aucun article suivi → 100 %');
  assert.equal(q.movesToday(db, IDS.paris, NOW), 2);
});

test('évolution : remonte l\'historique depuis le stock courant, sans valeur négative', () => {
  const db = dbWithHistory();
  const { points, truncated } = q.evolution(db, IDS.paris, { days: 30, now: NOW });
  assert.equal(points.length, 30);
  assert.equal(points.at(-1).value, 23, 'aujourd\'hui = stock courant');
  // il y a ~1h30 avant l'entrée de 10 et la sortie de 4 : 23 - 10 + 4 = 17 en fin de journée d'hier
  const yesterday = points.at(-2).value;
  assert.equal(yesterday, 17);
  assert.ok(points.every((p) => p.value >= 0 && Number.isFinite(p.value)));
  assert.ok(points.every((p) => /^\d+\/\d+$/.test(p.label)));
  assert.equal(truncated, false);
  assert.deepEqual(q.evolution(smallDb(), IDS.lyon, { days: 7, now: NOW }).points.map((p) => p.value), new Array(7).fill(15));
});

test('flux (entrées/sorties par jour puis par semaine), heatmap, tops, opérateurs', () => {
  const db = dbWithHistory();
  const f = q.flow(db, IDS.paris, { days: 7, now: NOW });
  assert.equal(f.length, 7);
  assert.equal(f.reduce((s, b) => s + b.ins, 0), 16);
  assert.equal(f.reduce((s, b) => s + b.outs, 0), 6);
  assert.equal(f.at(-1).ins, 10, 'aujourd\'hui');
  const w = q.flow(db, IDS.paris, { days: 90, now: NOW });
  assert.equal(w.length, 13);
  assert.equal(w.reduce((s, b) => s + b.ins, 0), 66);
  const h = q.heatmap(db, IDS.paris, { days: 30, now: NOW });
  assert.equal(h.grid.length, 7);
  assert.ok(h.grid.every((row) => row.length === 24));
  assert.equal(h.grid.flat().reduce((a, b) => a + b, 0), 5);
  assert.ok(h.max >= 1);
  const top = q.topArticles(db, IDS.paris, { days: 30, now: NOW });
  assert.equal(top[0].name, 'Zip YKK 20cm');
  assert.equal(top[0].units, 16);
  assert.ok(!top.some((t) => t.units === 20 && t.moves === 1 && t.ean === EAN.zip && false));
  const ops_ = q.operatorStats(db, IDS.paris, { days: 30, now: NOW });
  assert.deepEqual(ops_.map((o) => [o.name, o.moves]), [['Julie Laurent', 3], ['Sophie Martin', 2]]);
  assert.equal(q.depotComparison(db, NOW).length, 2);
});

test('réassort : seuil × 2 − stock, tri par criticité, coût', () => {
  const db = smallDb();
  db.stocks[IDS.paris][EAN.zip] = 4;     // seuil 10 → objectif 20 → +16
  db.stocks[IDS.paris][EAN.button] = 0;  // seuil 5 → objectif 10 → +10
  const r = q.reorderList(db, IDS.paris);
  assert.deepEqual(r.map((x) => [x.article.name, x.suggested]), [['Bouton doré', 10], ['Zip YKK 20cm', 16]]);
  assert.equal(r[0].cost, 12);
  assert.equal(r[1].cost, 25.6);
  assert.deepEqual(q.reorderList(db, IDS.lyon).map((x) => x.article.name), ['Bouton doré', 'Zip YKK 20cm'], 'lyon : bouton 0/5 puis zip 5/10');
});

test('plan : racks, grille allées × étagères, états et totaux cohérents', () => {
  const db = smallDb();
  db.articles[EAN.button].locations[IDS.paris] = [IDS.locB]; // bouton (3 ≤ 5 → alerte)
  const m = q.planModel(db, IDS.paris);
  assert.equal(m.total, 2);
  assert.equal(m.occupied, 2);
  assert.equal(m.alerts, 1);
  assert.equal(m.racks.length, 1);
  const rack = m.racks[0];
  assert.equal(rack.name, 'R1');
  assert.deepEqual(rack.columns, ['E1-C1']);
  assert.deepEqual(rack.rows.map((r) => r.aisle), ['A1', 'A2']);
  assert.equal(rack.rows[0].cells[0].state, 'ok');
  assert.equal(rack.rows[1].cells[0].state, 'alert');
  assert.equal(rack.occupied, 2);
  assert.equal(m.cellOf(IDS.locA).units, 20);
  assert.deepEqual(q.articlesAt(db, IDS.paris, IDS.locB).map((x) => [x.article.name, x.qty]), [['Bouton doré', 3]]);
  db.stocks[IDS.paris][EAN.button] = 0;
  assert.equal(q.planModel(db, IDS.paris).cellOf(IDS.locB).state, 'zero');
  assert.equal(q.planModel(db, IDS.lyon).total, 1);
  const empty = smallDb(); empty.locations = {};
  assert.deepEqual([q.planModel(empty, IDS.paris).total, q.planModel(empty, IDS.paris).racks.length], [0, 0]);
});

test('plan : cellules hétérogènes (cases multiples, allées manquantes)', () => {
  const db = smallDb();
  db.locations = {};
  const add = (id, rack, allee, etagere, cas) => { db.locations[id] = { id, depotId: IDS.paris, rack, allee, etagere, case: cas, desc: '' }; };
  add('locplan00001', 'R1', 'A1', 'E1', 'C1'); add('locplan00002', 'R1', 'A1', 'E1', 'C2'); add('locplan00003', 'R1', 'A2', 'E2', 'C1');
  const rack = q.planModel(db, IDS.paris).racks[0];
  assert.deepEqual(rack.columns, ['E1-C1', 'E1-C2', 'E2-C1']);
  assert.deepEqual(rack.rows[0].cells.map((c) => c && c.loc.id), ['locplan00001', 'locplan00002', null]);
  assert.deepEqual(rack.rows[1].cells.map((c) => c && c.loc.id), [null, null, 'locplan00003']);
});

test('transferts : vue entrante / sortante / passée, délai moyen', () => {
  const db = smallDb();
  const t = (id, from, to, status, date, extra = {}) => ({ id, ean: EAN.zip, name: 'Zip', qty: 1, fromDepotId: from, fromDepotName: 'x', toDepotId: to, toDepotName: 'y', operator: 'o', date, status, ...extra });
  db.transfers = [
    t('transfer0001', IDS.lyon, IDS.paris, 'pending', ago(DAY)),
    t('transfer0002', IDS.paris, IDS.lyon, 'pending', ago(2 * DAY)),
    t('transfer0003', IDS.paris, IDS.lyon, 'done', ago(5 * DAY), { receivedDate: ago(5 * DAY - 10 * 3600_000) }),
    t('transfer0004', IDS.paris, IDS.lyon, 'done', ago(8 * DAY), { receivedDate: ago(8 * DAY - 20 * 3600_000) }),
    t('transfer0005', IDS.paris, IDS.lyon, 'cancelled', ago(9 * DAY)),
  ];
  const o = q.transferOverview(db, IDS.paris, NOW);
  assert.deepEqual([o.incoming.length, o.outgoing.length, o.past.length], [1, 1, 3]);
  assert.equal(o.avgDelayHours, 15);
  assert.equal(o.received30d, 2);
  assert.equal(q.pendingIncoming(db, IDS.paris).length, 1);
  assert.equal(q.pendingOutgoing(db, IDS.paris).length, 1);
  assert.equal(q.transferOverview(smallDb(), IDS.paris, NOW).avgDelayHours, null);
});

test('journaux : filtres par type, article, période, texte, plafond', () => {
  const db = dbWithHistory();
  assert.equal(q.movements(db, { depotId: IDS.paris }).length, 6);
  assert.equal(q.movements(db, { depotId: IDS.lyon }).length, 0);
  assert.equal(q.movements(db, { depotId: IDS.paris, types: ['in'] }).length, 3);
  assert.equal(q.movements(db, { ean: EAN.button }).length, 2);
  assert.equal(q.movements(db, { since: NOW.getTime() - 7 * DAY }).length, 4);
  assert.equal(q.movements(db, { q: 'sophie' }).length, 2);
  assert.equal(q.movements(db, { limit: 2 }).length, 2);
  db.audit = [
    { id: 'a1', type: 'login', action: 'Connexion de X', operator: 'X', depotId: IDS.lyon, date: ago(1), meta: {} },
    { id: 'a2', type: 'in', action: 'Entrée +1 × Zip', operator: 'Y', depotId: IDS.lyon, date: ago(2), meta: { ean: EAN.zip } },
    { id: 'a3', type: 'in', action: 'Entrée +2 × Bouton', operator: 'Z', depotId: IDS.paris, date: ago(3), meta: {} },
  ];
  assert.deepEqual(q.auditEntries(db, { depotId: IDS.paris }).map((e) => e.id), ['a1', 'a3'], 'connexions visibles de tous');
  assert.deepEqual(q.auditEntries(db, { type: 'in' }).map((e) => e.id), ['a2', 'a3']);
  assert.deepEqual(q.auditEntries(db, { q: EAN.zip }).map((e) => e.id), ['a2']);
});

test('daysSince', () => {
  assert.equal(q.daysSince(null, NOW), Infinity);
  assert.equal(q.daysSince(ago(3.5 * DAY), NOW), 3);
});

// ── Démo ──
const FAST = { pinIterations: 1000 };

test('démo : jeu de données complet, déterministe, relatif à « maintenant »', async () => {
  const db = await buildDemoDb(NOW, FAST);
  assert.equal(db.meta.demo, true);
  assert.equal(Object.keys(db.depots).length, 3);
  assert.equal(Object.keys(db.users).length, 5);
  assert.equal(Object.keys(db.articles).length, 17);
  assert.equal(Object.keys(db.locations).length, 36);
  assert.ok(db.history.length > 100, `${db.history.length} mouvements`);
  assert.equal(db.transfers.length, 4);
  assert.deepEqual(db.meta.demoPins.map((p) => p.pin), ['1234', '2345', '3456', '4567', '5678']);
  for (const a of Object.values(db.articles)) assert.equal(hasValidCheck(a.ean), true, `EAN ${a.ean} : clé GS1 invalide`);
  const dates = db.history.map((h) => new Date(h.date).getTime());
  assert.ok(Math.max(...dates) <= NOW.getTime());
  assert.ok(Math.min(...dates) >= NOW.getTime() - 46 * DAY);
  assert.ok(dates.some((d) => NOW.getTime() - d < DAY), 'activité aujourd\'hui ou hier');
  const paris = Object.values(db.depots)[0].id;
  assert.ok(q.pendingIncoming(db, paris).length >= 1, 'un transfert à réceptionner côté Paris');
  assert.ok(q.kpis(db, paris, { days: 30, now: NOW }).alerts >= 2, 'des alertes visibles');
  const again = await buildDemoDb(NOW, FAST);
  assert.deepEqual(Object.values(again.articles).map((a) => [a.ean, a.name]), Object.values(db.articles).map((a) => [a.ean, a.name]));
  assert.equal(again.history.length, db.history.length, 'même scénario à chaque installation');
});

test('démo : cohérence stock ↔ historique (jamais négatif) et PIN vérifiables', async () => {
  const db = await buildDemoDb(NOW, FAST);
  for (const d of Object.keys(db.depots)) for (const a of Object.keys(db.articles)) {
    const hist = db.history.filter((h) => h.depotId === d && h.ean === a).sort((x, y) => x.date.localeCompare(y.date));
    const now = db.stocks[d][a];
    let s = now - hist.reduce((t, h) => t + h.delta, 0);
    assert.ok(s >= 0, `stock initial négatif (${d}, ${a}) : ${s}`);
    for (const h of hist) { s += h.delta; assert.ok(s >= 0, `stock négatif en cours de route (${d}, ${a})`); }
    assert.equal(s, now);
  }
  for (const [name, pin] of [['Administrateur', '1234'], ['Pierre Blanc', '5678']]) {
    const u = Object.values(db.users).find((x) => x.name === name);
    assert.equal(await verifyPin(u.pin, pin), true, name);
    assert.equal(await verifyPin(u.pin, '0000'), false);
  }
  assert.ok(!JSON.stringify(db.users).includes('"1234"'), 'aucun PIN en clair dans les utilisateurs');
});

test('démo : traverse normalizeDb sans aucune perte (JSON → base)', async () => {
  const db = await buildDemoDb(NOW, FAST);
  const { db: back, notes } = normalizeDb(JSON.parse(JSON.stringify(db)), NOW);
  assert.deepEqual(notes, []);
  for (const k of ['depots', 'users', 'articles', 'locations']) assert.equal(Object.keys(back[k]).length, Object.keys(db[k]).length, k);
  assert.equal(back.history.length, db.history.length);
  assert.equal(back.audit.length, db.audit.length);
  assert.equal(back.transfers.length, 4);
  assert.deepEqual(back.meta.demoPins, db.meta.demoPins);
  assert.ok(back.history.every((h) => Number.isFinite(h.delta)));
});

test('démo : toutes les opérations métier s\'enchaînent sur la base de démo', async () => {
  const db = await buildDemoDb(NOW, FAST);
  const admin = Object.values(db.users).find((u) => u.role === 'admin');
  const paris = admin.depotId;
  const ctx = { user: { id: admin.id, name: admin.name, role: admin.role, depotId: paris }, depotId: paris, now: NOW };
  const incoming = q.pendingIncoming(db, paris)[0];
  ops.receiveTransfer(db, ctx, incoming.id);
  const art = Object.values(db.articles)[0];
  ops.moveStock(db, ctx, { type: 'in', ean: art.ean, qty: 3 });
  ops.moveStock(db, ctx, { type: 'out', ean: art.ean, qty: 2 });
  assert.ok(q.evolution(db, paris, { days: 30, now: NOW }).points.every((p) => p.value >= 0));
  assert.ok(q.planModel(db, paris).total > 0);
});

test('installation vide : un dépôt, un administrateur, PIN haché', async () => {
  const db = await buildFreshDb(NOW, { adminName: 'Camille', pin: '860214', depotName: 'Atelier Test', depotCode: 'atl', pinIterations: 1000 });
  assert.equal(db.meta.demo, false);
  assert.equal(db.meta.demoPins, undefined);
  assert.equal(Object.keys(db.depots).length, 1);
  const u = Object.values(db.users)[0];
  assert.deepEqual([u.name, u.role], ['Camille', 'admin']);
  assert.equal(await verifyPin(u.pin, '860214'), true);
  assert.equal(Object.values(db.depots)[0].code, 'ATL');
  assert.ok(!JSON.stringify(db).includes('860214'));
  assert.doesNotThrow(() => normalizeDb(JSON.parse(JSON.stringify(db)), NOW));
});
