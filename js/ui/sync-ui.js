// Mode serveur côté interface : détection au démarrage, moteur de synchronisation, flux temps réel,
// connexion (en ligne / déverrouillage hors ligne), état de synchronisation (bouton, feuille, bandeaux).
import { KEYS } from '../core/config.js';
import { createSyncEngine } from '../core/sync-engine.js';
import { verifyPin } from '../core/auth.js';
import { store, storage, state, setEngine, lockout } from './state.js';
import { api, apiFetch, apiUrl } from './net.js';
import { idbReplica } from './idb.js';
import { html, fmtRelative, fmtDateTime, plural } from '../lib/text.js';
import { $, icon, actions } from './dom.js';
import { openSheet, closeSheet, confirmDialog } from './dialogs.js';
import { toast } from './toast.js';
import { setBanner, clearBanner, endSession } from './session.js';

const VERIFY_EVERY = 10 * 60_000;
const SILENCE_MS = 65_000; // le serveur émet un battement toutes les 25 s : au-delà, la connexion est morte (réseau coupé sans fermeture)
const KNOWN_TTL = 30 * 86_400_000; // déverrouillage hors ligne possible 30 jours après la dernière connexion en ligne
const S = { config: null, engine: null, es: null, esTimer: null, esRetry: 0, verifyTimer: null, watchdog: null, seen: 0, logout: Promise.resolve(), wired: false };

const readJson = (key, fallback) => { try { return JSON.parse(storage.getItem(key)) ?? fallback; } catch { return fallback; } };
const writeJson = (key, value) => { try { storage.setItem(key, JSON.stringify(value)); } catch { /* quota : non conservé */ } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export const serverConfig = () => S.config;
export const orgCode = () => { try { return storage.getItem(KEYS.orgCode) || ''; } catch { return ''; } };
/** Annuaire de connexion en cache (dépôts, comptes, PIN de démonstration). */
export const directory = () => readJson(KEYS.syncState, {})?.directory ?? null;
const known = () => {
  const all = readJson(KEYS.knownUsers, {});
  const now = Date.now();
  return Object.fromEntries(Object.entries(all).filter(([, k]) => k && now - (k.at || 0) < KNOWN_TTL));
};
export const isKnownUser = (id) => Boolean(known()[id]?.pin);

// ── Démarrage ──
/**
 * L'application est-elle servie par le serveur de synchronisation ? Le serveur le signale dans la page
 * elle-même (balise meta « mode-sync »), donc aussi hors ligne quand la page vient du cache du service worker.
 * Hébergement statique (GitHub Pages…) : mode autonome, aucune requête vers une API inexistante.
 */
export async function detectServer() {
  if (document.querySelector('meta[name="mode-sync"]')?.content !== 'server') return null;
  try {
    const r = await apiFetch('config', { timeout: 8000 });
    if (r.status === 200 && r.json?.server === true) {
      writeJson(KEYS.syncState, { ...readJson(KEYS.syncState, {}), server: true, config: r.json });
      return r.json;
    }
  } catch { /* hors ligne */ }
  return { server: true, ...readJson(KEYS.syncState, {})?.config, offline: true };
}

export async function initServerMode(config) {
  S.config = config;
  state.serverMode = true;
  const engine = createSyncEngine({ api, storage, replica: idbReplica, log: console });
  S.engine = engine;
  await engine.init();
  store.attach(engine);
  setEngine(facade);
  engine.subscribe(onEngine);
  if (S.wired) return;
  S.wired = true;
  window.addEventListener('storage', (e) => { if (e.key === KEYS.syncQueue) engine.queueChanged(); });
  window.addEventListener('online', () => { if (engine.serverUser) { connect(); engine.flush(); } });
  window.addEventListener('offline', () => disconnect());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') engine.persist();
    else if (engine.serverUser && state.session) { connect(); engine.flush(); }
  });
  window.addEventListener('pagehide', () => engine.persist());
}

function onEngine(type, detail) {
  if (type === 'changed') store.notify('changed', detail);
  else if (type === 'status') paint(detail);
  else if (type === 'rejected') {
    const first = detail[0];
    toast(`Refusé par le serveur — ${first.label} : ${first.message}${detail.length > 1 ? ` (+${detail.length - 1})` : ''}`, { tone: 'error', ms: 10_000, action: { label: 'Détails', run: openStatus } });
  } else if (type === 'auth' && detail === 'expired') {
    disconnect();
  }
}

