// Audit de sécurité (passe 5) : chaque faille corrigée a son test — adresse derrière le proxy, opérations réservées
// au serveur, changement de PIN, empreintes, journal d'audit, limites de ressources, configuration au démarrage.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { startApp, client, openStream, ORG, ROOT, opId, byName, demoDb, tempDir, silent } from './helpers.js';
import { createApp, SERVER_ONLY_OPS } from '../../server/app.js';
import { MAX_PIN_CHECKS, MAX_SESSIONS_PER_USER } from '../../server/auth.js';
import { createSyncStore } from '../../server/sync-store.js';
import { hashPin, PBKDF2_ITERATIONS } from '../../js/core/auth.js';

let srv;
before(async () => { srv = await startApp(); });
after(async () => { await srv?.stop(); });

const at = () => new Date().toISOString();
const noSecret = /PBKDF2|"hash"|"salt"/;

test('derrière le proxy : seule l\'adresse posée par le proxy compte (la plus à droite), pas celle annoncée par le client', async () => {
  const s = await startApp({ trustProxy: true });
  try {
    const c = s.client();
    const ids = (await c.post('/api/directory', { orgCode: ORG })).json.users.map((u) => u.id);
    // L'attaquant change la valeur de gauche à chaque essai ; le proxy ajoute toujours, à droite, l'adresse réelle
    const from = (i, real) => ({ 'x-forwarded-for': `10.${i % 250}.0.${i % 7}, ${real}` });
    for (let i = 0; i < 30; i++) await c.post('/api/login', { orgCode: ORG, userId: ids[i % ids.length], pin: '0000' }, from(i, '203.0.113.7'));
    assert.equal((await c.post('/api/login', { orgCode: ORG, userId: ids[0], pin: '1234' }, from(99, '203.0.113.7'))).status, 429, 'freiné malgré une valeur de gauche différente à chaque essai');
    assert.equal((await c.post('/api/directory', { orgCode: ORG }, { 'x-forwarded-for': '203.0.113.7' })).status, 429);
    assert.equal((await c.post('/api/directory', { orgCode: ORG }, from(1, '198.51.100.4'))).status, 200, 'un autre poste n\'est pas pénalisé');
    // Protocole : la valeur du proxy (à droite) décide du cookie Secure et de HSTS
    const https = await fetch(`${s.base}/api/config`, { headers: { 'x-forwarded-proto': 'https' } });
    assert.match(https.headers.get('strict-transport-security') ?? '', /max-age=/);
    const spoofed = await fetch(`${s.base}/api/config`, { headers: { 'x-forwarded-proto': 'https, http' } });
    assert.equal(spoofed.headers.get('strict-transport-security'), null);
  } finally { await s.stop(); }
});

