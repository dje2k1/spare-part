import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPin, verifyPin, pinPolicy, can, lockDelay, createLockout, isIdle, upgradeLegacyPins, isPinRecord, isStrongPinRecord, PBKDF2_ITERATIONS, ADMIN_PIN_MIN } from '../../js/core/auth.js';
import { PERMISSIONS } from '../../js/core/config.js';
import { memoryStorage, smallDb } from './helpers.js';

const ITER = 10_000; // rapide pour les tests

test('hashPin : format, sel aléatoire, empreinte reproductible', async () => {
  const a = await hashPin('2468', { iter: ITER });
  const b = await hashPin('2468', { iter: ITER });
  assert.equal(a.alg, 'PBKDF2-SHA256');
  assert.equal(a.iter, ITER);
  assert.equal(a.len, 4);
  assert.notEqual(a.salt, b.salt, 'sel différent à chaque fois');
  assert.notEqual(a.hash, b.hash);
  const again = await hashPin('2468', { salt: a.salt, iter: ITER });
  assert.equal(again.hash, a.hash, 'même sel + même PIN = même empreinte');
  assert.ok(!JSON.stringify(a).includes('2468'), 'le PIN n\'apparaît nulle part');
  assert.equal(PBKDF2_ITERATIONS, 150_000);
});

test('verifyPin : bon PIN, mauvais PIN, entrées malformées', async () => {
  const rec = await hashPin('13579', { iter: ITER });
  assert.equal(await verifyPin(rec, '13579'), true);
  assert.equal(await verifyPin(rec, '13570'), false);
  assert.equal(await verifyPin(rec, '1357'), false);
  assert.equal(await verifyPin(rec, ''), false);
  assert.equal(await verifyPin(rec, 'abcd'), false);
  assert.equal(await verifyPin(rec, null), false);
  assert.equal(await verifyPin(null, '1357'), false);
  assert.equal(await verifyPin(undefined, '1357'), false);
});

test('pinPolicy', () => {
  const ok = ['2468', '135790', '8051', '97531246'];
  const ko = ['123', '123456789', 'abcd', '', '0000', '7777777', '1234', '4321', '56789', '987654', '12 34'];
  for (const p of ok) assert.equal(pinPolicy(p).ok, true, p);
  for (const p of ko) { const r = pinPolicy(p); assert.equal(r.ok, false, p); assert.ok(r.reason); }
});

test('pinPolicy : 6 chiffres au moins pour un administrateur', () => {
  assert.equal(ADMIN_PIN_MIN, 6);
  for (const p of ['2468', '80517']) {
    assert.equal(pinPolicy(p, { role: 'operator' }).ok, true, p);
    assert.equal(pinPolicy(p, { role: 'manager' }).ok, true, p);
    const r = pinPolicy(p, { role: 'admin' });
    assert.equal(r.ok, false, p);
    assert.match(r.reason, /administrateur/);
  }
  for (const p of ['135790', '9753124', '80517392']) assert.equal(pinPolicy(p, { role: 'admin' }).ok, true, p);
  for (const p of ['123456', '000000', '987654']) assert.equal(pinPolicy(p, { role: 'admin' }).ok, false, `${p} : évident`);
});

test('isStrongPinRecord : nouvelle empreinte au coût courant, longueur déclarée cohérente', async () => {
  const strong = await hashPin('2468');
  assert.equal(isStrongPinRecord(strong), true);
  assert.equal(isStrongPinRecord({ ...strong, iter: PBKDF2_ITERATIONS - 1 }), false, 'moins d\'itérations : refusée');
  assert.equal(isPinRecord({ ...strong, iter: 10_000 }), true, 'une empreinte ancienne reste lisible…');
  assert.equal(isStrongPinRecord({ ...strong, iter: 10_000 }), false, '…mais ne peut plus être imposée');
  for (const len of [undefined, 0, 3, 9, 4.5, '4']) assert.equal(isStrongPinRecord({ ...strong, len }), false, `len=${len}`);
  for (const bad of [null, 'x', { ...strong, alg: 'SHA1' }, { ...strong, hash: '' }, { ...strong, iter: 20_000_000 }]) assert.equal(isStrongPinRecord(bad), false);
});

