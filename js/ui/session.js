// Session utilisateur : connexion, déconnexion, verrouillage après inactivité, bandeaux d'état, pastilles.
import { state, store, run, depot, db, prefs } from './state.js';
import { recordAuth } from '../core/ops.js';
import { isIdle } from '../core/auth.js';
import { pendingIncoming } from '../core/queries.js';
import { atelierOrders, centralQueue } from '../core/planning.js';
import { $, setHtml, html, icon } from './dom.js';
import { startRouter, stopRouter } from './router.js';
import { closeTransient } from './dialogs.js';
import { maybeShowBriefing } from './briefing.js';
import { toast } from './toast.js';

let lastActivity = Date.now();
let idleTimer = null;
let warned = false;
let onLogout = () => {};
export const setLogoutHandler = (fn) => { onLogout = fn; };

/** Marque une activité (touche, toucher, scan) pour repousser le verrouillage. */
export function touch() { lastActivity = Date.now(); warned = false; }

const limitMs = () => (db()?.meta.settings.sessionMinutes ?? 0) * 60_000;

function armIdle() {
  disarmIdle();
  touch();
  idleTimer = setInterval(() => {
    const limit = limitMs();
    if (!limit) return;
    const now = Date.now();
    if (isIdle(lastActivity, now, limit)) { endSession('Session verrouillée après une période d\'inactivité.'); return; }
    if (!warned && limit - (now - lastActivity) <= 30_000) {
      warned = true;
      toast('Verrouillage dans 30 s', { ms: 12_000, action: { label: 'Rester connecté', run: touch } });
    }
  }, 5000);
}
function disarmIdle() { if (idleTimer) clearInterval(idleTimer); idleTimer = null; }

for (const ev of ['pointerdown', 'keydown', 'touchstart']) document.addEventListener(ev, touch, { passive: true, capture: true });

export function startSession(user, depotId) {
  state.session = { user: { id: user.id, name: user.name, role: user.role, depotId: user.depotId }, depotId, loginAt: Date.now() };
  if (!state.serverMode) run(recordAuth, { kind: 'login' }); // en mode serveur, la connexion est journalisée par le serveur
  prefs.set('lastDepot', depotId);
  $('#login').hidden = true;
  $('#app').hidden = false;
  history.replaceState({ i: 0 }, '', '#/home');
  updateChrome();
  startRouter();
  armIdle();
  maybeShowBriefing();
  try { navigator.storage?.persist?.(); } catch { /* non supporté */ }
}

/**
 * Ferme la session. `replaceDb` : base à installer (restauration, passage en production) — elle l'est
 * APRÈS avoir détaché la session, sinon l'écouteur du store reverrait une session dont le compte a disparu.
 */
export function endSession(message = '', { replaceDb = null } = {}) {
  if (!state.session) return;
  if (!replaceDb) try { run(recordAuth, { kind: 'logout' }); } catch { /* base indisponible : on déconnecte quand même */ }
  state.session = null; // avant tout remplacement : les écouteurs du store (revalidation) ne doivent plus voir de session
  if (replaceDb) store.replace(replaceDb);
  stopRouter();
  closeTransient();
  disarmIdle();
  $('#app').hidden = true;
  history.replaceState(null, '', location.pathname + location.search);
  onLogout(message);
}

/** Dépôt actif (administrateur : changement de dépôt sans se reconnecter). */
export function switchDepot(depotId) {
  if (!db().depots[depotId]) return;
  state.session.depotId = depotId;
  prefs.set('lastDepot', depotId);
  updateChrome();
}

// ── Pastilles et bandeaux ──
export function updateChrome() {
  if (!state.session || !db()) return;
  const d = depot();
  const chip = $('#depot-chip');
  chip.hidden = Object.keys(db().depots).length < 2;
  chip.textContent = d.code || d.name;
  chip.title = d.name;
  // Pastille « Commandes » : ce qui attend une action dans ce dépôt
  const n = d.kind === 'central' ? centralQueue(db(), d.id).toPrepare.length : atelierOrders(db(), d.id).toReceive.length + pendingIncoming(db(), d.id).length;
  const count = $('#orders-count');
  count.hidden = n === 0;
  count.textContent = String(n);
  count.setAttribute('aria-label', d.kind === 'central' ? `${n} commande(s) à préparer` : `${n} livraison(s) à réceptionner`);
  $('#menu-dot').hidden = true;
  $('#net-dot').hidden = state.online;
  updateBanners();
}

const banners = new Map();
/** Affiche un bandeau persistant. `action` : { label, run } */
export function setBanner(id, { tone = 'warn', text, action }) { banners.set(id, { tone, text, action }); updateBanners(); }
export function clearBanner(id) { if (banners.delete(id)) updateBanners(); }

const bannerActions = new Map();
function updateBanners() {
  const host = $('#banners');
  if (!host) return;
  bannerActions.clear();
  const cls = { warn: '', info: 'banner--info', error: 'banner--error', ok: 'banner--ok' };
  setHtml(host, html`${[...banners.entries()].map(([id, b]) => {
    if (b.action) bannerActions.set(id, b.action.run);
    return html`<div class="banner ${cls[b.tone] ?? ''}" role="${b.tone === 'error' ? 'alert' : 'status'}">${icon(b.tone === 'info' ? 'info' : 'alert', 'i--sm')}<span class="banner__text">${b.text}</span>${b.action ? html`<button type="button" class="btn" data-action="banner.run" data-id="${id}">${b.action.label}</button>` : ''}</div>`;
  })}`);
}
export const runBanner = (id) => bannerActions.get(id)?.();
