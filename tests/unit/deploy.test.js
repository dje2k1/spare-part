// Déploiement (docker-compose.yml, Caddyfile, Dockerfile) : durcissement vérifié dans le texte des fichiers.
// Validé une fois en conditions réelles (Docker + Caddy, HTTPS) ; ces règles empêchent qu'il se perde.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (f) => readFileSync(join(root, f), 'utf8');
/** Bloc d'un service de docker-compose.yml (lignes indentées sous « nom: »). */
function service(name) {
  const m = new RegExp(`\\n  ${name}:\\n((?:    .*\\n|\\s*\\n)+)`).exec(read('docker-compose.yml'));
  assert.ok(m, `service introuvable : ${name}`);
  return m[1];
}

test('compose : le proxy ne reçoit que le nom de domaine (ni clé API, ni code d\'accès, ni PIN initial)', () => {
  const caddy = service('caddy');
  assert.doesNotMatch(caddy, /env_file/);
  const env = /environment:\n((?:      .*\n)+)/.exec(caddy)?.[1] ?? '';
  assert.deepEqual(env.trim().split('\n').map((l) => l.trim().split(':')[0]), ['DOMAIN']);
});

test('compose : application en lecture seule, sans privilège noyau ni élévation', () => {
  const app = service('mode-stock');
  assert.match(app, /read_only: true/);
  assert.match(app, /cap_drop:\n\s+- ALL/);
  assert.match(app, /no-new-privileges:true/);
  assert.match(app, /TRUST_PROXY: "1"/, 'derrière Caddy : adresse réelle et HTTPS reconnus');
  assert.doesNotMatch(app, /ports:/, 'jamais exposée directement : seulement via le proxy HTTPS');
});

test('Caddy : aucune signature du logiciel dans les réponses', () => {
  const caddyfile = read('Caddyfile');
  assert.match(caddyfile, /-Server/);
  assert.match(caddyfile, /-Via/);
});

test('image : utilisateur non privilégié, dépendances de production seules', () => {
  const docker = read('Dockerfile');
  assert.match(docker, /^USER node$/m);
  assert.match(docker, /npm ci --prefix server --omit=dev/);
  assert.doesNotMatch(docker, /COPY \. /, 'jamais tout le dépôt (tests, .git, .env)');
  for (const f of ['.env', '.git', 'server/data']) assert.match(read('.dockerignore'), new RegExp(`^${f.replace('.', '\\.')}`, 'm'), f);
});