// ── Flux temps réel ──
function connect() {
  const engine = S.engine;
  if (!engine?.serverUser || typeof EventSource === 'undefined') return;
  if (S.es && S.es.readyState !== EventSource.CLOSED) return;
  clearTimeout(S.esTimer);
  const es = new EventSource(apiUrl(`stream?since=${Math.max(0, engine.version)}`));
  S.es = es;
  const parse = (e) => { S.seen = Date.now(); try { return JSON.parse(e.data); } catch { return null; } };
  es.addEventListener('op', (e) => engine.receive(parse(e)));
  es.addEventListener('reset', (e) => engine.receive({ ...parse(e), reset: true }));
  es.addEventListener('ping', parse);
  es.addEventListener('auth', () => { es.close(); S.es = null; engine.setConnected(false); engine.checkSession(); });
  es.onopen = () => { S.seen = Date.now(); S.esRetry = 0; engine.setConnected(true); engine.flush(); };
  es.onerror = () => {
    engine.setConnected(false);
    if (es.readyState !== EventSource.CLOSED) return; // le navigateur se reconnecte seul
    S.es = null;
    engine.checkSession().then(() => {
      if (!state.session || engine.status().auth === 'expired') return; // session close : reconnexion demandée à l'utilisateur
      S.esRetry = Math.min(6, S.esRetry + 1);
      S.esTimer = setTimeout(connect, 1000 * 2 ** S.esRetry);
    });
  };
  clearInterval(S.verifyTimer);
  S.verifyTimer = setInterval(() => { if (S.es?.readyState === EventSource.OPEN) engine.verify().catch(() => {}); }, VERIFY_EVERY);
  clearInterval(S.watchdog);
  S.watchdog = setInterval(() => {
    if (S.es?.readyState === EventSource.OPEN && Date.now() - S.seen > SILENCE_MS) { disconnect(); S.esTimer = setTimeout(connect, 2000); }
  }, 15_000);
}

function disconnect() {
  clearTimeout(S.esTimer);
  clearInterval(S.verifyTimer);
  clearInterval(S.watchdog);
  S.es?.close();
  S.es = null;
  S.engine?.setConnected(false);
}

// ── Connexion ──
/** Annuaire à jour depuis le serveur. @returns {{ok:true, directory} | {ok:false, status, error}} ; rejette hors ligne */
export async function fetchDirectory(code = orgCode()) {
  const r = await apiFetch('directory', { method: 'POST', body: { orgCode: code }, timeout: 10_000 });
  if (r.status === 200) {
    try { storage.setItem(KEYS.orgCode, code.trim()); } catch { /* ignoré */ }
    writeJson(KEYS.syncState, { ...readJson(KEYS.syncState, {}), server: true, directory: r.json });
    return { ok: true, directory: r.json };
  }
  if (r.status === 403) { try { storage.removeItem(KEYS.orgCode); } catch { /* ignoré */ } }
  return { ok: false, status: r.status, error: r.json?.error || 'Serveur indisponible.' };
}

/**
 * Connexion d'un compte : vérification par le serveur si le réseau répond, sinon déverrouillage hors ligne
 * (comptes déjà connectés sur cet appareil, avec la copie locale des données).
 * @returns {Promise<{ok:true, user:object, depotId:string, online:boolean} | {ok:false, error:string, retryMs?:number}>}
 */
export async function serverLogin(user, pin, depotId) {
  await S.logout; // une déconnexion en cours se termine avant d'ouvrir une nouvelle session
  let r;
  try {
    r = await apiFetch('login', { method: 'POST', body: { orgCode: orgCode(), userId: user.id, pin, depotId }, timeout: 15_000 });
  } catch {
    return offlineUnlock(user, pin, depotId);
  }
  if (r.status !== 200) return { ok: false, error: r.json?.error || 'Connexion refusée.', retryMs: r.json?.retryMs || 0, code: r.json?.code };
  const u = r.json.user;
  const all = readJson(KEYS.knownUsers, {});
  all[u.id] = { name: u.name, role: u.role, depotId: u.depotId, pin: r.json.pin, at: Date.now() };
  writeJson(KEYS.knownUsers, all);
  S.engine.setSession(u.id);
  try {
    if (!S.engine.db) await S.engine.resync(); // première connexion de l'appareil : chargement complet
    else S.engine.resync().catch(() => {});
  } catch {
    return { ok: false, error: 'Connexion établie, mais le chargement des données a échoué. Réessayez.' };
  }
  connect();
  return { ok: true, user: u, depotId: r.json.depotId, online: true };
}

