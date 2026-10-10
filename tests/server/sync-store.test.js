// Journal du serveur : exécution transactionnelle, doublons, identité imposée, persistance et reprise après arrêt brutal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createSyncStore, MAX_OP_AGE_DAYS } from '../../server/sync-store.js';
import { stateHash, applyPatch, publicDb } from '../../js/core/recorder.js';
import { demoDb, tempDir, silent, byName, depotByCode, opId } from './helpers.js';

const userOf = (db, name) => { const u = byName(db, name); return { id: u.id, name: u.name, role: u.role, depotId: u.depotId }; };

async function fresh(opts = {}) {
  const dir = tempDir();
  const db = await demoDb();
  const store = createSyncStore({ dataDir: dir, log: silent, ...opts });
  store.bootstrap(db);
  return { dir, store, db: store.db };
}

function anyStocked(db, depotId) {
  const [ean, qty] = Object.entries(db.stocks[depotId]).find(([, q]) => q >= 3);
  return { ean, qty };
}

test('opération acceptée : version, événement diffusé, effet sur la base', async () => {
  const { dir, store, db } = await fresh();
  const julie = userOf(db, 'Julie Laurent');
  const { ean, qty } = anyStocked(db, julie.depotId);
  const seen = [];
  store.subscribe((ev) => seen.push(ev));
  const r = store.apply({ opId: opId(), name: 'moveStock', params: { type: 'out', ean, qty: 2 }, depotId: julie.depotId, at: new Date().toISOString() }, julie);
  assert.equal(r.status, 'ok');
  assert.equal(r.v, 1);
  assert.equal(store.db.stocks[julie.depotId][ean], qty - 2);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].name, 'moveStock');
  assert.equal(seen[0].by, 'Julie Laurent');
  store.close();
  rmSync(dir, { recursive: true });
});

test('doublon (renvoi après coupure réseau) : exécuté une seule fois', async () => {
  const { dir, store, db } = await fresh();
  const julie = userOf(db, 'Julie Laurent');
  const { ean, qty } = anyStocked(db, julie.depotId);
  const op = { opId: opId(), name: 'moveStock', params: { type: 'out', ean, qty: 1 }, depotId: julie.depotId, at: new Date().toISOString() };
  assert.equal(store.apply(op, julie).status, 'ok');
  const again = store.apply(op, julie);
  assert.deepEqual(again, { status: 'duplicate', v: 1 });
  assert.equal(store.db.stocks[julie.depotId][ean], qty - 1);
  store.close();
  rmSync(dir, { recursive: true });
});

test('refus métier : base strictement intacte, rien de journalisé', async () => {
  const { dir, store, db } = await fresh();
  const julie = userOf(db, 'Julie Laurent');
  const { ean, qty } = anyStocked(db, julie.depotId);
  const before = stateHash(store.db);
  const r = store.apply({ opId: opId(), name: 'moveStock', params: { type: 'out', ean, qty: qty + 1 }, depotId: julie.depotId, at: new Date().toISOString() }, julie);
  assert.equal(r.status, 'rejected');
  assert.match(r.message, /Stock insuffisant/);
  assert.equal(stateHash(store.db), before);
  assert.equal(store.version, 0);
  assert.equal(readFileSync(join(dir, 'events.jsonl'), 'utf8'), '');
  store.close();
  rmSync(dir, { recursive: true });
});

test('identité imposée par le serveur : un opérateur ne peut pas agir en responsable ni dans un autre dépôt', async () => {
  const { dir, store, db } = await fresh();
  const julie = userOf(db, 'Julie Laurent');
  const lyon = depotByCode(db, 'DEP-02').id;
  const { ean } = anyStocked(db, julie.depotId);
  const adj = store.apply({ opId: opId(), name: 'adjustStock', params: { ean, qty: 999 }, depotId: julie.depotId, at: new Date().toISOString() }, julie);
  assert.equal(adj.status, 'rejected');
  assert.equal(adj.code, 'forbidden');
  const other = store.apply({ opId: opId(), name: 'moveStock', params: { type: 'in', ean, qty: 1 }, depotId: lyon, at: new Date().toISOString() }, julie);
  assert.equal(other.status, 'rejected');
  assert.equal(other.code, 'forbidden');
  store.close();
  rmSync(dir, { recursive: true });
});

