// API du serveur : connexion, sessions, CSRF, opérations, temps réel, sauvegarde, fichiers servis, en-têtes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, client, openStream, ORG, opId, byName, demoDb } from './helpers.js';
import { makeBackup } from '../../js/core/schema.js';
import { hashPin } from '../../js/core/auth.js';

let srv;
before(async () => { srv = await startApp(); });
after(async () => { await srv?.stop(); });

const stockedEan = (db, depotId) => Object.entries(db.stocks[depotId]).find(([, q]) => q >= 5)[0];

test('configuration publique : mode serveur annoncé, rien de sensible', async () => {
  const r = await client(srv.base).get('/api/config');
  assert.equal(r.status, 200);
  assert.equal(r.json.server, true);
  assert.equal(r.json.ai, false);
  assert.deepEqual(Object.keys(r.json).sort(), ['ai', 'aiDailyLimit', 'demo', 'server', 'version']);
});

test('annuaire : code d\'accès exigé, aucune empreinte de PIN exposée', async () => {
  const c = client(srv.base);
  assert.equal((await c.post('/api/directory', { orgCode: 'FAUX' })).status, 403);
  const ok = await c.post('/api/directory', { orgCode: ORG.toLowerCase() }); // insensible à la casse
  assert.equal(ok.status, 200);
  assert.ok(ok.json.users.length >= 5);
  assert.ok(ok.json.users.every((u) => !('pin' in u) && u.pinLen === 4));
  assert.doesNotMatch(ok.text, /PBKDF2|"hash"/);
});

test('connexion : PIN faux refusé, puis compte verrouillé ; code d\'accès exigé aussi à la connexion', async () => {
  const c = client(srv.base);
  const dir = (await c.post('/api/directory', { orgCode: ORG })).json;
  const marc = dir.users.find((u) => u.name === 'Marc Dubois');
  assert.equal((await c.post('/api/login', { orgCode: 'FAUX', userId: marc.id, pin: '3456' })).status, 403);
  for (let i = 0; i < 4; i++) assert.equal((await c.post('/api/login', { orgCode: ORG, userId: marc.id, pin: '0000' })).status, 401);
  const fifth = await c.post('/api/login', { orgCode: ORG, userId: marc.id, pin: '0000' });
  assert.equal(fifth.status, 401);
  assert.ok(fifth.json.retryMs > 0);
  const locked = await c.post('/api/login', { orgCode: ORG, userId: marc.id, pin: '3456' });
  assert.equal(locked.status, 423, 'même le bon PIN est refusé pendant le verrouillage');
  assert.equal(c.cookie, '');
  srv.app.auth.close(); // (le verrou est en mémoire : les autres tests utilisent d'autres comptes)
});

test('session : cookie HttpOnly SameSite=Strict, empreinte seule côté serveur, déconnexion', async () => {
  const c = client(srv.base);
  const dir = (await c.post('/api/directory', { orgCode: ORG })).json;
  const julie = dir.users.find((u) => u.name === 'Julie Laurent');
  const r = await c.post('/api/login', { orgCode: ORG, userId: julie.id, pin: '4567' });
  assert.equal(r.status, 200);
  const set = r.headers.get('set-cookie');
  assert.match(set, /HttpOnly/);
  assert.match(set, /SameSite=Strict/);
  assert.doesNotMatch(set, /Secure/, 'HTTP local : pas de Secure (sinon le cookie serait ignoré)');
  assert.equal(r.json.pin, undefined, 'aucune empreinte renvoyée : l\'appareil fabrique son propre vérificateur hors ligne');
  assert.doesNotMatch(r.text, /PBKDF2|"hash"|"salt"/);
  const token = c.cookie.split('=')[1];
  const { readFileSync } = await import('node:fs');
  srv.app.auth.close();
  assert.doesNotMatch(readFileSync(`${srv.dir}/sessions.json`, 'utf8'), new RegExp(token), 'le jeton n\'est jamais stocké en clair');
  assert.equal((await c.get('/api/session')).json.user.name, 'Julie Laurent');
  assert.equal((await c.post('/api/logout')).status, 200);
  assert.equal((await c.get('/api/session')).status, 401);
  const audit = srv.app.store.db.audit.slice(0, 5).map((a) => a.action);
  assert.ok(audit.includes('Déconnexion de Julie Laurent'));
  assert.ok(audit.includes('Connexion de Julie Laurent'));
});

