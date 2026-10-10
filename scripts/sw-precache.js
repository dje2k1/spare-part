// Régénère la liste PRECACHE de sw.js (et synchronise VERSION avec js/core/config.js).
//   npm run sw
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = join(root, 'sw.js');
  let src = readFileSync(file, 'utf8');
  const list = precacheList().map((f) => `  '${f}',`).join('\n');
  src = src.replace(/\/\/ <PRECACHE>[\s\S]*?\/\/ <\/PRECACHE>/, `// <PRECACHE>\nconst PRECACHE = [\n${list}\n];\n// </PRECACHE>`);
  src = src.replace(/const VERSION = '[^']*';/, `const VERSION = '${appVersion()}';`);
  writeFileSync(file, src);
  console.log(`✓ sw.js : ${precacheList().length} fichiers, version ${appVersion()}`);
}
