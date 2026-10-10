// Serveur HTTP : l'application (fichiers statiques), l'API de synchronisation (B1) et le relais IA (B3).
// Aucune dépendance web : node:http suffit et reste auditable.
//
// API (JSON, même origine que l'application) :
//   GET  /api/config              mode serveur ? IA disponible ? (sans authentification)
//   POST /api/directory           annuaire de connexion (dépôts, comptes) contre le code d'accès
//   POST /api/login | /api/logout session par cookie HttpOnly
//   GET  /api/session             session en cours
//   GET  /api/snapshot            état complet (sans PIN) pour un appareil
//   GET  /api/events?since=v      événements manqués
//   GET  /api/state               version + empreinte (contrôle de divergence)
//   GET  /api/stream              flux temps réel (Server-Sent Events)
//   POST /api/ops                 opérations d'un appareil (file d'attente hors ligne)
//   POST /api/ai/analyze          analyse photo (clé API côté serveur)
//   GET  /api/admin/backup        sauvegarde complète (administrateur)
//   POST /api/admin/restore       restauration (administrateur)
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createSyncStore } from './sync-store.js';
import { createAuth } from './auth.js';
import { createAiProxy } from './ai.js';
import { makeBackup, parseBackup } from '../js/core/schema.js';
import { can } from '../js/core/auth.js';
import { APP_VERSION } from '../js/core/config.js';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};
// Seuls ces fichiers et dossiers de l'application sont servis (jamais server/, tests/, .git, node_modules…)
const STATIC_FILES = new Set(['index.html', 'manifest.webmanifest', 'sw.js']);
const STATIC_DIRS = new Set(['css', 'js', 'vendor', 'fonts', 'icons']);

const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; "
  + "connect-src 'self' https://api.anthropic.com; media-src 'self' blob:; manifest-src 'self'; worker-src 'self'; base-uri 'none'; "
  + "form-action 'none'; frame-ancestors 'none'";

const LIMITS = { json: 64 * 1024, ops: 2 * 1024 * 1024, ai: 8 * 1024 * 1024, restore: 30 * 1024 * 1024, opsPerRequest: 200 };
const SERVER_LOGS = { history: 200_000, audit: 100_000 };

class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

/**
 * @param {object} o
 * @param {string} o.dataDir            dossier des données (snapshot, journal, sessions)
 * @param {string} o.staticDir          racine de l'application
 * @param {string} o.orgCode            code d'accès de l'entreprise (obligatoire)
 * @param {() => Promise<object>} [o.bootstrap]  base initiale si aucune donnée (démo ou installation vide)
 * @param {{apiKey?:string, baseURL?:string, dailyLimit?:number}} [o.ai]
 * @param {boolean} [o.trustProxy]      derrière un proxy inverse (X-Forwarded-For / -Proto / -Host)
 */
