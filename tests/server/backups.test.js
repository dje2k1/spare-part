// Sauvegardes automatiques quotidiennes : une par jour, rotation, téléchargement réservé à l'administrateur,
// fichiers restaurables tels quels, aucun autre fichier du serveur accessible.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { startApp } from './helpers.js';
import { parseBackup } from '../../js/core/schema.js';

const DAY = 86_400_000;

test('une sauvegarde par jour (dont une au démarrage), les plus anciennes supprimées au-delà de la limite', async () => {
  let clock = new Date(2026, 9, 10, 9, 0).getTime();
  const s = await startApp({ now: () => new Date(clock), backupKeep: 3 });
  try {
    assert.deepEqual(s.app.backups.list().map((b) => b.name), ['mode-stock-2026-10-10.json'], 'sauvegarde au démarrage');
    s.app.backups.check();
    assert.equal(s.app.backups.list().length, 1, 'une seule par jour');
    for (let i = 1; i <= 4; i++) { clock += DAY; s.app.backups.check(); }
    assert.deepEqual(s.app.backups.list().map((b) => b.day), ['2026-10-14', '2026-10-13', '2026-10-12'], 'les 3 derniers jours seulement');
    assert.equal(existsSync(join(s.dir, 'backups', 'mode-stock-2026-10-10.json')), false);
    const { db } = parseBackup(s.app.backups.read('mode-stock-2026-10-14.json').toString('utf8'), new Date(clock), { maxBytes: 50 * 1024 * 1024 });
    assert.equal(Object.keys(db.articles).length, Object.keys(s.app.store.db.articles).length, 'restaurable tel quel');
  } finally { await s.stop(); }
});

test('liste et téléchargement réservés à l\'administrateur ; aucun autre fichier accessible', async () => {
  const s = await startApp();
  try {
    const admin = s.client();
    await admin.login('Administrateur', '1234');
    const list = await admin.get('/api/admin/backups');
    assert.equal(list.status, 200);
    assert.equal(list.json.keep, 14);
    assert.equal(list.json.items.length, 1);
    const name = list.json.items[0].name;
    const file = await admin.get(`/api/admin/backups/file?name=${encodeURIComponent(name)}`);
    assert.equal(file.status, 200);
    assert.match(file.headers.get('content-disposition'), /attachment; filename="mode-stock-\d{4}-\d{2}-\d{2}\.json"/);
    assert.equal(file.json.app, 'mode-stock');
    for (const bad of ['../snapshot.json', 'snapshot.json', '../../package.json', 'mode-stock-2026-10-10.json/../../sessions.json', '']) {
      assert.equal((await admin.get(`/api/admin/backups/file?name=${encodeURIComponent(bad)}`)).status, 404, bad);
    }
    const op = s.client();
    await op.login('Julie Laurent', '4567');
    assert.equal((await op.get('/api/admin/backups')).status, 403);
    assert.equal((await op.get(`/api/admin/backups/file?name=${encodeURIComponent(name)}`)).status, 403);
  } finally { await s.stop(); }
});

test('sauvegardes désactivables (BACKUP_KEEP=0)', async () => {
  const s = await startApp({ backupKeep: 0 });
  try {
    assert.equal(s.app.backups, null);
    assert.equal(existsSync(join(s.dir, 'backups')), false);
    const admin = s.client();
    await admin.login('Administrateur', '1234');
    assert.deepEqual((await admin.get('/api/admin/backups')).json, { keep: 0, items: [] });
  } finally { await s.stop(); }
});