test('opérations réservées au serveur : trace de connexion et changement de PIN refusés depuis un appareil', async () => {
  assert.deepEqual([...SERVER_ONLY_OPS].sort(), ['changeOwnPin', 'recordAuth']);
  const c = client(srv.base);
  const me = await c.login('Julie Laurent', '4567');
  const v = srv.app.store.version;
  const pin = structuredClone(byName(srv.app.store.db, 'Julie Laurent').pin);
  const audit = srv.app.store.db.audit.length;
  const r = await c.post('/api/ops', { userId: me.user.id, ops: [
    { opId: opId(1), name: 'recordAuth', params: { kind: 'lockout', failures: 999 }, depotId: me.depotId, at: at() },
    { opId: opId(2), name: 'changeOwnPin', params: { pin: await hashPin('97531') }, depotId: me.depotId, at: at() },
  ] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.results.map((x) => [x.status, x.code]), [['rejected', 'forbidden'], ['rejected', 'forbidden']]);
  assert.equal(srv.app.store.version, v, 'rien d\'exécuté');
  assert.equal(srv.app.store.db.audit.length, audit, 'journal d\'audit intact (ni fausse trace, ni inondation)');
  assert.deepEqual(byName(srv.app.store.db, 'Julie Laurent').pin, pin, 'PIN inchangé');
});

test('connexion : aucune empreinte de PIN dans la réponse', async () => {
  const r = await client(srv.base).post('/api/login', { orgCode: ORG, userId: byName(srv.app.store.db, 'Karim Benali').id, pin: '2468' });
  assert.equal(r.status, 200);
  assert.equal(r.json.pin, undefined);
  assert.doesNotMatch(r.text, noSecret);
});

test('changer son PIN : PIN actuel vérifié par le serveur, politique appliquée, empreinte calculée par le serveur, autres sessions fermées', async () => {
  const s = await startApp();
  try {
    const phone = s.client();
    const tablet = s.client();
    const me = await phone.login('Julie Laurent', '4567');
    await tablet.login('Julie Laurent', '4567');
    assert.equal((await s.client().post('/api/pin', { current: '4567', next: '80517' })).status, 401, 'session obligatoire');
    assert.equal((await phone.post('/api/pin', 'current=4567&next=80517', { 'content-type': 'application/x-www-form-urlencoded' })).status, 415, 'formulaire d\'un autre site : refusé');
    for (const next of ['1111', '1234', '123', 'abcd', undefined]) {
      const weak = await phone.post('/api/pin', { current: '4567', next });
      assert.equal(weak.status, 400, String(next));
      assert.ok(weak.json.error);
    }
    const wrong = await phone.post('/api/pin', { current: '0000', next: '80517' });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.json.code, 'pin');
    assert.match(wrong.json.error, /PIN actuel incorrect/);
    const before = structuredClone(s.app.store.db.users[me.user.id].pin);
    const ok = await phone.post('/api/pin', { current: '4567', next: '80517' });
    assert.equal(ok.status, 200);
    assert.doesNotMatch(ok.text, noSecret);
    const rec = s.app.store.db.users[me.user.id].pin;
    assert.notEqual(rec.hash, before.hash);
    assert.equal(rec.iter, PBKDF2_ITERATIONS);
    assert.equal(rec.len, 5);
    assert.equal(s.app.store.db.audit[0].action, 'PIN modifié : Julie Laurent');
    assert.equal((await phone.get('/api/session')).status, 200, 'la session qui a changé le PIN reste ouverte');
    assert.equal((await tablet.get('/api/session')).status, 401, 'les autres appareils du compte doivent se reconnecter');
    await assert.rejects(s.client().login('Julie Laurent', '4567'), /401/, 'l\'ancien PIN ne fonctionne plus');
    await s.client().login('Julie Laurent', '80517');
    // Administrateur : 6 chiffres au moins
    const admin = s.client();
    await admin.login('Administrateur', '1234');
    const short = await admin.post('/api/pin', { current: '1234', next: '8051' });
    assert.equal(short.status, 400);
    assert.match(short.json.error, /administrateur/i);
    assert.equal((await admin.post('/api/pin', { current: '1234', next: '805173' })).status, 200);
  } finally { await s.stop(); }
});

test('changer son PIN : essais du PIN actuel limités (verrouillage du compte, journalisé)', async () => {
  const s = await startApp();
  try {
    const c = s.client();
    await c.login('Pierre Blanc', '5678');
    for (let i = 0; i < 4; i++) assert.equal((await c.post('/api/pin', { current: '0000', next: '80517' })).status, 401);
    const fifth = await c.post('/api/pin', { current: '0000', next: '80517' });
    assert.equal(fifth.status, 401);
    assert.ok(fifth.json.retryMs > 0);
    assert.equal((await c.post('/api/pin', { current: '5678', next: '80517' })).status, 423, 'même le bon PIN est refusé pendant le verrouillage');
    assert.equal(byName(s.app.store.db, 'Pierre Blanc').pin.len, 4, 'PIN inchangé');
    assert.equal(s.app.store.db.audit[0].action, 'Compte verrouillé après 5 PIN erronés : Pierre Blanc');
  } finally { await s.stop(); }
});

test('verrouillage d\'un compte à la connexion : journal d\'audit (sans inondation) et journal du serveur avec l\'adresse', async () => {
  let clock = Date.now();
  const warns = [];
  const s = await startApp({ now: () => new Date(clock), log: { ...silent, warn: (m) => warns.push(String(m)) } });
  try {
    const c = s.client();
    const marc = byName(s.app.store.db, 'Marc Dubois');
    const fail = () => c.post('/api/login', { orgCode: ORG, userId: marc.id, pin: '0000' });
    for (let i = 0; i < 5; i++) await fail();
    const locks = () => s.app.store.db.audit.filter((a) => a.action.startsWith('Compte verrouillé'));
    assert.equal(locks().length, 1);
    assert.equal(locks()[0].action, 'Compte verrouillé après 5 PIN erronés : Marc Dubois');
    assert.equal(locks()[0].operatorId, marc.id);
    assert.ok(warns.some((w) => /Marc Dubois verrouillé après 5 PIN erronés.*127\.0\.0\.1/.test(w)), warns.join('\n'));
    clock += 31_000; // fin du premier blocage : un essai de plus ne crée pas de nouvelle entrée
    assert.equal((await fail()).status, 401);
    assert.equal(locks().length, 1);
  } finally { await s.stop(); }
});

