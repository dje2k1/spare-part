// Enregistreur de modifications (synchronisation) : delta exact, retour arrière total, robustesse aux
// paramètres hostiles. Ce sont les garanties dont dépend le serveur.
import test from 'node:test';
import assert from 'node:assert/strict';
import { record, runRecorded, applyPatch, publicPatch, publicDb, stateHash } from '../../js/core/recorder.js';
import { OPS, opName, isOpName } from '../../js/core/registry.js';
import { seededIds } from '../../js/core/ops-kit.js';
import { stockOf } from '../../js/core/queries.js';
import { NOW, IDS, EAN, ORG, orgDb, ctxFor, prng, FAKE_PIN } from './helpers.js';

const DAY = 86_400_000;
const exec = (db, name, ctx, params) => runRecorded(db, (d) => OPS[name](d, ctx, params));
const core = (db) => JSON.parse(JSON.stringify({ ...db, history: db.history.slice(0, 20), audit: db.audit.slice(0, 20), meta: { ...db.meta, rev: 0 } }));

test('registre : noms stables, aller-retour fonction ↔ nom', () => {
  for (const [name, fn] of Object.entries(OPS)) assert.equal(opName(fn), name);
  assert.throws(() => opName(() => {}), /non enregistrée/);
  assert.ok(isOpName('moveStock'));
  for (const bad of ['__proto__', 'constructor', 'toString', '', null, 3]) assert.ok(!isOpName(bad), String(bad));
});

test('delta d\'une sortie : stock, consommation, journaux — appliqué ailleurs, même état', () => {
  const server = orgDb();
  const replica = structuredClone(server);
  const { result, patch } = exec(server, 'moveStock', ctxFor(server, 'opParis'), { type: 'out', ean: EAN.zip, qty: 3 });
  assert.equal(result.stock, 17);
  assert.deepEqual(patch.e2.map(([t, k1, k2]) => [t, k1, k2]).sort(), [['stocks', IDS.paris, EAN.zip], ['usage', IDS.paris, null]].sort());
  assert.equal(patch.log.history.pre.length, 1);
  assert.equal(patch.log.audit.pre.length, 1);
  assert.equal(patch.e.length, 0, 'aucune entité de référence touchée');
  applyPatch(replica, patch);
  assert.deepEqual(core(replica), core(server));
  assert.equal(stateHash(replica), stateHash(server));
});

test('retour arrière : une erreur au milieu d\'une opération ne laisse aucune trace', () => {
  const db = orgDb();
  const before = JSON.stringify(db);
  const ctx = ctxFor(db, 'admin');
  assert.throws(() => runRecorded(db, (d) => {
    OPS.moveStock(d, ctx, { type: 'in', ean: EAN.zip, qty: 5, locCode: 'R9-A9' });
    d.articles[EAN.button].name = 'modifié';
    delete d.articles[EAN.clasp];
    d.levels[IDS.paris] = { [EAN.zip]: { min: 1, max: 2 } };
    d.meta.orderSeq = 99;
    d.history.length = 0;
    throw new TypeError('panne simulée');
  }), /panne simulée/);
  assert.equal(JSON.stringify(db), before);
  // Erreur métier tardive (après mutation) : idem
  assert.throws(() => runRecorded(db, (d) => { OPS.moveStock(d, ctx, { type: 'out', ean: EAN.zip, qty: 1 }); OPS.moveStock(d, ctx, { type: 'out', ean: EAN.zip, qty: 999 }); }), /Stock insuffisant/);
  assert.equal(JSON.stringify(db), before);
});

test('écritures interdites : remplacement d\'une table, écriture directe dans un journal', () => {
  const db = orgDb();
  const rec = record(db);
  assert.throws(() => { rec.proxy.articles = {}; }, /ne peut pas être remplacée/);
  assert.throws(() => { rec.proxy.history[0] = {}; }, /écriture directe interdite/);
  assert.throws(() => rec.proxy.history.push({}), /insertion en tête/);
});

test('identifiants déterministes : l\'appareil et le serveur créent les mêmes objets', () => {
  const a = orgDb(), b = orgDb();
  const opId = 'mvabcdef0123456789xy';
  const ctx = (db) => ({ ...ctxFor(db, 'opParis'), uid: seededIds(opId) });
  const ra = OPS.moveStock(a, ctx(a), { type: 'out', ean: EAN.zip, qty: 2 });
  const rb = OPS.moveStock(b, ctx(b), { type: 'out', ean: EAN.zip, qty: 2 });
  assert.equal(ra.historyId, rb.historyId);
  assert.equal(a.audit[0].id, b.audit[0].id);
  assert.ok(ra.historyId.startsWith(opId));
});