test('entrées invalides : identifiant, nom d\'opération, date trop ancienne, clés de prototype', async () => {
  const { dir, store, db } = await fresh();
  const julie = userOf(db, 'Julie Laurent');
  const at = new Date().toISOString();
  assert.equal(store.apply({ opId: 'BAD ID', name: 'moveStock', params: {}, at }, julie).code, 'invalid');
  assert.equal(store.apply({ opId: opId(), name: 'constructor', params: {}, at }, julie).code, 'invalid');
  assert.equal(store.apply({ opId: opId(), name: '__proto__', params: {}, at }, julie).code, 'invalid');
  const old = new Date(Date.now() - (MAX_OP_AGE_DAYS + 1) * 86_400_000).toISOString();
  assert.equal(store.apply({ opId: opId(), name: 'recordAuth', params: {}, at: old }, julie).code, 'too_old');
  const r = store.apply({ opId: opId(), name: 'moveStock', params: { type: 'in', ean: '__proto__', qty: 1 }, depotId: julie.depotId, at }, julie);
  assert.equal(r.status, 'rejected');
  assert.equal(Object.prototype.polluted, undefined);
  store.close();
  rmSync(dir, { recursive: true });
});

test('date d\'effet : celle de la saisie hors ligne (bornée), utilisée dans l\'historique', async () => {
  const { dir, store, db } = await fresh();
  const julie = userOf(db, 'Julie Laurent');
  const { ean } = anyStocked(db, julie.depotId);
  const at = new Date(Date.now() - 3 * 3_600_000).toISOString();
  store.apply({ opId: opId(), name: 'moveStock', params: { type: 'in', ean, qty: 1 }, depotId: julie.depotId, at }, julie);
  assert.equal(store.db.history[0].date, at);
  const future = new Date(Date.now() + 86_400_000).toISOString();
  store.apply({ opId: opId(), name: 'moveStock', params: { type: 'in', ean, qty: 1 }, depotId: julie.depotId, at: future }, julie);
  assert.ok(Date.parse(store.db.history[0].date) <= Date.now(), 'date future ramenée à maintenant');
  store.close();
  rmSync(dir, { recursive: true });
});

test('redémarrage : instantané + rejeu du journal → état identique ; doublons toujours reconnus', async () => {
  const { dir, store, db } = await fresh({ snapshotEvery: 3 });
  const julie = userOf(db, 'Julie Laurent');
  const { ean } = anyStocked(db, julie.depotId);
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const id = opId(i);
    ids.push(id);
    assert.equal(store.apply({ opId: id, name: 'moveStock', params: { type: 'in', ean, qty: 1 }, depotId: julie.depotId, at: new Date().toISOString() }, julie).status, 'ok');
  }
  const hash = store.hash();
  const v = store.version;
  // arrêt brutal : pas de close() → l'instantané date de la version 3, le journal porte 4 et 5
  const lines = readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  const again = createSyncStore({ dataDir: dir, log: silent });
  assert.equal(again.load(), true);
  assert.equal(again.version, v);
  assert.equal(again.hash(), hash);
  assert.deepEqual(again.eventsSince(3).map((e) => e.v), [4, 5], 'rattrapage par événements possible juste après le redémarrage');
  assert.equal(again.eventsSince(2), null, 'avant l\'instantané : rechargement complet');
  assert.equal(again.apply({ opId: ids[4], name: 'moveStock', params: { type: 'in', ean, qty: 1 }, depotId: julie.depotId, at: new Date().toISOString() }, julie).status, 'duplicate');
  assert.equal(again.apply({ opId: ids[0], name: 'moveStock', params: { type: 'in', ean, qty: 1 }, depotId: julie.depotId, at: new Date().toISOString() }, julie).status, 'duplicate');
  again.close();
  store.close();
  rmSync(dir, { recursive: true });
});

test('coupure de courant pendant une écriture : dernière ligne tronquée ignorée, le reste rejoué', async () => {
  const { dir, store, db } = await fresh();
  const julie = userOf(db, 'Julie Laurent');
  const { ean, qty } = anyStocked(db, julie.depotId);
  store.apply({ opId: opId(1), name: 'moveStock', params: { type: 'out', ean, qty: 1 }, depotId: julie.depotId, at: new Date().toISOString() }, julie);
  appendFileSync(join(dir, 'events.jsonl'), '{"v":2,"at":"2026-');
  const again = createSyncStore({ dataDir: dir, log: silent });
  again.load();
  assert.equal(again.version, 1);
  assert.equal(again.db.stocks[julie.depotId][ean], qty - 1);
  again.close();
  rmSync(dir, { recursive: true });
});

