// Montée en charge : un vrai catalogue (3 000 pièces, 1 200 commandes, 1 800 emplacements) reste fluide.
// Les budgets sont très larges (≈ 15 × le temps mesuré) : ils ne détectent pas une petite lenteur, mais un
// retour aux parcours « chaque article × chaque commande » (plusieurs secondes par écran sur un téléphone).
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyDb } from '../../js/core/schema.js';
import { weekOf } from '../../js/core/ops-kit.js';
import { checkDigit } from '../../js/lib/ean.js';
import { searchArticles, reorderList, planModel, kpis } from '../../js/core/queries.js';
import { briefing, levelProposals, stockoutForecast, purchaseSuggestions } from '../../js/core/planning.js';
import { NOW } from './helpers.js';

function bigDb({ articles = 3000, orders = 1200 } = {}) {
  const db = emptyDb(NOW);
  const depots = [['depcentral01', 'Entrepôt', 'central'], ['depatelier01', 'Atelier Paris', 'atelier'], ['depatelier02', 'Atelier Lyon', 'atelier']];
  for (const [id, name, kind] of depots) { db.depots[id] = { id, name, location: '', code: '', kind }; db.stocks[id] = {}; }
  db.suppliers.supplier0001 = { id: 'supplier0001', name: 'Fournisseur', email: '', phone: '', note: '', leadDays: 10 };
  let n = 0;
  const locs = [];
  for (const [depotId] of depots) for (let r = 1; r <= 10; r++) for (let a = 1; a <= 10; a++) for (let e = 1; e <= 6; e++) {
    const id = `loc${(n++).toString(36).padStart(9, '0')}`;
    db.locations[id] = { id, depotId, rack: `R${r}`, allee: `A${a}`, etagere: `E${e}`, case: '', desc: '' };
    locs.push(id);
  }
  const w = weekOf(NOW);
  const eans = [];
  for (let i = 0; i < articles; i++) {
    const body = `30${String(100000000 + i).padStart(10, '0')}`;
    const ean = body + checkDigit(body);
    eans.push(ean);
    const locations = Object.fromEntries(depots.map(([depotId], k) => [depotId, [locs[k * 600 + (i % 600)]]]));
    db.articles[ean] = { ean, name: `Pièce ${i}`, family: `Famille ${i % 12}`, ref: `R-${i}`, price: 1 + (i % 40), threshold: 5 + (i % 15), photo: '', supplierId: 'supplier0001', supplierRef: '', pack: 1, locations };
    for (const [depotId] of depots) {
      db.stocks[depotId][ean] = (i * 7) % 50;
      (db.usage[depotId] ??= {})[ean] = { [w - 1]: i % 9, [w - 2]: i % 6, [w - 4]: i % 4 };
    }
  }
  for (let k = 0; k < orders; k++) {
    const id = `order${k.toString(36).padStart(8, '0')}`;
    const lines = Array.from({ length: 15 }, (_, j) => ({ ean: eans[(k * 31 + j * 17) % eans.length], name: 'x', qty: 5, shipped: 5, received: k % 3 ? 5 : undefined }));
    const status = ['submitted', 'picking', 'shipped', 'received'][k % 4];
    db.orders[id] = { id, kind: 'internal', no: k + 1, status, depotId: k % 2 ? 'depatelier01' : 'depatelier02', sourceId: 'depcentral01', lines, createdAt: NOW.toISOString(), createdBy: 'x', submittedAt: NOW.toISOString(), ...(status === 'received' ? { receivedAt: NOW.toISOString() } : {}) };
  }
  return db;
}

const timed = (fn) => { const t = performance.now(); fn(); return performance.now() - t; };

test('montée en charge : chaque écran se calcule en bien moins d\'une seconde', () => {
  const db = bigDb();
  const budgets = [
    ['accueil atelier (journée)', () => briefing(db, { depotId: 'depatelier01', role: 'manager', now: NOW }), 1500],
    ['accueil entrepôt (journée)', () => briefing(db, { depotId: 'depcentral01', role: 'manager', now: NOW }), 1500],
    ['réassort', () => reorderList(db, 'depatelier01', { withDraft: true }), 800],
    ['suggestions d\'achat', () => purchaseSuggestions(db, 'depcentral01'), 800],
    ['seuils intelligents', () => levelProposals(db, 'depatelier01', NOW), 1000],
    ['prévision de rupture', () => stockoutForecast(db, 'depatelier01', NOW), 800],
    ['liste des articles', () => searchArticles(db, 'depatelier01', {}), 800],
    ['recherche', () => searchArticles(db, 'depatelier01', { q: 'pièce 12' }), 800],
    ['plan des emplacements', () => planModel(db, 'depatelier01'), 800],
    ['indicateurs', () => kpis(db, 'depatelier01', { now: NOW }), 400],
  ];
  for (const [label, fn, budget] of budgets) {
    fn(); // premier passage (compilation, caches)
    const ms = timed(fn);
    assert.ok(ms < budget, `${label} : ${Math.round(ms)} ms (budget ${budget} ms)`);
  }
});
