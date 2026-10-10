// Point d'entrée : démarrage, branchements globaux (stockage multi-onglets, réseau, erreurs, PWA).
import { applyTheme, store, state, db, syncEngine } from './ui/state.js';
import { initDelegation, actions, $ } from './ui/dom.js';
import { initDialogs } from './ui/dialogs.js';
import { defineRoutes, back, refresh } from './ui/router.js';
import { initLogin, showLogin } from './ui/views/login.js';
import { setLogoutHandler, setBanner, clearBanner, runBanner, updateChrome, endSession } from './ui/session.js';
import { initMenu, setInstallPrompt } from './ui/menu.js';
import { initBriefing } from './ui/briefing.js';
import { detectServer, initServerMode, initSyncUi } from './ui/sync-ui.js';
import { routes, initViews } from './ui/routes.js';
import { upgradeLegacyPins } from './core/auth.js';
import { KEYS } from './core/config.js';
import { toast } from './ui/toast.js';

window.__errors = [];

/**
 * Modifications venues d'autres appareils : écran mis à jour au plus une fois par seconde, et jamais pendant
 * une saisie (champ actif) — le texte en cours de frappe n'est pas effacé par un rafraîchissement.
 */
let remoteTimer = null;
function remoteRefresh() {
  if (remoteTimer) return;
  remoteTimer = setTimeout(() => {
    remoteTimer = null;
    if (!state.session) return;
    const a = document.activeElement;
    if (a && a.closest?.('#view') && a.matches('input, textarea, select')) {
      a.addEventListener('blur', () => setTimeout(remoteRefresh, 50), { once: true });
      return;
    }
    refresh();
  }, 1000);
}

function wireStore() {
  store.subscribe((event, detail) => {
    if (event === 'save-error') {
      setBanner('save', { tone: 'error', text: 'Sauvegarde impossible : le stockage de l\'appareil est plein ou bloqué. Exportez vos données dès que possible.', action: { label: 'Exporter', run: () => location.assign('#/admin?s=data') } });
    } else if (event === 'saved') clearBanner('save');
    else if (event === 'trimmed') toast('Stockage presque plein : les plus anciens journaux ont été élagués.', { tone: 'error', ms: 7000 });
    if (!state.session) return;
    if (event === 'changed' || event === 'reloaded' || event === 'replaced') {
      if (!revalidateSession()) return;
      updateChrome();
      if (detail?.remote || detail?.reset) remoteRefresh(); else refresh();
    }
  });
}

/** Après un rechargement venant d'un autre onglet : le compte existe-t-il toujours, avec quel rôle ? */
function revalidateSession() {
  const s = state.session;
  const u = db().users[s.user.id];
  if (!u) { endSession('Votre compte n\'existe plus.'); return false; }
  s.user = { id: u.id, name: u.name, role: u.role, depotId: u.depotId };
  if (!db().depots[s.depotId] || (u.role !== 'admin' && s.depotId !== u.depotId)) s.depotId = u.depotId;
  return true;
}

function wireGlobal() {
  // Un autre onglet a écrit : on recharge (évite que le dernier écrivain écrase silencieusement).
  window.addEventListener('storage', (e) => { if (e.key === KEYS.db && e.newValue && state.session && !state.serverMode) store.reload(); });
  const net = () => { state.online = navigator.onLine; if (state.session) updateChrome(); };
  window.addEventListener('online', net);
  window.addEventListener('offline', net);
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); setInstallPrompt(e); });
  window.addEventListener('error', (e) => { window.__errors.push(String(e.message)); });
  window.addEventListener('unhandledrejection', (e) => {
    window.__errors.push(String(e.reason?.stack || e.reason));
    if (state.session) toast('Une erreur inattendue est survenue.', { tone: 'error' });
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => applyTheme());
}

async function registerWorker() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  try {
    const reg = await navigator.serviceWorker.register('sw.js', { scope: './' });
    const offer = (worker) => setBanner('update', {
      tone: 'info', text: 'Une nouvelle version de l\'application est disponible.',
      action: { label: 'Mettre à jour', run: () => worker.postMessage('skipWaiting') },
    });
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w); });
    });
    // Rechargement seulement lors d'une MISE À JOUR : la toute première installation prend le contrôle sans interrompre l'utilisateur.
    let reloading = false;
    const hadController = Boolean(navigator.serviceWorker.controller);
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && !reloading) { reloading = true; location.reload(); } });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
  } catch (err) {
    console.warn('Service worker non enregistré :', err);
  }
}

async function boot() {
  applyTheme();
  initDelegation();
  initDialogs();
  initLogin();
  initMenu();
  initBriefing();
  initSyncUi();
  initViews();
  actions({
    'nav.back': () => back(),
    'banner.run': (el) => runBanner(el.dataset.id),
    'sync.status': () => syncEngine()?.openStatus(),
  });
  defineRoutes(routes);
  setLogoutHandler((message, opts) => showLogin(message, opts));
  wireStore();
  wireGlobal();

  store.cleanObsolete();
  // Servie par le serveur de synchronisation → données partagées entre appareils ; sinon : autonome (données locales)
  const server = await detectServer();
  if (server) await initServerMode(server);
  else {
    store.load();
    if (store.db && (await upgradeLegacyPins(store.db)) > 0) store.save(); // PIN en clair (ancienne version) → hachés
  }
  showLogin();
  registerWorker();
  $('#boot')?.remove();
}

boot().catch((err) => {
  console.error(err);
  window.__errors.push(String(err?.stack || err));
  const boot = $('#boot');
  if (boot) boot.textContent = 'Erreur au démarrage. Rechargez la page.';
});