test('PIN jamais diffusés : delta et copie publique sans empreinte', () => {
  const db = orgDb();
  const { patch } = exec(db, 'saveUser', ctxFor(db, 'admin'), { name: 'Nouvelle', role: 'operator', depotId: IDS.paris, pin: { ...FAKE_PIN } });
  const pub = publicPatch(patch);
  const user = pub.e.find(([t]) => t === 'users')[2];
  assert.equal(user.pin, null);
  assert.equal(user.pinLen, 4, 'longueur conservée pour l\'affichage du clavier');
  assert.ok(patch.e.find(([t]) => t === 'users')[2].pin.hash, 'le serveur garde l\'empreinte');
  assert.ok(Object.values(publicDb(db).users).every((u) => u.pin === null));
  assert.equal(stateHash(publicDb(db)), stateHash(db), 'les PIN ne font pas partie de l\'empreinte d\'état');
});

/** Générateur d'opérations aléatoires sur une organisation (stock, transferts, commandes, achats, seuils). */
function randomOp(db, rnd) {
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const eans = Object.keys(db.articles);
  const ateliers = [['opParis', IDS.paris], ['mgrParis', IDS.paris], ['opLyon', IDS.lyon], ['mgrLyon', IDS.lyon]];
  const [who, depot] = pick(ateliers);
  const orders = Object.values(db.orders);
  const r = rnd();
  if (r < 0.25) return ['moveStock', who, { type: rnd() < 0.5 ? 'in' : 'out', ean: pick(eans), qty: 1 + Math.floor(rnd() * 8) }];
  if (r < 0.32) return ['createTransfer', who, { ean: pick(eans), qty: 1 + Math.floor(rnd() * 3), toDepotId: depot === IDS.paris ? IDS.lyon : IDS.paris }];
  if (r < 0.38) { const t = pick(Object.values(db.transfers).filter((x) => x.status === 'pending')); return t ? [rnd() < 0.7 ? 'receiveTransfer' : 'cancelTransfer', 'admin', { id: t.id }] : null; }
  if (r < 0.50) return ['setDraftLines', who, { lines: [{ ean: pick(eans), qty: Math.floor(rnd() * 6) }] }];
  if (r < 0.58) { const d = orders.find((o) => o.status === 'draft'); return d ? ['submitOrder', 'admin', { id: d.id }] : null; }
  if (r < 0.66) { const s = pick(orders.filter((o) => o.kind === 'internal' && o.status === 'submitted')); return s ? ['claimOrder', 'lea', { id: s.id }] : null; }
  if (r < 0.76) { const s = pick(orders.filter((o) => o.kind === 'internal' && (o.status === 'picking' || o.status === 'submitted'))); return s ? ['shipOrder', 'karim', { id: s.id, lines: s.lines.map((l) => ({ ean: l.ean, qty: Math.min(l.qty, stockOf(db, ORG.central, l.ean)) })) }] : null; }
  if (r < 0.84) { const s = pick(orders.filter((o) => o.status === 'shipped')); return s ? ['receiveOrder', 'admin', { id: s.id, lines: s.lines.map((l) => ({ ean: l.ean, qty: Math.max(0, (l.shipped ?? 0) - (rnd() < 0.2 ? 1 : 0)) })) }] : null; }
  if (r < 0.88) return ['savePurchaseDraft', 'karim', { supplierId: ORG.ykk, lines: [{ ean: pick(eans), qty: 10 + Math.floor(rnd() * 50) }] }];
  if (r < 0.91) { const p = orders.find((o) => o.kind === 'supplier' && o.status === 'draft'); return p ? ['sendPurchase', 'karim', { id: p.id }] : null; }
  if (r < 0.94) { const p = pick(orders.filter((o) => o.kind === 'supplier' && (o.status === 'sent' || o.status === 'partial'))); return p ? ['receivePurchase', 'lea', { id: p.id, lines: p.lines.map((l) => ({ ean: l.ean, qty: Math.ceil((l.qty - (l.received ?? 0)) / 2) })) }] : null; }
  if (r < 0.97) return ['setLevels', 'mgrParis', { items: [{ ean: pick(eans), min: Math.floor(rnd() * 10), max: 10 + Math.floor(rnd() * 20) }] }];
  return ['upsertArticle', 'mgrParis', { ean: pick(eans), name: `Article ${Math.floor(rnd() * 100)}`, threshold: Math.floor(rnd() * 20) }];
}

