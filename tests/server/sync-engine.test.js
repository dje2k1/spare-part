// Moteur de synchronisation des appareils, testé contre le VRAI serveur : deux appareils, saisie hors ligne,
// redémarrage de l'application, conflit entre sites, réponse perdue, session expirée, contrôle d'intégrité.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createSyncEngine } from '../../js/core/sync-engine.js';
import { KEYS } from '../../js/core/config.js';
import { stateHash } from '../../js/core/recorder.js';
import { startApp, depotByCode } from './helpers.js';
import { memoryStorage } from '../unit/helpers.js';

let srv;
before(async () => { srv = await startApp(); });
after(async () => { await srv?.stop(); });

function memoryReplica() {
  let data = null;
  return { load: async () => (data ? structuredClone(data) : null), save: (s) => { data = structuredClone(s); }, get data() { return data; } };
}

/** Un « appareil » : stockage local, copie locale, client HTTP avec cookie, réseau coupable. */
async function device(name, pin, { storage = memoryStorage(), replica = memoryReplica(), http } = {}) {
  const c = http ?? srv.client();
  const me = http ? null : await c.login(name, pin);
  const net = { offline: false, loseNextResponse: false };
  const api = {
    async get(p) { if (net.offline) throw new TypeError('Failed to fetch'); return c.get(p); },
    async post(p, b) {
      if (net.offline) throw new TypeError('Failed to fetch');
      const r = await c.post(p, b);
      if (net.loseNextResponse) { net.loseNextResponse = false; throw new TypeError('network error'); }
      return r;
    },
  };
  const engine = createSyncEngine({ api, storage, replica, log: { warn() {}, error() {} }, setTimer: () => null, clearTimer: () => {} });
  await engine.init();
  if (me) engine.setSession(me.user.id);
  const ctx = () => ({ user: me.user, depotId: me.depotId, now: new Date() });
  return { engine, net, me, c, storage, replica, ctx, run: (op, params) => engine.submit(op, params, ctx()) };
}

const stockOf = (db, depotId, ean) => db.stocks[depotId]?.[ean] ?? 0;
const confirmedHash = () => srv.app.store.hash();

test('deux appareils : une saisie sur l\'un apparaît sur l\'autre ; états identiques au serveur', async () => {
  const a = await device('Sophie Martin', '2345');
  const b = await device('Marc Dubois', '3456');
  await a.engine.resync();
  await b.engine.resync();
  const ean = Object.keys(a.engine.db.stocks[a.me.depotId]).find((k) => a.engine.db.stocks[a.me.depotId][k] >= 5);
  const was = stockOf(a.engine.db, a.me.depotId, ean);
  a.run('moveStock', { type: 'out', ean, qty: 2 });
  assert.equal(stockOf(a.engine.db, a.me.depotId, ean), was - 2, 'effet immédiat sur l\'appareil');
  assert.equal(a.engine.status().mine, 1);
  await a.engine.flush();
  assert.equal(a.engine.status().pending, 0);
  assert.equal(stockOf(srv.app.store.db, a.me.depotId, ean), was - 2);
  await b.engine.resync();
  assert.equal(stockOf(b.engine.db, a.me.depotId, ean), was - 2, 'visible sur l\'autre appareil');
  assert.equal(await a.engine.verify(), true);
  assert.equal(await b.engine.verify(), true);
  assert.equal(stateHash(b.engine.db), confirmedHash());
});