async function offlineUnlock(user, pin, depotId) {
  const k = known()[user.id];
  if (!S.engine.db) return { ok: false, error: 'Serveur injoignable : la première connexion de cet appareil nécessite le réseau.' };
  if (!k?.pin) return { ok: false, error: 'Serveur injoignable, et ce compte ne s\'est jamais connecté sur cet appareil (ou pas depuis 30 jours).' };
  const st = lockout.status(user.id);
  if (st.locked) return { ok: false, error: 'Trop d\'essais.', retryMs: st.remainingMs };
  if (!(await verifyPin(k.pin, pin))) {
    const f = lockout.fail(user.id);
    return { ok: false, error: 'PIN incorrect.', retryMs: f.remainingMs };
  }
  lockout.success(user.id);
  const db = S.engine.db;
  const u = db.users[user.id] ?? { id: user.id, name: k.name, role: k.role, depotId: k.depotId };
  S.engine.setSession(u.id); // la session du serveur est peut-être toujours valide ; sinon, reconnexion demandée plus tard
  connect();
  return { ok: true, user: u, depotId: u.role === 'admin' && db.depots[depotId] ? depotId : u.depotId, online: false };
}

/** Déconnexion : les saisies en attente partent d'abord (5 s maximum), puis la session serveur est fermée. */
export function serverLogout() {
  const engine = S.engine;
  disconnect();
  clearBanner('sync-auth');
  S.logout = (async () => {
    try { await Promise.race([engine.flush(), wait(5000)]); } catch { /* hors ligne : elles attendront */ }
    try { await apiFetch('logout', { method: 'POST', body: {}, timeout: 5000 }); } catch { /* hors ligne */ }
    engine.clearSession();
  })();
  paint();
  return S.logout;
}

// ── État de synchronisation ──
function summary(s = S.engine.status()) {
  const me = state.session?.user.id;
  const blocked = me && s.auth === 'ok' && S.engine.serverUser && S.engine.serverUser !== me && S.engine.pending().some((e) => e.user.id === me);
  if (s.auth === 'expired' || blocked) return { state: 'auth', tone: 'error', text: 'Reconnexion nécessaire pour envoyer vos saisies' };
  if (s.rejected.length) return { state: 'error', tone: 'error', text: `${plural(s.rejected.length, 'saisie refusée', 'saisies refusées')} par le serveur` };
  if (!s.connected || !s.reachable) return { state: 'offline', tone: 'warn', text: s.pending ? `Hors ligne · ${plural(s.pending, 'saisie')} en attente` : `Hors ligne${s.lastSync ? ` · à jour ${fmtRelative(s.lastSync)}` : ''}` };
  if (s.pending) return { state: 'pending', tone: 'warn', text: `Envoi de ${plural(s.pending, 'saisie')}…` };
  return { state: 'ok', tone: 'ok', text: 'Synchronisé' };
}

/** Bouton d'état dans la barre du haut + bandeau de reconnexion. */
export function paint(s) {
  const btn = $('#sync-btn');
  if (!btn || !S.engine) return;
  if (!state.session) { btn.hidden = true; return; }
  const st = s ?? S.engine.status();
  const sum = summary(st);
  btn.hidden = false;
  btn.dataset.state = sum.state;
  btn.setAttribute('aria-label', `Synchronisation : ${sum.text}`);
  btn.title = sum.text;
  btn.querySelector('use')?.setAttribute('href', sum.state === 'ok' || sum.state === 'pending' ? '#i-cloud' : '#i-cloud-off');
  const count = $('#sync-count');
  count.hidden = !st.pending;
  count.textContent = String(st.pending);
  if (sum.state === 'auth') setBanner('sync-auth', { tone: 'error', text: 'Session serveur expirée : reconnectez-vous pour envoyer vos saisies.', action: { label: 'Se reconnecter', run: relogin } });
  else clearBanner('sync-auth');
}

function relogin() {
  const id = state.session?.user.id;
  endSession('Reconnectez-vous : vos saisies en attente partiront ensuite.', { userId: id });
}

