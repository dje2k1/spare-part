// Régénère la liste PRECACHE de sw.js et sa VERSION (APP_VERSION + empreinte du contenu).
//   npm run sw
// L'empreinte change dès qu'un seul fichier servi change : le cache des appareils est alors TOUJOURS
// renouvelé (nouveau nom de cache), même si personne n'a pensé à incrémenter APP_VERSION. Sans elle,
// une livraison à version inchangée réécrirait le cache en place et l'ancienne version pourrait servir
// un mélange de fichiers anciens et nouveaux.
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIRS = ['css', 'js', 'vendor', 'fonts', 'icons'];
const SKIP = /(^|\/)(package\.json|CHECKSUMS\.json|README\.md)$/;

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [relative(root, p).split('\\').join('/')];
  });
}

/** Liste des fichiers à mettre en cache (chemins relatifs, tri stable). */
export function precacheList() {
  const files = DIRS.flatMap((d) => walk(join(root, d))).filter((f) => !SKIP.test(f)).sort();
  return ['./', 'index.html', 'manifest.webmanifest', ...files];
}

export function appVersion() {
  return /APP_VERSION = '([^']+)'/.exec(readFileSync(join(root, 'js/core/config.js'), 'utf8'))[1];
}

/** Empreinte (8 caractères) du contenu de tous les fichiers pré-cachés, chemins compris. */
export function contentHash(list = precacheList()) {
  const h = createHash('sha256');
  for (const f of list) {
    if (f === './') continue; // même contenu que index.html
    h.update(`${f}\u0000`);
    h.update(readFileSync(join(root, f)));
    h.update('\u0000');
  }
  return h.digest('hex').slice(0, 8);
}

export const cacheVersion = () => `${appVersion()}-${contentHash()}`;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = join(root, 'sw.js');
  let src = readFileSync(file, 'utf8');
  const list = precacheList();
  src = src.replace(/\/\/ <PRECACHE>[\s\S]*?\/\/ <\/PRECACHE>/, `// <PRECACHE>\nconst PRECACHE = [\n${list.map((f) => `  '${f}',`).join('\n')}\n];\n// </PRECACHE>`);
  src = src.replace(/const VERSION = '[^']*';/, `const VERSION = '${cacheVersion()}';`);
  writeFileSync(file, src);
  console.log(`✓ sw.js : ${list.length} fichiers, version ${cacheVersion()}`);
}