test('hors ligne : saisies conservées après fermeture de l\'application, envoyées au retour du réseau, mêmes identifiants', async () => {
  const a = await device('Sophie Martin', '2345');
  await a.engine.resync();
  a.engine.persist();
  a.net.offline = true;
  const lyon = depotByCode(a.engine.db, 'DEP-02').id;
  const ean = Object.keys(a.engine.db.stocks[a.me.depotId]).find((k) => a.engine.db.stocks[a.me.depotId][k] >= 6);
  const was = stockOf(a.engine.db, a.me.depotId, ean);
  a.run('moveStock', { type: 'out', ean, qty: 1 });
  const t = a.run('createTransfer', { toDepotId: lyon, ean, qty: 2 });
  assert.ok(t.transferId, 'transfert créé hors ligne');
  await a.engine.flush(); // échec réseau : nouvelle tentative programmée
  assert.equal(a.engine.status().reachable, false);
  assert.equal(JSON.parse(a.storage.getItem(KEYS.syncQueue)).length, 2, 'file d\'attente persistée');
  // l'application est fermée puis rouverte (même stockage, même copie locale)
  const again = await device(null, null, { storage: a.storage, replica: a.replica, http: a.c });
  again.engine.setSession(a.me.user.id);
  assert.equal(stockOf(again.engine.db, a.me.depotId, ean), was - 3, 'saisies hors ligne toujours visibles');
  assert.ok(again.engine.db.transfers[t.transferId]);
  await again.engine.flush();
  assert.equal(again.engine.status().pending, 0);
  assert.ok(srv.app.store.db.transfers[t.transferId], 'le serveur a créé le transfert avec le même identifiant');
  assert.equal(stockOf(srv.app.store.db, a.me.depotId, ean), was - 3);
  assert.equal(await again.engine.verify(), true);
});

test('conflit entre deux sites hors ligne : le second refusé, motif signalé, base corrigée', async () => {
  const admin = await device('Administrateur', '1234');
  await admin.engine.resync();
  const paris = depotByCode(admin.engine.db, 'DEP-01').id;
  const ean = Object.keys(admin.engine.db.articles)[0];
  admin.engine.submit('adjustStock', { ean, qty: 4, reason: 'Inventaire' }, { ...admin.ctx(), depotId: paris });
  await admin.engine.flush();
  const s1 = await device('Sophie Martin', '2345');
  const s2 = await device('Julie Laurent', '4567');
  await s1.engine.resync();
  await s2.engine.resync();
  s1.net.offline = true;
  s2.net.offline = true;
  s1.run('moveStock', { type: 'out', ean, qty: 3 });
  s2.run('moveStock', { type: 'out', ean, qty: 3 });
  assert.equal(stockOf(s2.engine.db, paris, ean), 1, 'chacun voit sa sortie appliquée');
  const rejected = [];
  s2.engine.subscribe((type, d) => { if (type === 'rejected') rejected.push(...d); });
  s1.net.offline = false;
  await s1.engine.flush();
  s2.net.offline = false;
  await s2.engine.flush();
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].message, /Stock insuffisant/);
  assert.match(rejected[0].label, /^Sortie · 3 × /);
  assert.equal(stockOf(s2.engine.db, paris, ean), 1, 'la base affichée reflète la vérité du serveur');
  assert.equal(stockOf(srv.app.store.db, paris, ean), 1);
  assert.equal(s2.engine.status().rejected.length, 1);
  s2.engine.acknowledgeRejected();
  assert.equal(s2.engine.status().rejected.length, 0);
});

test('réponse perdue : renvoi reconnu comme doublon, aucune double application', async () => {
  const a = await device('Karim Benali', '2468');
  await a.engine.resync();
  const ean = Object.keys(a.engine.db.stocks[a.me.depotId])[0];
  const was = stockOf(srv.app.store.db, a.me.depotId, ean);
  a.run('moveStock', { type: 'in', ean, qty: 5 });
  a.net.loseNextResponse = true;
  await a.engine.flush(); // le serveur a appliqué, l'appareil ne le sait pas
  assert.equal(a.engine.status().pending, 1);
  assert.equal(stockOf(a.engine.db, a.me.depotId, ean), was + 5);
  await a.engine.flush();
  assert.equal(a.engine.status().pending, 0);
  assert.equal(stockOf(srv.app.store.db, a.me.depotId, ean), was + 5, 'appliqué une seule fois');
  assert.equal(stockOf(a.engine.db, a.me.depotId, ean), was + 5);
});