export async function createApp({ dataDir, staticDir, orgCode, bootstrap, ai = {}, trustProxy = false, sessionHours = 12, now = () => new Date(), log = console, storeOptions = {} }) {
  if (!orgCode || String(orgCode).trim().length < 4) throw new Error('ORG_CODE manquant ou trop court (4 caractères minimum).');
  const root = resolve(staticDir);
  const store = createSyncStore({ dataDir, now, log, historyMax: SERVER_LOGS.history, auditMax: SERVER_LOGS.audit, ...storeOptions });
  if (!store.load()) {
    if (!bootstrap) throw new Error('Aucune donnée et aucune base initiale : configurez DEMO=1 ou BOOTSTRAP_ADMIN_NAME / BOOTSTRAP_ADMIN_PIN.');
    store.bootstrap(await bootstrap());
    log.info?.('Base initiale créée');
  }
  const auth = createAuth({ store, dataDir, orgCode, sessionHours, now: () => now().getTime(), log });
  const aiProxy = createAiProxy({ ...ai, now, log });
  const streams = new Set();
  let snapCache = null; // instantané sérialisé et compressé, réutilisé tant que la version ne change pas

  // ── Utilitaires de requête ──
  const header = (req, name) => { const v = req.headers[name]; return Array.isArray(v) ? v[0] : v; };
  const isHttps = (req) => Boolean(req.socket.encrypted) || (trustProxy && header(req, 'x-forwarded-proto')?.split(',')[0].trim() === 'https');
  const hostOf = (req) => (trustProxy && header(req, 'x-forwarded-host')?.split(',')[0].trim()) || header(req, 'host') || '';
  const ipOf = (req) => (trustProxy && header(req, 'x-forwarded-for')?.split(',')[0].trim()) || req.socket.remoteAddress || '?';

  function securityHeaders(req, res) {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=(), payment=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  }

  function send(req, res, status, body, headers = {}) {
    let data = Buffer.from(JSON.stringify(body));
    const h = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers };
    if (data.length > 8192 && /\bgzip\b/.test(header(req, 'accept-encoding') ?? '')) { data = gzipSync(data); h['Content-Encoding'] = 'gzip'; h.Vary = 'Accept-Encoding'; }
    h['Content-Length'] = data.length;
    res.writeHead(status, h);
    res.end(req.method === 'HEAD' ? undefined : data);
  }

  /** Corps JSON borné. Les requêtes d'écriture doivent venir de l'application (même origine, JSON). */
  async function readJson(req, limit) {
    const declared = Number(header(req, 'content-length'));
    if (declared > limit) throw new HttpError(413, 'Requête trop volumineuse.');
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > limit) throw new HttpError(413, 'Requête trop volumineuse.');
      chunks.push(c);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    try { return { json: JSON.parse(text || 'null'), text }; } catch { throw new HttpError(400, 'JSON illisible.'); }
  }

  /**
   * Protection CSRF (en plus du cookie SameSite=Strict) pour toute écriture : JSON obligatoire (un formulaire
   * d'un autre site ne peut pas en envoyer sans autorisation préalable du serveur) et origine identique.
   */
  function checkWrite(req) {
    if (!/^application\/json\b/i.test(header(req, 'content-type') ?? '')) throw new HttpError(415, 'Type de contenu attendu : application/json.');
    const origin = header(req, 'origin');
    if (origin) {
      let host = '';
      try { host = new URL(origin).host; } catch { /* origine invalide */ }
      if (host !== hostOf(req)) throw new HttpError(403, 'Origine refusée.');
    }
    const site = header(req, 'sec-fetch-site');
    if (site && site !== 'same-origin' && site !== 'none') throw new HttpError(403, 'Requête inter-sites refusée.');
  }

  function session(req, perm) {
    const s = auth.authenticate(req);
    if (!s) throw new HttpError(401, 'Session expirée : reconnectez-vous.', { code: 'auth' });
    if (perm && !can(s.user.role, perm)) throw new HttpError(403, 'Action non autorisée pour votre rôle.', { code: 'forbidden' });
    return s;
  }

  const cookie = (req, value, maxAge) => `${auth.COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;

  // ── Routes ──
  const routes = {
    'GET /api/config': (req, res) => send(req, res, 200, {
      server: true, version: APP_VERSION, ai: Boolean(aiProxy), aiDailyLimit: aiProxy?.dailyLimit ?? 0, demo: store.db.meta.demo === true,
    }),

    async 'POST /api/directory'(req, res) {
      const { json } = await readJson(req, LIMITS.json);
      const org = auth.checkOrgFrom(json?.orgCode, ipOf(req));
      if (org === 'blocked') throw new HttpError(429, 'Trop de tentatives depuis cette adresse : patientez quelques minutes.');
      if (org !== 'ok') throw new HttpError(403, 'Code d\'accès incorrect.', { code: 'org' });
      const meta = store.db.meta;
      send(req, res, 200, { ...auth.directory(), demoPins: meta.demo ? meta.demoPins ?? [] : [] });
    },

    async 'POST /api/login'(req, res) {
      const { json } = await readJson(req, LIMITS.json);
      const r = await auth.login(json ?? {}, ipOf(req));
      if (!r.ok) throw new HttpError(r.status, r.error, { code: r.status === 403 ? 'org' : 'pin', retryMs: r.retryMs ?? 0 });
      store.serverOp('recordAuth', { kind: 'login' }, r.user, r.depotId);
      send(req, res, 200, { user: r.user, depotId: r.depotId, pin: r.pin, v: store.version }, { 'Set-Cookie': cookie(req, r.token, sessionHours * 3600) });
    },

    async 'POST /api/logout'(req, res) {
      const s = auth.authenticate(req);
      if (s) store.serverOp('recordAuth', { kind: 'logout' }, s.user, s.depotId);
      auth.logout(req);
      send(req, res, 200, { ok: true }, { 'Set-Cookie': cookie(req, '', 0) });
    },

    'GET /api/session'(req, res) {
      const s = session(req);
      send(req, res, 200, { user: { id: s.user.id, name: s.user.name, role: s.user.role, depotId: s.user.depotId }, depotId: s.depotId, v: store.version });
    },

    'GET /api/snapshot'(req, res) {
      session(req);
      // Après un redémarrage ou une restauration, beaucoup d'appareils le demandent en même temps : une seule sérialisation par version
      if (snapCache?.v !== store.version) {
        const json = Buffer.from(JSON.stringify(store.snapshot()));
        snapCache = { v: store.version, json, gz: gzipSync(json) };
      }
      const gz = /\bgzip\b/.test(header(req, 'accept-encoding') ?? '');
      const body = gz ? snapCache.gz : snapCache.json;
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': body.length, ...(gz ? { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' } : {}) });
      res.end(req.method === 'HEAD' ? undefined : body);
    },

    'GET /api/state'(req, res) { session(req); send(req, res, 200, { v: store.version, hash: store.hash() }); },

    'GET /api/events'(req, res, url) {
      session(req);
      const events = store.eventsSince(url.searchParams.get('since'));
      send(req, res, 200, events === null ? { reset: true, v: store.version } : { events, v: store.version });
    },

    'GET /api/stream'(req, res, url) {
      session(req);
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
      const write = (ev) => res.write(ev.reset ? `id: ${ev.v}\nevent: reset\ndata: {"v":${ev.v}}\n\n` : `id: ${ev.v}\nevent: op\ndata: ${JSON.stringify(ev)}\n\n`);
      res.write('retry: 3000\n\n');
      const missed = store.eventsSince(header(req, 'last-event-id') ?? url.searchParams.get('since'));
      if (missed === null) write({ v: store.version, reset: true });
      else missed.forEach(write);
      const unsub = store.subscribe(write);
      // Battement : garde la connexion ouverte à travers les proxys et coupe le flux d'une session révoquée.
      const beat = setInterval(() => {
        if (!auth.authenticate(req)) { res.write('event: auth\ndata: {}\n\n'); stop(); return; }
        res.write('event: ping\ndata: {}\n\n'); // visible du client : détection d'une connexion morte
      }, 25_000);
      const entry = { stop: null };
      function stop() { clearInterval(beat); unsub(); streams.delete(entry); res.end(); }
      entry.stop = stop;
      streams.add(entry);
      req.on('close', () => { clearInterval(beat); unsub(); streams.delete(entry); });
    },

    async 'POST /api/ops'(req, res) {
      const s = session(req);
      const { json } = await readJson(req, LIMITS.ops);
      // Les opérations sont attribuées au compte de la session : jamais celles d'un autre compte resté en file.
      if (json?.userId !== s.user.id) throw new HttpError(409, 'Ces opérations appartiennent à un autre compte.', { code: 'session_mismatch' });
      const list = Array.isArray(json?.ops) ? json.ops : null;
      if (!list || list.length > LIMITS.opsPerRequest) throw new HttpError(400, 'Liste d\'opérations invalide.');
      const results = [];
      for (const op of list) {
        const r = store.apply({ opId: op?.opId, name: op?.name, params: op?.params, depotId: op?.depotId, at: op?.at }, s.user);
        if (r.status === 'ok') afterOp(op, s);
        results.push(r.status === 'rejected' ? { opId: op?.opId, status: r.status, code: r.code, message: r.message } : { opId: op?.opId, status: r.status, v: r.v });
      }
      const events = store.eventsSince(json.since);
      send(req, res, 200, { results, v: store.version, ...(events === null ? { reset: true } : { events }) });
    },

    async 'POST /api/ai/analyze'(req, res) {
      const s = session(req, 'article.edit');
      if (!aiProxy) throw new HttpError(404, 'Analyse photo non configurée sur le serveur.', { code: 'ai_off' });
      const { json } = await readJson(req, LIMITS.ai);
      const ctrl = new AbortController();
      res.on('close', () => { if (!res.writableEnded) ctrl.abort(); });
      const r = await aiProxy.analyze(json, s.user, ctrl.signal);
      if (r.status !== 200) throw new HttpError(r.status, r.error, { code: 'ai' });
      send(req, res, 200, { message: r.message });
    },

    'GET /api/admin/backup'(req, res) {
      const s = session(req, 'data.manage');
      const t = now();
      log.info?.(`sauvegarde téléchargée par ${s.user.name}`);
      const data = Buffer.from(makeBackup(store.db, t));
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': data.length,
        'Content-Disposition': `attachment; filename="mode-stock-serveur-${t.toISOString().slice(0, 10)}.json"`,
      });
      res.end(data);
    },

    async 'POST /api/admin/restore'(req, res) {
      const s = session(req, 'data.manage');
      const { text } = await readJson(req, LIMITS.restore);
      let restored;
      try { restored = parseBackup(text, now(), { limits: SERVER_LOGS, maxBytes: LIMITS.restore }).db; } catch (e) { throw new HttpError(400, e.message); }
      store.flush(); // l'état précédent reste dans snapshot.json jusqu'au remplacement ci-dessous
      store.replace(restored);
      auth.revokeAll(restored.users[s.user.id] ? s.key : null);
      log.warn?.(`base restaurée par ${s.user.name}`);
      send(req, res, 200, { ok: true, v: store.version, keptSession: Boolean(restored.users[s.user.id]) });
    },
  };

  /** Effets d'une opération acceptée sur les sessions : un compte supprimé ou dont le PIN change est déconnecté ailleurs. */
  function afterOp(op, s) {
    const p = op.params && typeof op.params === 'object' ? op.params : {};
    if (op.name === 'deleteUser') auth.revokeUser(typeof p.id === 'string' ? p.id : String(op.params));
    else if (op.name === 'saveUser' && p.id && p.pin) auth.revokeUser(p.id, p.id === s.user.id ? s.key : null);
    else if (op.name === 'changeOwnPin') auth.revokeUser(s.user.id, s.key);
  }

  // ── Fichiers de l'application ──
  async function serveStatic(req, res, url) {
    let rel;
    try { rel = decodeURIComponent(url.pathname).replace(/^\/+/, ''); } catch { rel = '\u0000'; }
    if (rel === '') rel = 'index.html';
    const top = rel.split('/')[0];
    const allowed = STATIC_FILES.has(rel) || (STATIC_DIRS.has(top) && rel.includes('/'));
    const file = resolve(root, rel);
    if (!allowed || rel.includes('\u0000') || rel.split('/').some((p) => p.startsWith('.')) || !file.startsWith(root + sep)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Introuvable');
    }
    let st;
    try { st = await stat(file); } catch { st = null; }
    if (!st?.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Introuvable'); }
    const page = rel === 'index.html';
    const etag = `W/"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}${page ? '-s' : ''}"`;
    const h = { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache', ETag: etag };
    if (rel === 'sw.js') h['Service-Worker-Allowed'] = '/';
    if (header(req, 'if-none-match') === etag) { res.writeHead(304, h); return res.end(); }
    let body = await readFile(file);
    // La page annonce le mode serveur (lu au démarrage, y compris hors ligne depuis le cache du service worker)
    if (page) body = Buffer.from(body.toString('utf8').replace('<meta name="mode-sync" content="static">', '<meta name="mode-sync" content="server">'));
    h['Content-Length'] = body.length;
    res.writeHead(200, h);
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  const server = http.createServer(async (req, res) => {
    securityHeaders(req, res);
    let url;
    try { url = new URL(req.url, 'http://local'); } catch { res.writeHead(400); return res.end(); }
    const api = url.pathname.startsWith('/api/');
    try {
      if (!api) {
        if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end(); }
        return await serveStatic(req, res, url);
      }
      const route = routes[`${req.method === 'HEAD' ? 'GET' : req.method} ${url.pathname}`];
      if (!route) throw new HttpError(404, 'Ressource inconnue.');
      if (req.method !== 'GET' && req.method !== 'HEAD') checkWrite(req);
      await route(req, res, url);
    } catch (e) {
      if (res.headersSent) { res.destroy(); return; }
      if (e instanceof HttpError) return send(req, res, e.status, { error: e.message, ...e.extra });
      log.error?.(`${req.method} ${url.pathname}`, e);
      send(req, res, 500, { error: 'Erreur interne du serveur.' });
    }
  });
  server.headersTimeout = 20_000;
  server.requestTimeout = 120_000; // analyse photo comprise
  server.keepAliveTimeout = 30_000;

  return {
    server, store, auth, ai: aiProxy,
    /** Arrêt propre : flux fermés, journal et instantané écrits. */
    async close() {
      for (const s of [...streams]) s.stop();
      await new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); });
      auth.close();
      store.close();
    },
  };
}