test('jeton forgé ou absent : 401 partout', async () => {
  const c = client(srv.base);
  c.cookie = 'mode_session=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
  for (const p of ['/api/session', '/api/snapshot', '/api/events?since=0', '/api/state', '/api/stream']) assert.equal((await c.get(p)).status, 401, p);
  assert.equal((await c.post('/api/ops', { userId: 'x', ops: [] })).status, 401);
});

test('cookie mal encodé (autre application du domaine) : ignoré, jamais d\'erreur 500', async () => {
  const c = client(srv.base);
  await c.login('Sophie Martin', '2345');
  const good = c.cookie;
  c.cookie = `suivi=%E0%A4%A; ${good}; autre=%`;
  assert.equal((await c.get('/api/session')).status, 200, 'la session reste reconnue');
  c.cookie = 'mode_session=%E0%A4%A';
  assert.equal((await c.get('/api/session')).status, 401, 'jeton illisible = pas de session (et non une erreur interne)');
});

test('CSRF : origine étrangère et type de contenu non JSON refusés', async () => {
  const c = client(srv.base);
  await c.login('Sophie Martin', '2345');
  const evil = client(srv.base, { origin: 'https://evil.example' });
  evil.cookie = c.cookie;
  assert.equal((await evil.post('/api/ops', { userId: 'x', ops: [] })).status, 403);
  assert.equal((await c.post('/api/logout', 'x=1', { 'content-type': 'application/x-www-form-urlencoded' })).status, 415);
  assert.equal((await c.post('/api/ops', {}, { 'sec-fetch-site': 'cross-site' })).status, 403);
  const same = client(srv.base, { origin: srv.base });
  same.cookie = c.cookie;
  assert.equal((await same.post('/api/ops', { userId: (await c.get('/api/session')).json.user.id, ops: [] })).status, 200);
});