test('journal d\'audit réservé aux rôles autorisés : ni instantané, ni rattrapage, ni temps réel pour un opérateur', async () => {
  const op = client(srv.base);
  const lea = await op.login('Léa Moreau', '1357');
  const mgr = client(srv.base);
  await mgr.login('Karim Benali', '2468');
  const snapOp = (await op.get('/api/snapshot')).json;
  const snapMgr = (await mgr.get('/api/snapshot')).json;
  assert.deepEqual(snapOp.db.audit, []);
  assert.ok(snapMgr.db.audit.length > 0);
  assert.equal(snapOp.hash, snapMgr.hash, 'même état métier (l\'empreinte ne couvre pas les journaux)');
  assert.equal((await op.get('/api/snapshot')).json.db.audit.length, 0, 'instantané en cache : toujours filtré');
  const v0 = srv.app.store.version;
  const streamOp = await openStream(srv.base, op.cookie, { since: v0 });
  const streamMgr = await openStream(srv.base, mgr.cookie, { since: v0 });
  await client(srv.base).login('Sophie Martin', '2345'); // connexion : entrée d'audit
  const isLogin = (e) => e.event === 'op' && e.json.name === 'recordAuth';
  const [evOp, evMgr] = await Promise.all([streamOp.next(isLogin), streamMgr.next(isLogin)]);
  streamOp.close();
  streamMgr.close();
  assert.equal(evOp.json.patch.log?.audit, undefined);
  assert.equal(evMgr.json.patch.log.audit.pre[0].action, 'Connexion de Sophie Martin');
  const evts = (await op.get(`/api/events?since=${v0}`)).json.events;
  assert.ok(evts.length > 0 && evts.every((e) => !e.patch.log?.audit));
  assert.ok((await mgr.get(`/api/events?since=${v0}`)).json.events.some((e) => e.patch.log?.audit));
  const r = await op.post('/api/ops', { userId: lea.user.id, since: v0, ops: [] });
  assert.ok(r.json.events.length > 0 && r.json.events.every((e) => !e.patch.log?.audit), 'rattrapage joint à /api/ops : filtré aussi');
});