test('journal corrompu au milieu : démarrage refusé (pas de perte silencieuse)', async () => {
  const { dir, store, db } = await fresh();
  const julie = userOf(db, 'Julie Laurent');
  const { ean } = anyStocked(db, julie.depotId);
  for (let i = 0; i < 3; i++) store.apply({ opId: opId(i), name: 'moveStock', params: { type: 'in', ean, qty: 1 }, depotId: julie.depotId, at: new Date().toISOString() }, julie);
  const lines = readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n');
  lines[0] = '{corrompu';
  writeFileSync(join(dir, 'events.jsonl'), `${lines.join('\n')}\n`);
  assert.throws(() => createSyncStore({ dataDir: dir, log: silent }).load(), /ligne 1 illisible/);
  rmSync(dir, { recursive: true });
});

test('rattrapage : événements depuis une version, ou instantané si trop ancien ; diffusion sans PIN', async () => {
  const { dir, store, db } = await fresh({ keepEvents: 3 });
  const admin = userOf(db, 'Administrateur');
  const paris = depotByCode(db, 'DEP-01').id;
  const pin = byName(db, 'Julie Laurent').pin;
  for (let i = 0; i < 5; i++) store.apply({ opId: opId(i), name: 'recordAuth', params: { kind: 'login' }, depotId: paris, at: new Date().toISOString() }, admin);
  assert.deepEqual(store.eventsSince(5), []);
  assert.deepEqual(store.eventsSince(3).map((e) => e.v), [4, 5]);
  assert.equal(store.eventsSince(1), null, 'trop ancien : l\'anneau ne garde que 3 événements');
  assert.equal(store.eventsSince(9), null);
  assert.equal(store.eventsSince('abc'), null);
  const seen = [];
  store.subscribe((ev) => seen.push(ev));
  const julie = byName(store.db, 'Julie Laurent');
  store.apply({ opId: opId(9), name: 'saveUser', params: { id: julie.id, name: julie.name, role: 'operator', depotId: julie.depotId, pin }, depotId: paris, at: new Date().toISOString() }, admin);
  const userEntry = seen[0].patch.e.find(([t]) => t === 'users');
  assert.equal(userEntry[2].pin, null, 'empreinte retirée de l\'événement diffusé');
  assert.equal(userEntry[2].pinLen, 4);
  assert.ok(store.db.users[julie.id].pin.hash, 'conservée sur le serveur');
  const snap = store.snapshot();
  assert.ok(Object.values(snap.db.users).every((u) => u.pin === null));
  store.close();
  rmSync(dir, { recursive: true });
});

test('un appareil qui applique les événements obtient exactement l\'état du serveur', async () => {
  const { dir, store, db } = await fresh();
  const replica = publicDb(store.db);
  const sophie = userOf(db, 'Sophie Martin');
  const { ean } = anyStocked(db, sophie.depotId);
  store.subscribe((ev) => applyPatch(replica, ev.patch));
  const ops = [
    ['moveStock', { type: 'out', ean, qty: 1 }],
    ['adjustStock', { ean, qty: 42, reason: 'Inventaire' }],
    ['saveLocation', { depotId: sophie.depotId, rack: 'Z9', allee: 'A1', desc: 'Test' }],
  ];
  for (const [i, [name, params]] of ops.entries()) {
    assert.equal(store.apply({ opId: opId(i), name, params, depotId: sophie.depotId, at: new Date().toISOString() }, sophie).status, 'ok', name);
  }
  assert.equal(stateHash(replica), store.hash());
  store.close();
  rmSync(dir, { recursive: true });
});

test('restauration : événement de remise à zéro, persistant après redémarrage', async () => {
  const { dir, store } = await fresh();
  const seen = [];
  store.subscribe((ev) => seen.push(ev));
  const next = await demoDb();
  next.meta.demo = false;
  store.replace(next);
  assert.deepEqual(seen, [{ v: 1, reset: true }]);
  assert.equal(store.eventsSince(0), null, 'les appareils doivent recharger un instantané');
  store.close();
  const again = createSyncStore({ dataDir: dir, log: silent });
  again.load();
  assert.equal(again.version, 1);
  assert.equal(again.db.meta.demo, false);
  again.close();
  rmSync(dir, { recursive: true });
});