function statusBody() {
  const s = S.engine.status();
  const sum = summary(s);
  const pending = S.engine.pending();
  const me = state.session?.user.id;
  const others = pending.filter((e) => e.user.id !== S.engine.serverUser);
  return html`
    <div class="banner ${sum.tone === 'ok' ? 'banner--ok' : sum.tone === 'error' ? 'banner--error' : ''}" role="status">${icon(sum.state === 'ok' ? 'cloud' : 'cloud-off', 'i--sm')}<span class="banner__text">${sum.text}</span></div>
    <p class="muted">${s.lastSync ? `Dernière mise à jour : ${fmtDateTime(s.lastSync)} · ` : ''}version ${Math.max(0, s.v)}${s.lastError && !s.connected ? ` · ${s.lastError}` : ''}</p>
    ${s.rejected.length ? html`<h3 class="eyebrow">Refusées par le serveur</h3>
      <p class="muted">Ces saisies n'ont pas été enregistrées : l'état a changé entre-temps (autre appareil, autre site). Vérifiez puis ressaisissez si nécessaire.</p>
      <ul class="list">${s.rejected.map((r) => html`<li class="row row--compact"><span class="row__body"><span class="row__title">${r.label}</span><span class="row__meta text-red">${r.message}</span><span class="row__meta">${r.by ?? ''}${r.at ? ` · ${fmtDateTime(r.at)}` : ''}</span></span></li>`)}</ul>
      <button type="button" class="btn btn--secondary btn--block" data-action="sync.ack">J'ai pris connaissance</button>` : ''}
    ${pending.length ? html`<h3 class="eyebrow">En attente d'envoi (${pending.length})</h3>
      <ul class="list">${pending.slice(0, 30).map((e) => html`<li class="row row--compact"><span class="row__body"><span class="row__title">${S.engine.describe(e)}</span><span class="row__meta">${e.user.name} · ${fmtRelative(e.at)}</span></span></li>`)}</ul>
      ${pending.length > 30 ? html`<p class="muted">… et ${pending.length - 30} autre(s).</p>` : ''}
      ${others.length ? html`<p class="muted">${plural(others.length, 'saisie')} d'un autre compte (${[...new Set(others.map((e) => e.user.name))].join(', ')}) : envoi à sa prochaine connexion en ligne sur cet appareil.</p>` : ''}` : html`<p class="muted">Aucune saisie en attente : tout est enregistré sur le serveur.</p>`}
    <div class="stack">
      ${sum.state === 'auth' && me ? html`<button type="button" class="btn btn--primary btn--block" data-action="sync.relogin">Se reconnecter</button>` : ''}
      <button type="button" class="btn btn--secondary btn--block" data-action="sync.now">${icon('swap')}Synchroniser maintenant</button>
    </div>`;
}

export function openStatus() {
  if (!S.engine) return;
  openSheet({ title: 'Synchronisation', body: statusBody() });
}

const facade = {
  submit: (name, params, ctx) => S.engine.submit(name, params, ctx),
  status: () => summary(),
  openStatus,
  ownPin: () => known()[state.session?.user.id]?.pin ?? null,
  rememberPin(pin) {
    const all = readJson(KEYS.knownUsers, {});
    const id = state.session?.user.id;
    if (id && all[id]) { all[id].pin = pin; writeJson(KEYS.knownUsers, all); }
  },
};

/** Sauvegarde complète du serveur (administrateur) : téléchargement direct (cookie de session). */
export function downloadServerBackup() {
  const a = document.createElement('a');
  a.href = apiUrl('admin/backup');
  a.download = '';
  document.body.append(a);
  a.click();
  a.remove();
}

/** Restauration côté serveur : tous les appareils rechargent les données. */
export async function restoreOnServer(text) {
  const r = await apiFetch('admin/restore', { method: 'POST', body: text, timeout: 120_000 });
  if (r.status !== 200) throw new Error(r.json?.error || `Restauration refusée (${r.status}).`);
  return r.json;
}

/** Oublie cet appareil : code d'accès, comptes connus, copie locale, file d'attente. */
async function forgetDevice() {
  for (const k of [KEYS.orgCode, KEYS.knownUsers, KEYS.syncState, KEYS.syncQueue, KEYS.syncRejected, KEYS.lock]) { try { storage.removeItem(k); } catch { /* ignoré */ } }
  await idbReplica.clear();
}

export function initSyncUi() {
  actions({
    async 'sync.now'(el) {
      el.disabled = true;
      try {
        await S.engine.flush();
        await S.engine.resync();
        const ok = await S.engine.verify();
        toast(ok === false ? 'Écart détecté : données rechargées depuis le serveur.' : 'Données à jour.', { tone: ok === false ? 'info' : 'ok' });
      } catch (e) {
        toast(e?.name === 'AuthExpired' ? 'Session expirée : reconnectez-vous.' : 'Serveur injoignable : nouvel essai automatique.', { tone: 'error' });
      }
      await closeSheet();
    },
    async 'sync.ack'() { S.engine.acknowledgeRejected(); await closeSheet(); },
    async 'sync.relogin'() { await closeSheet(); relogin(); },
    async 'sync.forget'() {
      const n = S.engine?.pending().length ?? 0;
      const ok = await confirmDialog({
        title: 'Oublier cet appareil ?', danger: true, confirmLabel: 'Oublier',
        message: `Le code d'accès, les comptes connus et la copie locale seront effacés de cet appareil.${n ? ` ⚠ ${plural(n, 'saisie')} pas encore envoyée${n > 1 ? 's' : ''} sera${n > 1 ? 'ont' : ''} PERDUE${n > 1 ? 'S' : ''}.` : ''}`,
      });
      if (!ok) return;
      if (state.session) await serverLogout();
      await forgetDevice();
      location.reload();
    },
  });
}
