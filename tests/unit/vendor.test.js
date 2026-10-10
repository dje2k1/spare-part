// Bibliothèques et police embarquées (servies à chaque appareil) : identiques aux paquets npm figés par package-lock.json
// (intégrité vérifiée par npm à l'installation) et à leurs empreintes publiées. Un fichier minifié modifié en douce — que
// personne ne relit — fait échouer les tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FILES } from '../../scripts/vendor.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const sums = JSON.parse(readFileSync(join(root, 'vendor/CHECKSUMS.json'), 'utf8'));
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

test('fichiers embarqués : empreinte SHA-256 et taille conformes à vendor/CHECKSUMS.json', () => {
  assert.deepEqual(Object.keys(sums).sort(), FILES.map(([, dest]) => dest).sort(), 'chaque fichier copié a son empreinte');
  for (const [dest, { sha256: expected, bytes }] of Object.entries(sums)) {
    const buf = readFileSync(join(root, dest));
    assert.equal(buf.length, bytes, dest);
    assert.equal(sha256(buf), expected, `${dest} : contenu modifié (relancer « npm run vendor » après une mise à jour volontaire)`);
  }
});

test('fichiers embarqués : identiques aux paquets npm installés (package-lock.json)', (t) => {
  const present = FILES.filter(([src]) => existsSync(src));
  if (!present.length) return t.skip('node_modules absent (npm ci)');
  for (const [src, dest] of present) assert.equal(sha256(readFileSync(join(root, dest))), sha256(readFileSync(src)), dest);
});
