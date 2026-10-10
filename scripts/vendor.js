// Copie les bibliothèques tierces et les polices depuis node_modules vers vendor/ et fonts/,
// puis écrit vendor/CHECKSUMS.json (SHA-256), vérifié par tests/unit/vendor.test.js (avec la copie npm, dont
// l'intégrité est garantie par package-lock.json).
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

export const FILES = [
  // [source, destination, licence]
  [nm('html5-qrcode', 'html5-qrcode.min.js'), 'vendor/html5-qrcode.min.js', 'Apache-2.0'],
  [nm('qrcode-generator', 'qrcode.js'), 'vendor/qrcode.js', 'MIT'],
  // Archivo variable : axes graisse (100–900) ET chasse (62–125 %) — étroite pour les plaques et les chiffres,
  // normale pour le texte. Une seule famille, un seul fichier.
  [nm('@fontsource-variable', 'archivo', 'files', 'archivo-latin-wdth-normal.woff2'), 'fonts/archivo-variable.woff2', 'OFL-1.1'],
];

if (process.argv[1] === fileURLToPath(import.meta.url)) {
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
}
