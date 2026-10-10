// Aides des tests du serveur : application réelle sur un port libre, dossier de données temporaire,
// client HTTP avec cookie (comme un navigateur), lecture d'un flux SSE.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../server/app.js';
import { buildDemoDb } from '../../js/core/seed.js';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const ORG = 'ATELIER-TEST';
export const silent = { info() {}, warn() {}, error() {} };

let demo = null;
/** Base de démonstration (PIN hachés avec 10 000 itérations : tests rapides), construite une fois. */
export async function demoDb() {
  demo ??= await buildDemoDb(new Date(), { pinIterations: 10_000 });
  return structuredClone(demo);
}

export const tempDir = () => mkdtempSync(join(tmpdir(), 'mode-srv-'));

/** Démarre une application. `dir` réutilisable pour tester un redémarrage. */
export async function startApp({ dir = tempDir(), db, ai, now, storeOptions, sessionHours, backupKeep } = {}) {
  const initial = db ?? (await demoDb());
  const app = await createApp({ dataDir: dir, staticDir: ROOT, orgCode: ORG, bootstrap: async () => initial, ai, now, log: silent, storeOptions, sessionHours, backupKeep });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return {
    app, dir, base,
    client: (opts) => client(base, opts),
    async stop({ keep = false } = {}) { await app.close(); if (!keep) rmSync(dir, { recursive: true, force: true }); },
  };
}

/** Client HTTP minimal avec gestion du cookie de session. */
export function client(base, { origin } = {}) {
  let cookie = '';
  async function req(method, path, body, headers = {}) {
    const h = { ...headers };
    if (cookie) h.cookie = cookie;
    if (origin) h.origin = origin;
    let payload;
    if (body !== undefined) { h['content-type'] ??= 'application/json'; payload = typeof body === 'string' ? body : JSON.stringify(body); }
    const res = await fetch(base + path, { method, headers: h, body: payload, redirect: 'manual' });
    const set = res.headers.get('set-cookie');
    if (set) {
      const m = /mode_session=([^;]*)/.exec(set);
      if (m) cookie = m[1] ? `mode_session=${m[1]}` : '';
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* pas du JSON */ }
    return { status: res.status, json, text, headers: res.headers };
  }
  return {
    get: (p, h) => req('GET', p, undefined, h),
    post: (p, b, h) => req('POST', p, b ?? {}, h),
    get cookie() { return cookie; },
    set cookie(v) { cookie = v; },
    /** Connexion complète : annuaire puis PIN. */
    async login(name, pin, depotCode) {
      const dir = await req('POST', '/api/directory', { orgCode: ORG });
      const user = dir.json.users.find((u) => u.name === name);
      const depotId = depotCode ? dir.json.depots.find((d) => d.code === depotCode).id : undefined;
      const r = await req('POST', '/api/login', { orgCode: ORG, userId: user.id, pin, depotId });
      if (r.status !== 200) throw new Error(`login ${name}: ${r.status} ${r.text}`);
      return { ...r.json, directory: dir.json };
    },
  };
}

/** Ouvre un flux SSE ; `next(pred)` attend le prochain événement satisfaisant `pred`. */
export async function openStream(base, cookie, { since = '', lastEventId } = {}) {
  const ctrl = new AbortController();
  const headers = { cookie };
  if (lastEventId !== undefined) headers['last-event-id'] = String(lastEventId);
  const res = await fetch(`${base}/api/stream${since !== '' ? `?since=${since}` : ''}`, { headers, signal: ctrl.signal });
  const events = [];
  const waiters = [];
  let buf = '';
  const flush = () => {
    for (const w of [...waiters]) {
      const i = events.findIndex(w.pred);
      if (i >= 0) { waiters.splice(waiters.indexOf(w), 1); w.resolve(events.splice(i, 1)[0]); }
    }
  };
  (async () => {
    const dec = new TextDecoder();
    try {
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let k;
        while ((k = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, k);
          buf = buf.slice(k + 2);
          const ev = { event: 'message', data: '' };
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) ev.event = line.slice(7);
            else if (line.startsWith('data: ')) ev.data += line.slice(6);
            else if (line.startsWith('id: ')) ev.id = line.slice(4);
          }
          if (ev.data) { ev.json = JSON.parse(ev.data); events.push(ev); flush(); }
        }
      }
    } catch { /* flux fermé */ }
  })();
  return {
    status: res.status,
    next(pred = () => true, ms = 3000) {
      return new Promise((resolve, reject) => {
        const w = { pred, resolve };
        waiters.push(w);
        flush();
        setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); reject(new Error('aucun événement SSE')); } }, ms);
      });
    },
    close: () => ctrl.abort(),
  };
}

export const byName = (db, name) => Object.values(db.users).find((u) => u.name === name);
export const depotByCode = (db, code) => Object.values(db.depots).find((d) => d.code === code);
export const opId = (n = 0) => `op${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}${n}`;
