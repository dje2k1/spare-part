import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { emptyDb, normalizeDb, deriveDelta, makeBackup, parseBackup } from '../../js/core/schema.js';
import { createStore } from '../../js/core/store.js';
import { KEYS, LIMITS, DB_VERSION } from '../../js/core/config.js';
import { OpError } from '../../js/core/ops-kit.js';
import { NOW, memoryStorage, smallDb, FAKE_PIN, IDS, EAN } from './helpers.js';

const legacy = () => JSON.parse(readFileSync(new URL('../fixtures/dior_v4.json', import.meta.url), 'utf8'));

test('normalizeDb refuse ce qui n\'est pas un objet', () => {
  for (const bad of [null, undefined, 'x', 3, []]) assert.throws(() => normalizeDb(bad, NOW), /invalide/);
});

test('migration du VRAI jeu de données dior_v4 (démo d\'origine)', () => {
  const { db, notes } = normalizeDb(legacy(), NOW);
  assert.equal(db.v, DB_VERSION);
  assert.equal(Object.keys(db.depots).length, 3);
  assert.equal(Object.keys(db.users).length, 5);
  assert.equal(Object.keys(db.articles).length, 17);
  assert.equal(db.history.length, 83);
  assert.equal(Object.keys(db.transfers).length, 3);
  assert.ok(Object.values(db.depots).every((d) => d.kind === 'atelier'), 'v5 → v6 : dépôts « atelier » par défaut');
  assert.ok(Object.keys(db.usage).length > 0, 'consommation reconstruite depuis l\'historique');
  assert.ok(notes.some((n) => /migrées/.test(n)));
  // PIN en clair → conservés uniquement pour être hachés au démarrage
  const admin = Object.values(db.users).find((u) => u.role === 'admin');
  assert.equal(admin.pin, null);
  assert.equal(admin.pinLegacy, '1234');
  // emplacements des articles : toujours des tableaux d'identifiants existants
  for (const a of Object.values(db.articles)) {
    for (const [depotId, ids] of Object.entries(a.locations)) {
      assert.ok(Array.isArray(ids) && ids.length);
      for (const id of ids) assert.equal(db.locations[id].depotId, depotId);
    }
  }
  // chaque ligne d'historique porte un delta cohérent et un identifiant
  for (const h of db.history) {
    assert.ok(Number.isFinite(h.delta));
    assert.match(h.id, /^[0-9a-z]{8,40}$/);
    assert.match(h.date, /^\d{4}-\d\d-\d\dT/);
  }
  assert.ok(db.history.every((h, i, a) => i === 0 || a[i - 1].date >= h.date), 'trié du plus récent au plus ancien');
  // la base migrée n'est PAS marquée « démo » (pas d'aide de connexion avec PIN)
  assert.equal(db.meta.demo, false);
  assert.equal(db.meta.demoPins, undefined);
});

test('deriveDelta : sens de chaque type de mouvement', () => {
  assert.equal(deriveDelta({ type: 'in', qty: 4 }), 4);
  assert.equal(deriveDelta({ type: 'out', qty: 4 }), -4);
  assert.equal(deriveDelta({ type: 'transfer', qty: 4 }), -4);
  assert.equal(deriveDelta({ type: 'transfer_in', qty: 4 }), 4);
  assert.equal(deriveDelta({ type: 'transfer_cancel', qty: 4 }), 4);
  assert.equal(deriveDelta({ type: 'inv', qty: 9, diff: -3 }), -3);
  assert.equal(deriveDelta({ type: 'inv', qty: 9 }), 0);
  assert.equal(deriveDelta({ type: 'in', qty: 4, delta: 7 }), 7);
});