test('journal d\'audit : l\'excédent part en archive sur le serveur, rien n\'est effacé', async () => {
  const dir = tempDir();
  const db = await demoDb();
  const n0 = db.audit.length;
  const store = createSyncStore({ dataDir: dir, log: silent, auditMax: 5 });
  store.bootstrap(db);
  const admin = byName(store.db, 'Administrateur');
  const oldest = store.db.audit.at(-1).id;
  for (let i = 0; i < 3; i++) store.serverOp('recordAuth', { kind: 'login' }, admin, admin.depotId);
  assert.equal(store.db.audit.length, 5);
  assert.equal(store.db.audit[0].action, 'Connexion de Administrateur');
  const archived = readFileSync(join(dir, 'archive-audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(archived.length, n0 + 3 - 5, 'tout l\'excédent est conservé');
  assert.ok(archived.some((e) => e.id === oldest), 'les plus anciennes entrées sont archivées');
  store.close();
  rmSync(dir, { recursive: true });
});

test('flux temps réel bornés par session (descripteurs, mémoire)', async () => {
  const c = client(srv.base);
  await c.login('Sophie Martin', '2345');
  const open = [];
  for (let i = 0; i < 6; i++) { const st = await openStream(srv.base, c.cookie); assert.equal(st.status, 200); open.push(st); }
  const extra = await openStream(srv.base, c.cookie);
  assert.equal(extra.status, 429);
  extra.close();
  const other = client(srv.base);
  await other.login('Karim Benali', '2468');
  const theirs = await openStream(srv.base, other.cookie);
  assert.equal(theirs.status, 200, 'les autres sessions ne sont pas concernées');
  theirs.close();
  open.pop().close();
  let status = 0;
  for (let i = 0; i < 40 && status !== 200; i++) { // fermeture constatée par le serveur : une place se libère
    await new Promise((r) => setTimeout(r, 25));
    const again = await openStream(srv.base, c.cookie);
    status = again.status;
    again.close();
  }
  assert.equal(status, 200);
  open.forEach((st) => st.close());
});

test('débit d\'opérations borné par compte (écriture disque à chaque opération) ; l\'appareil réessaie plus tard', async () => {
  let clock = Date.now();
  const s = await startApp({ now: () => new Date(clock) });
  try {
    const c = s.client();
    const me = await c.login('Sophie Martin', '2345');
    const batch = () => ({ userId: me.user.id, ops: Array.from({ length: 200 }, (_, i) => ({ opId: opId(i), name: 'inconnue', params: {}, depotId: me.depotId, at: new Date(clock).toISOString() })) });
    for (let i = 0; i < 6; i++) assert.equal((await c.post('/api/ops', batch())).status, 200, `envoi ${i + 1}`);
    const over = await c.post('/api/ops', batch());
    assert.equal(over.status, 429);
    assert.equal(over.json.code, 'rate');
    assert.equal((await c.post('/api/ops', { userId: me.user.id, ops: [] })).status, 200, 'une liste vide (rattrapage) reste possible');
    const other = s.client();
    const karim = await other.login('Karim Benali', '2468');
    assert.equal((await other.post('/api/ops', { ...batch(), userId: karim.user.id })).status, 200, 'les autres comptes ne sont pas concernés');
    clock += 61_000;
    assert.equal((await c.post('/api/ops', batch())).status, 200, 'une minute plus tard : accepté');
  } finally { await s.stop(); }
});

test('sessions bornées par compte : des connexions en boucle ne font pas grossir la mémoire ni sessions.json', async () => {
  const s = await startApp();
  try {
    const clients = [];
    for (let i = 0; i < MAX_SESSIONS_PER_USER + 2; i++) { const c = s.client(); await c.login('Julie Laurent', '4567'); clients.push(c); }
    const status = await Promise.all(clients.map(async (c) => (await c.get('/api/session')).status));
    assert.deepEqual(status.slice(0, 2), [401, 401], 'les plus anciennes sont fermées');
    assert.ok(status.slice(2).every((x) => x === 200), 'les plus récentes restent ouvertes');
  } finally { await s.stop(); }
});

test('vérifications de PIN simultanées plafonnées : au-delà, « serveur occupé » sans compter d\'échec', async () => {
  const s = await startApp();
  try {
    const julie = byName(s.app.store.db, 'Julie Laurent');
    const login = () => s.app.auth.login({ orgCode: ORG, userId: julie.id, pin: '4567' }, '192.0.2.1');
    const results = await Promise.all(Array.from({ length: MAX_PIN_CHECKS + 5 }, login));
    assert.equal(results.filter((r) => r.ok).length, MAX_PIN_CHECKS);
    assert.deepEqual(results.filter((r) => !r.ok).map((r) => r.status), Array(5).fill(503));
    assert.equal((await login()).ok, true, 'capacité rendue, aucun verrouillage');
  } finally { await s.stop(); }
});

test('code d\'accès de moins de 8 caractères refusé au démarrage (hors démonstration)', async () => {
  const dir = tempDir();
  try {
    const make = (orgCode, extra = {}) => createApp({ dataDir: dir, staticDir: ROOT, orgCode, bootstrap: demoDb, log: silent, backupKeep: 0, ...extra });
    await assert.rejects(make('ABC1234'), /8 caractères minimum/);
    await assert.rejects(make('   ABCDEFG   '), /8 caractères minimum/, 'espaces non comptés');
    await assert.rejects(make(''), /ORG_CODE manquant/);
    const demo = await make('DEMO', { minOrgCode: 4 });
    await demo.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── Point d'entrée (server/index.js) : configuration vérifiée avant toute ouverture sur le réseau ──
const freePort = () => new Promise((resolve) => { const t = net.createServer().listen(0, '127.0.0.1', () => { const { port } = t.address(); t.close(() => resolve(port)); }); });

/** Lance le serveur réel ; s'arrête seul (erreur de configuration) ou dès que `ready` apparaît (arrêt propre). */
function runServer(env, { ready = /Sauvegardes automatiques/ } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { PATH: process.env.PATH, HOST: '127.0.0.1', BACKUP_KEEP: '0', ...env } });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`serveur muet :\n${out}\n${err}`)); }, 20_000);
    child.stdout.on('data', (d) => { out += d; if (ready.test(out)) child.kill('SIGTERM'); });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

test('démarrage : ORG_CODE trop court ou PIN administrateur de 4 chiffres refusés ; PIN initial laissé dans .env signalé', { timeout: 60_000 }, async () => {
  const dir = tempDir();
  try {
    const short = await runServer({ ORG_CODE: 'court12', DATA_DIR: dir, PORT: String(await freePort()) });
    assert.equal(short.code, 1);
    assert.match(short.err, /ORG_CODE trop court : 8 caractères minimum/);
    const base = { ORG_CODE: 'ATELIER-2026', DATA_DIR: dir, BOOTSTRAP_ADMIN_NAME: 'Camille' };
    const weak = await runServer({ ...base, BOOTSTRAP_ADMIN_PIN: '8264', PORT: String(await freePort()) });
    assert.equal(weak.code, 1);
    assert.match(weak.err, /BOOTSTRAP_ADMIN_PIN : Un administrateur doit choisir un PIN de 6 chiffres/);
    const first = await runServer({ ...base, BOOTSTRAP_ADMIN_PIN: '826419', PORT: String(await freePort()) });
    assert.match(first.out, /Première installation : administrateur « Camille »/);
    assert.doesNotMatch(first.err, /BOOTSTRAP_ADMIN_PIN est encore défini/, 'installation : variable légitime');
    const next = await runServer({ ...base, BOOTSTRAP_ADMIN_PIN: '826419', PORT: String(await freePort()) });
    assert.match(next.err, /BOOTSTRAP_ADMIN_PIN est encore défini/, 'installation faite : PIN en clair à retirer de .env');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
