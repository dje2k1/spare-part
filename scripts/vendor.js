// Copie les bibliothèques tierces et les polices depuis node_modules vers vendor/ et fonts/,
// puis écrit vendor/CHECKSUMS.json (SHA-256) vérifié par les tests unitaires.
//
//   npm install && npm run vendor
//
// Les fichiers copiés sont versionnés dans le dépôt : l'application n'a AUCUNE dépendance
// réseau au runtime (pas de CDN), ce qui supprime le risque de chaîne d'approvisionnement
// côté navigateur et permet l'usage hors-ligne.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nm = (...p) => join(root, 'node_modules', ...p);

const FILES = [
  // [source, destination, licence]
  [nm('html5-qrcode', 'html5-qrcode.min.js'), 'vendor/html5-qrcode.min.js', 'Apache-2.0'],
  [nm('qrcode-generator', 'qrcode.js'), 'vendor/qrcode.js', 'MIT'],
  [nm('@fontsource', 'playfair-display', 'files', 'playfair-display-latin-400-normal.woff2'), 'fonts/playfair-display-400.woff2', 'OFL-1.1'],
  [nm('@fontsource', 'playfair-display', 'files', 'playfair-display-latin-500-normal.woff2'), 'fonts/playfair-display-500.woff2', 'OFL-1.1'],
  [nm('@fontsource', 'playfair-display', 'files', 'playfair-display-latin-400-italic.woff2'), 'fonts/playfair-display-400-italic.woff2', 'OFL-1.1'],
  [nm('@fontsource-variable', 'jost', 'files', 'jost-latin-wght-normal.woff2'), 'fonts/jost-variable.woff2', 'OFL-1.1'],
];

const sums = {};
for (const [src, dest, licence] of FILES) {
  const out = join(root, dest);
  mkdirSync(dirname(out), { recursive: true });
  copyFileSync(src, out);
  const buf = readFileSync(out);
  sums[dest] = { sha256: createHash('sha256').update(buf).digest('hex'), bytes: buf.length, licence };
  console.log(`✓ ${dest} (${buf.length} o, ${licence})`);
}
writeFileSync(join(root, 'vendor/CHECKSUMS.json'), JSON.stringify(sums, null, 2) + '\n');
console.log('✓ vendor/CHECKSUMS.json');