test('réponse perdue puis instantané : l\'opération déjà intégrée n\'est pas rejouée en double', async () => {
  const a = await device('Karim Benali', '2468');
  await a.engine.resync();
  const ean = Object.keys(a.engine.db.stocks[a.me.depotId])[1];
  const was = stockOf(srv.app.store.db, a.me.depotId, ean);
  a.run('moveStock', { type: 'in', ean, qty: 2 });
  a.net.loseNextResponse = true;
  await a.engine.flush();
  a.engine.loadSnapshot((await a.c.get('/api/snapshot')).json);
  assert.equal(a.engine.status().pending, 0, 'retirée de la file grâce à la liste des opérations intégrées');
  assert.equal(stockOf(a.engine.db, a.me.depotId, ean), was + 2);
});

test('file partagée entre comptes : seules les opérations du compte connecté partent', async () => {
  const storage = memoryStorage();
  const julie = await device('Julie Laurent', '4567', { storage });
  await julie.engine.resync();
  julie.net.offline = true;
  const ean = Object.keys(julie.engine.db.stocks[julie.me.depotId]).find((k) => julie.engine.db.stocks[julie.me.depotId][k] >= 3);
  julie.run('moveStock', { type: 'out', ean, qty: 1 });
  // Julie se déconnecte ; Sophie se connecte sur le même appareil
  const sophie = await device('Sophie Martin', '2345', { storage, replica: julie.replica });
  await sophie.engine.resync();
  sophie.run('moveStock', { type: 'in', ean, qty: 1 });
  await sophie.engine.flush();
  const st = sophie.engine.status();
  assert.equal(st.mine, 0);
  assert.equal(st.pending, 1);
  assert.deepEqual(st.others, ['Julie Laurent']);
});

test('session expirée : les opérations restent en attente, état « expired » signalé', async () => {
  const a = await device('Léa Moreau', '1357');
  await a.engine.resync();
  const ean = Object.keys(a.engine.db.stocks[a.me.depotId])[0];
  a.run('moveStock', { type: 'in', ean, qty: 1 });
  srv.app.auth.revokeUser(a.me.user.id);
  const states = [];
  a.engine.subscribe((type, d) => { if (type === 'auth') states.push(d); });
  await a.engine.flush();
  assert.deepEqual(states, ['expired']);
  assert.equal(a.engine.status().pending, 1);
});

test('contrôle d\'intégrité : une divergence est détectée et corrigée par un rechargement complet', async () => {
  const a = await device('Sophie Martin', '2345');
  await a.engine.resync();
  const ean = Object.keys(a.engine.db.stocks[a.me.depotId])[0];
  a.engine.db.stocks[a.me.depotId][ean] += 1000; // corruption locale simulée
  assert.equal(await a.engine.verify(), false);
  assert.equal(await a.engine.verify(), true);
  assert.equal(stockOf(a.engine.db, a.me.depotId, ean), stockOf(srv.app.store.db, a.me.depotId, ean));
});

test('flux temps réel : événement manquant → rattrapage automatique', async () => {
  const a = await device('Sophie Martin', '2345');
  const b = await device('Marc Dubois', '3456');
  await a.engine.resync();
  await b.engine.resync();
  const ean = Object.keys(a.engine.db.stocks[a.me.depotId])[2];
  const events = [];
  const unsub = srv.app.store.subscribe((ev) => events.push(ev));
  a.run('moveStock', { type: 'in', ean, qty: 1 });
  a.run('moveStock', { type: 'in', ean, qty: 1 });
  await a.engine.flush();
  unsub();
  assert.equal(events.length, 2);
  b.engine.receive(events[1]); // le premier s'est perdu
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(b.engine.version, events[1].v);
  assert.equal(stockOf(b.engine.db, a.me.depotId, ean), stockOf(srv.app.store.db, a.me.depotId, ean));
});