test('opérations : acceptée, doublon, refusée ; rattrapage renvoyé ; compte imposé', async () => {
  const c = client(srv.base);
  const me = await c.login('Sophie Martin', '2345');
  const snap = (await c.get('/api/snapshot')).json;
  const ean = stockedEan(snap.db, me.depotId);
  const was = snap.db.stocks[me.depotId][ean];
  const id1 = opId(1);
  const r = await c.post('/api/ops', { userId: me.user.id, since: snap.v, ops: [
    { opId: id1, name: 'moveStock', params: { type: 'out', ean, qty: 2 }, depotId: me.depotId, at: new Date().toISOString() },
    { opId: id1, name: 'moveStock', params: { type: 'out', ean, qty: 2 }, depotId: me.depotId, at: new Date().toISOString() },
    { opId: opId(2), name: 'moveStock', params: { type: 'out', ean, qty: 1e6 }, depotId: me.depotId, at: new Date().toISOString() },
  ] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.results.map((x) => x.status), ['ok', 'duplicate', 'rejected']);
  assert.match(r.json.results[2].message, /Stock insuffisant/);
  assert.ok(r.json.events.some((e) => e.opId === id1));
  assert.equal(srv.app.store.db.stocks[me.depotId][ean], was - 2);
  // opérations d'un autre compte restées dans la file de l'appareil : refusées en bloc
  const other = await c.post('/api/ops', { userId: byName(srv.app.store.db, 'Julie Laurent').id, ops: [] });
  assert.equal(other.status, 409);
  assert.equal(other.json.code, 'session_mismatch');
  assert.equal((await c.post('/api/ops', { userId: me.user.id, ops: Array.from({ length: 201 }, () => ({})) })).status, 400);
});

test('instantané : compressé, sans PIN, journaux limités, empreinte cohérente', async () => {
  const c = client(srv.base);
  await c.login('Sophie Martin', '2345');
  const res = await fetch(`${srv.base}/api/snapshot`, { headers: { cookie: c.cookie, 'accept-encoding': 'gzip' } });
  assert.equal(res.headers.get('content-encoding'), 'gzip');
  const snap = await res.json();
  assert.ok(Object.values(snap.db.users).every((u) => u.pin === null));
  assert.equal(snap.hash, (await c.get('/api/state')).json.hash);
});

test('temps réel : l\'opération d\'un appareil arrive aux autres ; rattrapage par Last-Event-ID', async () => {
  const a = client(srv.base);
  const b = client(srv.base);
  const ma = await a.login('Sophie Martin', '2345');
  await b.login('Karim Benali', '2468');
  const v0 = srv.app.store.version;
  const stream = await openStream(srv.base, b.cookie, { since: v0 });
  assert.equal(stream.status, 200);
  const ean = stockedEan(srv.app.store.db, ma.depotId);
  const id = opId(7);
  await a.post('/api/ops', { userId: ma.user.id, ops: [{ opId: id, name: 'moveStock', params: { type: 'in', ean, qty: 3 }, depotId: ma.depotId, at: new Date().toISOString() }] });
  const ev = await stream.next((e) => e.event === 'op' && e.json.opId === id);
  assert.equal(ev.json.by, 'Sophie Martin');
  assert.equal(Number(ev.id), ev.json.v);
  stream.close();
  // reconnexion : le navigateur renvoie le dernier identifiant reçu
  const s2 = await openStream(srv.base, b.cookie, { lastEventId: v0 });
  assert.equal((await s2.next((e) => e.json.opId === id)).json.v, ev.json.v);
  s2.close();
  // identifiant trop ancien ou incohérent → ordre de recharger un instantané
  const s3 = await openStream(srv.base, b.cookie, { lastEventId: 999_999 });
  assert.equal((await s3.next()).event, 'reset');
  s3.close();
});

test('compte supprimé ou PIN changé par un administrateur : ses sessions sont révoquées', async () => {
  const admin = client(srv.base);
  const me = await admin.login('Administrateur', '1234');
  const pierre = client(srv.base);
  await pierre.login('Pierre Blanc', '5678');
  assert.equal((await pierre.get('/api/session')).status, 200);
  const p = byName(srv.app.store.db, 'Pierre Blanc');
  const pin = await hashPin('97531');
  const r = await admin.post('/api/ops', { userId: me.user.id, ops: [{ opId: opId(3), name: 'saveUser', params: { id: p.id, name: p.name, role: p.role, depotId: p.depotId, pin }, depotId: me.depotId, at: new Date().toISOString() }] });
  assert.equal(r.json.results[0].status, 'ok');
  assert.equal((await pierre.get('/api/session')).status, 401);
  assert.equal((await admin.get('/api/session')).status, 200, 'la session de l\'administrateur reste ouverte');
});

test('sauvegarde et restauration : réservées à l\'administrateur, remise à zéro diffusée', async () => {
  const op = client(srv.base);
  await op.login('Léa Moreau', '1357');
  assert.equal((await op.get('/api/admin/backup')).status, 403);
  assert.equal((await op.post('/api/admin/restore', {})).status, 403);
  const admin = client(srv.base);
  await admin.login('Administrateur', '1234');
  const backup = await admin.get('/api/admin/backup');
  assert.equal(backup.status, 200);
  assert.match(backup.headers.get('content-disposition'), /attachment; filename="mode-stock-serveur-/);
  assert.equal(backup.json.app, 'mode-stock');
  assert.ok(Object.values(backup.json.data.users).some((u) => u.pin?.hash), 'sauvegarde complète (empreintes comprises)');
  const stream = await openStream(srv.base, admin.cookie, { since: srv.app.store.version });
  assert.equal((await admin.post('/api/admin/restore', { app: 'autre' })).status, 400);
  const restored = await admin.post('/api/admin/restore', backup.text);
  assert.equal(restored.status, 200);
  assert.equal(restored.json.keptSession, true);
  assert.equal((await stream.next((e) => e.event === 'reset')).json.v, restored.json.v);
  stream.close();
  assert.equal((await op.get('/api/session')).status, 401, 'les autres sessions sont fermées après restauration');
  assert.equal((await admin.get('/api/session')).status, 200);
});

test('fichiers servis : application seulement, aucune fuite du serveur ou des données', async () => {
  const get = (p) => fetch(srv.base + p).then((r) => ({ status: r.status, type: r.headers.get('content-type'), headers: r.headers }));
  const home = await get('/');
  assert.equal(home.status, 200);
  assert.match(home.type, /text\/html/);
  assert.match(home.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await get('/js/main.js')).status, 200);
  assert.match((await get('/js/main.js')).type, /text\/javascript/);
  assert.equal((await get('/sw.js')).status, 200);
  for (const p of ['/server/app.js', '/server/data/snapshot.json', '/package.json', '/tests/serve.js', '/.git/config', '/js/../server/auth.js',
    '/js/%2e%2e/server/auth.js', '/js/..%2fserver/auth.js', '/node_modules/.package-lock.json', '/css/.hidden', '/js/%00.js', '/README.md']) {
    assert.equal((await get(p)).status, 404, p);
  }
  assert.equal((await fetch(`${srv.base}/index.html`, { method: 'POST' })).status, 405);
  const etag = (await get('/index.html')).headers.get('etag');
  assert.equal((await fetch(`${srv.base}/index.html`, { headers: { 'if-none-match': etag } })).status, 304);
});

test('fichiers servis compressés (Brotli, sinon gzip) : contenu identique, en-tête Vary', async () => {
  const http = await import('node:http');
  const zlib = await import('node:zlib');
  const { readFileSync } = await import('node:fs');
  const raw = (path, encoding) => new Promise((resolve, reject) => {
    http.get(srv.base + path, { headers: encoding ? { 'accept-encoding': encoding } : {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
  const original = readFileSync(new URL('../../js/core/ops.js', import.meta.url));
  const br = await raw('/js/core/ops.js', 'gzip, deflate, br');
  assert.equal(br.headers['content-encoding'], 'br');
  assert.equal(br.headers.vary, 'Accept-Encoding');
  assert.ok(br.body.length < original.length / 2, `compression efficace (${br.body.length} / ${original.length} octets)`);
  assert.deepEqual(zlib.brotliDecompressSync(br.body), original);
  const gz = await raw('/js/core/ops.js', 'gzip');
  assert.equal(gz.headers['content-encoding'], 'gzip');
  assert.deepEqual(zlib.gunzipSync(gz.body), original);
  const plain = await raw('/js/core/ops.js');
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.deepEqual(plain.body, original);
  // La page reste réécrite (mode serveur annoncé), compressée ou non
  const page = await raw('/', 'br');
  assert.match(zlib.brotliDecompressSync(page.body).toString('utf8'), /<meta name="mode-sync" content="server">/);
  const font = await raw('/fonts/archivo-variable.woff2', 'br');
  assert.equal(font.headers['content-encoding'], undefined, 'police déjà compressée : servie telle quelle');
});

test('sessions expirées purgées (appareils perdus) ; sessions actives conservées', async () => {
  let clock = Date.now();
  const s = await startApp({ now: () => new Date(clock), sessionHours: 1 });
  try {
    const old = s.client();
    await old.login('Julie Laurent', '4567');
    clock += 45 * 60_000;
    const fresh = s.client();
    await fresh.login('Sophie Martin', '2345');
    clock += 30 * 60_000; // la première a dépassé 1 h sans activité, la seconde non
    assert.equal(s.app.auth.purge(), 1);
    assert.equal((await old.get('/api/session')).status, 401);
    assert.equal((await fresh.get('/api/session')).status, 200);
  } finally { await s.stop(); }
});

test('API inconnue et corps trop volumineux', async () => {
  const c = client(srv.base);
  assert.equal((await c.get('/api/nope')).status, 404);
  const big = await c.post('/api/directory', JSON.stringify({ orgCode: 'x'.repeat(70_000) }));
  assert.equal(big.status, 413);
  assert.equal((await c.post('/api/directory', '{bad')).status, 400);
});

test('redémarrage du serveur : données et sessions conservées', async () => {
  const s = await startApp();
  const c = s.client();
  const me = await c.login('Sophie Martin', '2345');
  const ean = stockedEan(s.app.store.db, me.depotId);
  await c.post('/api/ops', { userId: me.user.id, ops: [{ opId: opId(5), name: 'moveStock', params: { type: 'in', ean, qty: 11 }, depotId: me.depotId, at: new Date().toISOString() }] });
  const hash = s.app.store.hash();
  await s.stop({ keep: true });
  const again = await startApp({ dir: s.dir, db: await demoDb() });
  assert.equal(again.app.store.hash(), hash);
  const c2 = again.client();
  c2.cookie = c.cookie;
  assert.equal((await c2.get('/api/session')).json.user.name, 'Sophie Martin');
  await again.stop();
});

test('limitation par adresse : les connexions réussies ne comptent pas, les échecs répétés bloquent', async () => {
  const s = await startApp();
  const c = s.client();
  for (let i = 0; i < 35; i++) await c.login('Julie Laurent', '4567'); // tout un atelier derrière la même box
  const dir = (await c.post('/api/directory', { orgCode: ORG })).json;
  const ids = dir.users.map((u) => u.id);
  let status = 0;
  for (let i = 0; i < 30; i++) status = (await c.post('/api/login', { orgCode: ORG, userId: ids[i % ids.length], pin: '0000' })).status;
  assert.notEqual(status, 429);
  assert.equal((await c.post('/api/login', { orgCode: ORG, userId: ids[0], pin: '1234' })).status, 429, 'adresse freinée après 30 échecs');
  assert.equal((await c.post('/api/directory', { orgCode: ORG })).status, 429);
  await s.stop();
});