test('normalizeDb écarte les données invalides sans planter', () => {
  const raw = smallDb();
  raw.articles['abc'] = { ean: 'abc', name: 'EAN invalide' };
  raw.articles['12345678'] = { ean: '12345678', name: '   ' };
  raw.articles['99999999'] = { ean: '99999999', name: 'Photo piégée', photo: 'javascript:alert(1)', price: -5, threshold: 'x' };
  raw.stocks[IDS.paris]['99999999'] = -12;
  raw.stocks['depotfantome1'] = { [EAN.zip]: 5 };
  raw.users[IDS.opParis].role = 'superman';
  raw.users['usernodepot1'] = { id: 'usernodepot1', name: 'Orphelin', role: 'admin', depotId: 'inconnu', pin: FAKE_PIN };
  raw.locations['locorphelin1'] = { id: 'locorphelin1', depotId: 'inconnu', rack: 'R1' };
  raw.history.push({ id: 'h1', type: 'teleportation', ean: EAN.zip, depotId: IDS.paris, qty: 1 });
  const { db, notes } = normalizeDb(JSON.parse(JSON.stringify(raw)), NOW);
  assert.ok(!db.articles.abc);
  assert.ok(!db.articles['12345678']);
  assert.equal(db.articles['99999999'].photo, '');
  assert.equal(db.articles['99999999'].price, 0);
  assert.equal(db.articles['99999999'].threshold, 0);
  assert.equal(db.stocks[IDS.paris]['99999999'], 0);
  assert.ok(!db.stocks.depotfantome1);
  assert.equal(db.users[IDS.opParis].role, 'operator');
  assert.ok(!db.users.usernodepot1);
  assert.ok(!db.locations.locorphelin1);
  assert.equal(db.history.length, 0);
  assert.ok(notes.length >= 3);
});

test('normalizeDb : dates naïves → ISO, plafonds d\'historique/audit, identifiants sûrs', () => {
  const raw = smallDb();
  raw.history = Array.from({ length: LIMITS.history + 50 }, (_, i) => ({ id: `h${String(i).padStart(8, '0')}`, ean: EAN.zip, name: 'Zip', type: 'in', qty: 1, depotId: IDS.paris, operator: 'x', date: new Date(NOW - i * 1000).toISOString() }));
  raw.history[0].date = '2026-10-10T11:59:59';
  raw.audit = Array.from({ length: LIMITS.audit + 10 }, (_, i) => ({ id: `a${String(i).padStart(8, '0')}`, type: 'in', action: `n${i}`, operator: 'x', date: new Date(NOW - i * 1000).toISOString(), meta: {} }));
  const { db } = normalizeDb(raw, NOW);
  assert.equal(db.history.length, LIMITS.history);
  assert.equal(db.audit.length, LIMITS.audit);
  assert.match(db.history[0].date, /Z$/);
  raw.depots['<script>'] = { id: '<script>', name: 'x' };
  assert.ok(!normalizeDb(raw, NOW).db.depots['<script>']);
});

test('sauvegarde : aller-retour et rejets', () => {
  const db = smallDb();
  const text = makeBackup(db, NOW);
  const back = parseBackup(text, NOW);
  assert.equal(Object.keys(back.db.articles).length, 3);
  assert.equal(back.exportedAt, NOW.toISOString());
  assert.throws(() => parseBackup('pas du json', NOW), /JSON illisible/);
  assert.throws(() => parseBackup(JSON.stringify({ app: 'autre', data: {} }), NOW), /pas une sauvegarde MODE Stock/);
  assert.throws(() => parseBackup(JSON.stringify({ app: 'mode-stock', schema: 99, data: db }), NOW), /plus récente/);
  assert.throws(() => parseBackup('x'.repeat(LIMITS.backupBytes + 1), NOW), /volumineux/);
  const noAdmin = JSON.parse(text);
  for (const u of Object.values(noAdmin.data.users)) u.role = 'operator';
  assert.throws(() => parseBackup(JSON.stringify(noAdmin), NOW), /administrateur/);
  const noDepot = JSON.parse(text);
  noDepot.data.depots = {};
  assert.throws(() => parseBackup(JSON.stringify(noDepot), NOW), /dépôt/);
});

// ── Store ──
test('store : installation vide → isEmpty ; replace persiste et relit', () => {
  const storage = memoryStorage();
  const s = createStore({ storage, now: () => NOW });
  assert.equal(s.load(), null);
  assert.ok(s.isEmpty);
  s.replace(smallDb());
  assert.ok(!s.isEmpty);
  const s2 = createStore({ storage, now: () => NOW });
  assert.equal(Object.keys(s2.load().articles).length, 3);
});

