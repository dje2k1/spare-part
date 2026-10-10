// PWA : la liste de pré-cache du service worker couvre exactement les fichiers de l'application ;
// le manifeste, les icônes, la version et le graphe d'imports sont cohérents (un fichier oublié = hors-ligne cassé).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { precacheList, appVersion, contentHash } from '../../scripts/sw-precache.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (f) => readFileSync(join(root, f), 'utf8');
const sw = read('sw.js');
const listed = JSON.parse(`[${/const PRECACHE = \[([\s\S]*?)\];/.exec(sw)[1].replace(/'/g, '"').replace(/,\s*$/, '')}]`);

test('sw.js : liste de pré-cache à jour (lancer « npm run sw » après tout ajout de fichier)', () => {
  assert.deepEqual(listed, precacheList());
});

test('sw.js : version = APP_VERSION + empreinte du contenu (tout fichier modifié renouvelle le cache)', () => {
  assert.equal(/const VERSION = '([^']+)'/.exec(sw)[1], `${appVersion()}-${contentHash()}`, 'lancer « npm run sw » après toute modification d\'un fichier servi');
  assert.match(sw, /const CACHE = `mode-stock-\$\{VERSION\}`/);
  assert.match(contentHash(), /^[0-9a-f]{8}$/);
  assert.notEqual(contentHash(precacheList().slice(0, -1)), contentHash(), 'l\'empreinte dépend de chaque fichier');
});

test('tous les fichiers listés existent', () => {
  for (const f of listed) if (f !== './') assert.ok(existsSync(join(root, f)), `${f} introuvable`);
});

test('graphe d\'imports : chaque module importé existe et est pré-caché', () => {
  const files = new Set(listed);
  const seen = new Set();
  const visit = (f) => {
    if (seen.has(f)) return;
    seen.add(f);
    assert.ok(files.has(f), `${f} n'est pas pré-caché`);
    for (const m of read(f).matchAll(/(?:import|export)[^'"`;]*?from\s*['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
      const target = relative(root, resolve(join(root, dirname(f)), m[1] ?? m[2])).split('\\').join('/');
      assert.ok(existsSync(join(root, target)), `${f} importe ${m[1] ?? m[2]} : fichier absent`);
      visit(target);
    }
  };
  visit('js/main.js');
  assert.ok(seen.size > 30);
});

test('index.html : chaque ressource locale référencée est pré-cachée', () => {
  const html = read('index.html');
  const refs = [...html.matchAll(/(?:src|href)="(?!https?:|#|data:)([^"]+)"/g)].map((m) => m[1].replace(/^\.\//, ''));
  assert.ok(refs.length >= 5);
  for (const r of refs) assert.ok(listed.includes(r), `${r} absent du pré-cache`);
});

test('manifeste : icônes existantes, maskable présente, portée relative (sous-chemin GitHub Pages)', () => {
  const m = JSON.parse(read('manifest.webmanifest'));
  assert.equal(m.start_url, './');
  assert.equal(m.scope, './');
  assert.equal(m.display, 'standalone');
  assert.ok(m.icons.some((i) => i.sizes === '512x512' && i.purpose === 'any'));
  assert.ok(m.icons.some((i) => i.purpose === 'maskable'));
  for (const i of m.icons) assert.ok(listed.includes(i.src), `${i.src} absent du pré-cache`);
  for (const s of m.shortcuts ?? []) assert.match(s.url, /^\.\/#\//);
});

test('aucune dépendance de CDN dans les fichiers servis', () => {
  const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
  const offenders = [];
  for (const f of ['index.html', 'sw.js', 'manifest.webmanifest', ...walk(join(root, 'css')).map((p) => relative(root, p)), ...walk(join(root, 'js')).map((p) => relative(root, p))]) {
    for (const m of read(f).matchAll(/https?:\/\/[\w-][^\s'"`)]*/g)) {
      if (!/^https:\/\/api\.anthropic\.com|^https?:\/\/www\.w3\.org\/|^https:\/\/console\.anthropic\.com|^https:\/\/(?:github\.com|dje2k1)/.test(m[0])) offenders.push(`${f} : ${m[0]}`);
    }
  }
  assert.deepEqual(offenders, []);
});