test('propriété : 600 opérations aléatoires — l\'appareil qui applique les deltas reste identique au serveur', () => {
  const server = orgDb();
  const replica = publicDb(server);
  const rnd = prng(42);
  let applied = 0, refused = 0;
  for (let i = 0; i < 600; i++) {
    const op = randomOp(server, rnd);
    if (!op) continue;
    const [name, who, params] = op;
    const ctx = { ...ctxFor(server, who, { now: new Date(NOW.getTime() + i * 3_600_000) }), limits: { history: 1e9, audit: 1e9 } };
    const before = stateHash(server);
    const len = server.history.length;
    try {
      const { patch } = exec(server, name, ctx, params);
      applyPatch(replica, publicPatch(patch));
      applied++;
    } catch (e) {
      assert.ok(e.isOpError, `${name} : erreur non métier ${e.stack}`);
      assert.equal(stateHash(server), before, `${name} refusé mais base modifiée`);
      assert.equal(server.history.length, len);
      refused++;
    }
    if (i % 25 === 0) assert.equal(stateHash(replica), stateHash(server), `divergence après l'opération ${i} (${name})`);
  }
  assert.equal(stateHash(replica), stateHash(server));
  assert.deepEqual(replica.history.map((h) => h.id), server.history.map((h) => h.id));
  assert.ok(applied > 250 && refused > 10, `${applied} appliquées, ${refused} refusées`);
  for (const s of Object.values(server.stocks)) for (const q of Object.values(s)) assert.ok(Number.isInteger(q) && q >= 0);
});

test('fuzz : paramètres hostiles sur TOUTES les opérations — jamais de base corrompue ni de prototype pollué', () => {
  const db = orgDb();
  const GARBAGE = [
    undefined, null, 0, -1, 'x', [], [{}], {}, { id: '__proto__' }, { id: 'constructor' }, { id: 'toString' },
    { ean: '__proto__', qty: 1 }, { depotId: '__proto__', toDepotId: 'constructor' }, { lines: [{ ean: '__proto__', qty: 1 }] },
    { lines: [{ ean: EAN.zip, qty: 1e12 }] }, { lines: 'x' }, { items: [{ ean: EAN.zip, min: 'abc' }] }, { rows: [{ __proto__: { polluted: 1 } }] },
    JSON.parse('{"__proto__":{"polluted":"oui"},"id":"x"}'), { type: 'in', ean: EAN.zip, qty: '2; DROP TABLE' }, { pin: { alg: 'x' }, name: 'A', role: 'admin', depotId: IDS.paris },
    { name: 'A'.repeat(10000), role: 'admin', depotId: IDS.paris }, { kind: 'central', name: 'Z' }, { supplierId: '__proto__', lines: [{ ean: EAN.zip, qty: 1 }] },
  ];
  const users = ['admin', 'mgrParis', 'opParis', 'karim', 'lea', 'opLyon'];
  let n = 0;
  for (const name of Object.keys(OPS)) {
    for (const params of GARBAGE) {
      for (const who of users) {
        const before = stateHash(db);
        const hl = db.history.length;
        try { exec(db, name, { ...ctxFor(db, who), uid: seededIds(`fuzz${n}`.padEnd(12, '0')) }, params); } catch {
          assert.equal(stateHash(db), before, `${name} a échoué en laissant la base modifiée (${JSON.stringify(params)?.slice(0, 80)}, ${who})`);
          assert.equal(db.history.length, hl);
        }
        n++;
      }
    }
  }
  assert.equal(({}).polluted, undefined, 'Object.prototype pollué');
  for (const table of ['depots', 'users', 'articles', 'locations', 'suppliers', 'orders', 'transfers', 'stocks', 'levels', 'usage']) {
    for (const k of ['__proto__', 'constructor', 'toString', 'undefined', 'null']) assert.ok(!Object.hasOwn(db[table], k), `${table}.${k}`);
    assert.equal(Object.getPrototypeOf(db[table]), Object.prototype, `${table} : prototype remplacé`);
  }
  assert.ok(n > 4000, `${n} appels`);
});