test('store : migration dior_v4 → v5, ancienne copie (PIN en clair) supprimée après relecture', () => {
  const storage = memoryStorage();
  storage.setItem(KEYS.legacyDb, JSON.stringify(legacy()));
  const s = createStore({ storage, now: () => NOW });
  const db = s.load();
  assert.ok(db);
  assert.ok(s.status.migrated);
  assert.equal(storage.getItem(KEYS.legacyDb), null, 'copie en clair supprimée');
  assert.ok(storage.getItem(KEYS.db));
  assert.ok(!storage.getItem(KEYS.db).includes('"pin":"1234"'), 'aucun PIN en clair dans la base v5');
  assert.equal(JSON.parse(storage.getItem(KEYS.db)).v, DB_VERSION);
});

test('store : données illisibles → quarantaine, jamais écrasées', () => {
  const storage = memoryStorage();
  storage.setItem(KEYS.db, '{corrompu!!');
  const s = createStore({ storage, now: () => NOW });
  assert.equal(s.load(), null);
  assert.ok(s.status.recovered);
  assert.equal(storage.getItem(KEYS.db), '{corrompu!!', 'original intact');
  assert.equal(storage.getItem(`${KEYS.db}.corrupt`), '{corrompu!!', 'copie de sauvegarde');
});

test('store : quota dépassé → élagage des journaux puis nouvelle tentative', () => {
  const db = smallDb();
  db.history = Array.from({ length: 800 }, (_, i) => ({ id: `h${String(i).padStart(8, '0')}`, ean: EAN.zip, name: 'Zip YKK', type: 'in', qty: 1, delta: 1, depotId: IDS.paris, depotName: 'Atelier Paris', operator: 'Julie', date: new Date(NOW - i * 1000).toISOString() }));
  const full = JSON.stringify(db).length;
  const storage = memoryStorage({ limit: Math.floor(full * 0.8) });
  const s = createStore({ storage, now: () => NOW });
  const events = [];
  s.subscribe((e) => events.push(e));
  s.replace(db);
  assert.ok(events.includes('trimmed'), `événements : ${events}`);
  assert.ok(s.status.trimmed);
  assert.ok(s.db.history.length < 800);
  assert.ok(storage.getItem(KEYS.db));
});

test('store : quota définitivement dépassé → save-error, aucune exception', () => {
  const storage = memoryStorage({ limit: 50 });
  const s = createStore({ storage, now: () => NOW });
  const events = [];
  s.subscribe((e) => events.push(e));
  assert.equal(s.replace(smallDb()), false);
  assert.ok(events.includes('save-error'));
  assert.ok(s.status.saveError);
});

test('store.run : OpError = rien modifié ; autre erreur = rollback sur l\'état persistant', () => {
  const storage = memoryStorage();
  const s = createStore({ storage, now: () => NOW });
  s.replace(smallDb());
  assert.throws(() => s.run((db) => { throw new OpError('refusé'); }), /refusé/);
  assert.equal(s.db.stocks[IDS.paris][EAN.zip], 20);

  assert.throws(() => s.run((db) => { db.stocks[IDS.paris][EAN.zip] = 999; throw new Error('bug inattendu'); }), /bug inattendu/);
  assert.equal(s.db.stocks[IDS.paris][EAN.zip], 20, 'modification partielle annulée');

  s.run((db) => { db.stocks[IDS.paris][EAN.zip] = 21; });
  assert.equal(createStore({ storage, now: () => NOW }).load().stocks[IDS.paris][EAN.zip], 21, 'persisté');
});

test('store : sauvegarde exportée → plus de modification en attente', () => {
  const s = createStore({ storage: memoryStorage(), now: () => NOW });
  s.replace(smallDb());
  assert.ok(s.changesSinceBackup() > 0);
  const text = s.exportBackup();
  assert.equal(s.changesSinceBackup(), 0);
  assert.equal(s.db.meta.lastBackupAt, NOW.toISOString());
  s.run((db) => { db.stocks[IDS.paris][EAN.zip] = 1; });
  assert.equal(s.changesSinceBackup(), 1);
  assert.equal(parseBackup(text, NOW).db.stocks[IDS.paris][EAN.zip], 20);
  assert.equal(s.importBackup(text).db.stocks[IDS.paris][EAN.zip], 20);
});

test('store : événements et abonnement', () => {
  const s = createStore({ storage: memoryStorage(), now: () => NOW });
  const seen = [];
  const off = s.subscribe((e) => seen.push(e));
  s.replace(smallDb());
  s.run(() => {});
  off();
  s.run(() => {});
  assert.deepEqual(seen.filter((e) => e !== 'saved'), ['replaced', 'changed']);
});