test('permissions : matrice par rôle', () => {
  const matrix = {
    operator: { move: 1, 'transfer.create': 1, 'transfer.receive': 1, 'article.create': 1, 'article.edit': 0, 'stock.adjust': 0, inventory: 0, import: 0, export: 0, 'audit.view': 0, 'location.edit': 0, 'transfer.cancel': 0, 'user.manage': 0, 'depot.manage': 0, 'data.manage': 0, 'depot.any': 0 },
    manager: { move: 1, 'article.edit': 1, 'stock.adjust': 1, inventory: 1, import: 1, export: 1, 'audit.view': 1, 'location.edit': 1, 'transfer.cancel': 1, 'user.manage': 0, 'depot.manage': 0, 'data.manage': 0, 'depot.any': 0 },
    admin: { move: 1, 'article.edit': 1, inventory: 1, 'user.manage': 1, 'depot.manage': 1, 'data.manage': 1, 'depot.any': 1 },
  };
  for (const [role, perms] of Object.entries(matrix)) for (const [p, v] of Object.entries(perms)) assert.equal(can(role, p), Boolean(v), `${role}/${p}`);
  assert.equal(can('inconnu', 'move'), false);
  assert.equal(can(undefined, 'move'), false);
  assert.equal(can('admin', 'permission.inexistante'), false);
  // hiérarchie : tout ce que peut un opérateur, un responsable le peut ; idem admin ⊇ responsable
  for (const p of PERMISSIONS.operator) assert.ok(PERMISSIONS.manager.has(p));
  for (const p of PERMISSIONS.manager) assert.ok(PERMISSIONS.admin.has(p));
});

test('lockDelay : progressif et plafonné', () => {
  assert.deepEqual([0, 1, 4].map(lockDelay), [0, 0, 0]);
  assert.equal(lockDelay(5), 30_000);
  assert.equal(lockDelay(6), 60_000);
  assert.equal(lockDelay(7), 120_000);
  assert.equal(lockDelay(8), 300_000);
  assert.equal(lockDelay(9), 900_000);
  assert.equal(lockDelay(500), 900_000);
});

test('verrouillage : 5 échecs → blocage, déblocage à l\'échéance, persistance, succès efface', () => {
  const storage = memoryStorage();
  let t = 1_000_000;
  const mk = () => createLockout({ storage, key: 'k', now: () => t });
  const l = mk();
  for (let i = 0; i < 4; i++) assert.equal(l.fail('u1').remainingMs, 0);
  assert.equal(l.status('u1').locked, false);
  assert.equal(l.fail('u1').remainingMs, 30_000);
  assert.equal(l.status('u1').locked, true);
  assert.equal(mk().status('u1').locked, true, 'persisté entre deux instances (rechargement de page)');
  assert.equal(l.status('u2').locked, false, 'par utilisateur');
  t += 29_999;
  assert.equal(l.status('u1').locked, true);
  t += 2;
  assert.equal(l.status('u1').locked, false);
  assert.equal(l.status('u1').failures, 5, 'le compteur reste jusqu\'à une réussite');
  assert.equal(l.fail('u1').remainingMs, 60_000, 'le blocage suivant est plus long');
  l.success('u1');
  assert.deepEqual(l.status('u1'), { locked: false, remainingMs: 0, failures: 0 });
});

test('verrouillage : stockage illisible ou indisponible → pas d\'exception', () => {
  const bad = { getItem: () => '{pas json', setItem: () => { throw new Error('quota'); } };
  const l = createLockout({ storage: bad, key: 'k', now: () => 0 });
  assert.equal(l.status('u').locked, false);
  assert.doesNotThrow(() => l.fail('u'));
});

test('isIdle', () => {
  assert.equal(isIdle(0, 10 * 60_000, 15 * 60_000), false);
  assert.equal(isIdle(0, 15 * 60_000, 15 * 60_000), true);
  assert.equal(isIdle(0, 10 ** 12, 0), false, '0 = jamais');
});

test('upgradeLegacyPins : hache les PIN en clair et les supprime', async () => {
  const db = smallDb();
  db.users.useradmin001.pin = null; db.users.useradmin001.pinLegacy = '1234';
  db.users.useropspar01.pin = null; db.users.useropspar01.pinLegacy = '4567';
  const n = await upgradeLegacyPins(db);
  assert.equal(n, 2);
  assert.equal(db.users.useradmin001.pinLegacy, undefined);
  assert.equal(await verifyPin(db.users.useradmin001.pin, '1234'), true);
  assert.equal(await verifyPin(db.users.useropspar01.pin, '4567'), true);
  assert.equal(await verifyPin(db.users.useropspar01.pin, '1234'), false);
  assert.ok(!JSON.stringify(db).includes('pinLegacy'));
  assert.equal(await upgradeLegacyPins(db), 0, 'idempotent');
});
