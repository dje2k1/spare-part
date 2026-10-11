// Menu « Plus » : toutes les fonctions avancées, regroupées par usage et filtrées par rôle et par type de
// dépôt. L'accueil reste réservé aux gestes quotidiens.
import { html } from '../lib/text.js';
import { icon, actions, val } from './dom.js';
import { state, db, depot, can, prefs, applyTheme, run, lockout, syncEngine } from './state.js';
import { openDrawer, closeDrawer, openSheet, closeSheet, confirmDialog } from './dialogs.js';
import { navigate } from './router.js';
import { endSession } from './session.js';
import { serverChangePin } from './sync-ui.js';
import { toast } from './toast.js';
import { pendingIncoming } from '../core/queries.js';
import { ROLES, APP_LABEL, APP_VERSION } from '../core/config.js';
import { hashPin, verifyPin, pinPolicy } from '../core/auth.js';
import { changeOwnPin } from '../core/ops.js';
import { printerSheet, printerLabel } from './views/labels.js';
import { avatar } from './components.js';
import { familyOf } from './look.js';

let installPrompt = null;
export const setInstallPrompt = (e) => { installPrompt = e; };

const THEMES = { auto: ['Thème : automatique', 'sun'], light: ['Thème : clair', 'sun'], dark: ['Thème : sombre', 'moon'] };

function item(to, ic, label, extra = '') {
  return html`<button type="button" class="menu-item fam-${familyOf(to.split('?')[0])}" data-action="menu.go" data-to="${to}">${icon(ic)}<span>${label}</span>${extra}</button>`;
}
const group = (title, items) => {
  const list = items.filter(Boolean);
  return list.length ? html`<p class="menu-group eyebrow">${title}</p>${list}` : '';
};

function menu() {
  const u = state.session.user;
  const d = depot();
  const central = d.kind === 'central';
  const pending = pendingIncoming(db(), d.id).length;
  const theme = prefs.get('theme', 'auto');
  const sound = prefs.get('sound', true);
  const sync = syncEngine()?.status();
  return html`
    <div class="drawer__head">
      ${avatar(u.name)}
      <div class="grow"><strong>${u.name}</strong><div class="muted">${ROLES[u.role].label} · ${d.name}</div></div>
      <button type="button" class="icon-btn" data-action="drawer.close" aria-label="Fermer le menu">${icon('x')}</button>
    </div>
    <div class="drawer__body">
      ${group('Stock', [
        item('articles', 'box', 'Articles et stock'),
        item('transfers', 'swap', 'Transferts entre dépôts', pending ? html`<span class="menu-item__badge">${pending}</span>` : ''),
        item('plan', 'map', 'Plan des emplacements'),
        can('inventory') && item('inventory', 'clipboard', 'Inventaire guidé'),
        can('labels') && item('labels', 'tag', 'Étiquettes'),
      ])}
      ${group('Approvisionnement', [
        central && can('purchase.manage') && item('purchases', 'cart', 'Commandes fournisseurs'),
        central && can('supplier.manage') && item('suppliers', 'store', 'Fournisseurs'),
        !central && can('order.request') && item('order', 'cart', 'Panier de commande'),
        item('orders', 'truck', central ? 'Commandes des ateliers' : 'Mes commandes'),
        can('levels.manage') && item('levels', 'sliders', 'Seuils intelligents'),
        can('stock.adjust') && item('reorder', 'list', 'À réapprovisionner'),
      ])}
      ${group('Pilotage', [
        can('reports') && item('reports', 'file', 'Rapport hebdomadaire'),
        item('dashboard', 'chart', 'Tableau de bord'),
        item('journal', 'clock', can('audit.view') ? 'Journal & audit' : 'Historique'),
        can('article.edit') && item('photo', 'sparkles', 'Analyser une pièce (photo)'),
      ])}
      ${can('import') ? group('Gestion', [item('admin', 'settings', 'Administration')]) : ''}
      <p class="menu-group eyebrow">Cet appareil</p>
      <button type="button" class="menu-item fam-teal" data-action="menu.printer">${icon('printer')}<span>Imprimante : ${printerLabel()}</span></button>
      <button type="button" class="menu-item fam-violet" data-action="menu.theme">${icon(THEMES[theme][1])}<span>${THEMES[theme][0]}</span></button>
      <button type="button" class="menu-item fam-amber" data-action="menu.sound">${icon('flash')}<span>Son et vibration : ${sound ? 'activés' : 'désactivés'}</span></button>
      <button type="button" class="menu-item fam-slate" data-action="menu.pin">${icon('key')}<span>Changer mon PIN</span></button>
      ${installPrompt ? html`<button type="button" class="menu-item fam-brand" data-action="menu.install">${icon('download')}<span>Installer l'application</span></button>` : ''}
    </div>
    <div class="drawer__foot">
      ${sync ? html`<button type="button" class="sync-line sync-line--${sync.tone}" data-action="sync.status">${icon(sync.tone === 'ok' ? 'cloud' : 'cloud-off', 'i--sm')}<span>${sync.text}</span></button>` : ''}
      <button type="button" class="btn btn--secondary btn--block" data-action="menu.logout">${icon('logout')}Se déconnecter</button>
      <p class="muted center menu-version">MODE Stock · ${APP_LABEL} (${APP_VERSION})${state.serverMode ? ' · synchronisé' : ' · données locales'}</p>
    </div>`;
}

const repaint = () => openDrawer(menu());

function changePinSheet() {
  openSheet({
    title: 'Changer mon PIN',
    body: html`<form class="stack" data-submit="menu.pin.save" novalidate>
      <label class="field"><span class="field__label">PIN actuel</span><input class="input input--mono" name="old" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" autocomplete="current-password" required></label>
      <label class="field"><span class="field__label">Nouveau PIN (${state.session?.user.role === 'admin' ? '6' : '4'} à 8 chiffres)</span><input class="input input--mono" name="new" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" autocomplete="new-password" required></label>
      <label class="field"><span class="field__label">Confirmer le nouveau PIN</span><input class="input input--mono" name="new2" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" autocomplete="new-password" required></label>
      <p class="field__error" data-err role="alert"></p>
      <button type="submit" class="btn btn--primary btn--block">Enregistrer</button></form>`,
  });
}

export function initMenu() {
  actions({
    'menu.open': () => repaint(),
    async 'menu.go'(el) { closeDrawer(); navigate(el.dataset.to); },
    'menu.theme': () => {
      const order = ['auto', 'light', 'dark'];
      const next = order[(order.indexOf(prefs.get('theme', 'auto')) + 1) % 3];
      prefs.set('theme', next); applyTheme(next); repaint();
    },
    'menu.sound': () => { prefs.set('sound', !prefs.get('sound', true)); repaint(); },
    'menu.printer': () => { closeDrawer(); printerSheet(); },
    'menu.pin': () => { closeDrawer(); changePinSheet(); },
    async 'menu.pin.save'(form) {
      const err = form.querySelector('[data-err]');
      const u = db().users[state.session.user.id];
      const policy = pinPolicy(val(form, 'new'), { role: state.session.user.role });
      if (!policy.ok) { err.textContent = policy.reason; return; }
      if (val(form, 'new') !== val(form, 'new2')) { err.textContent = 'Les deux PIN ne correspondent pas.'; return; }
      if (state.serverMode) {
        // Le serveur vérifie le PIN actuel et calcule l'empreinte : une session laissée ouverte ne suffit pas
        const r = await serverChangePin(val(form, 'old'), val(form, 'new'));
        if (!r.ok) { err.textContent = r.error; return; }
      } else {
        const st = lockout.status(u.id);
        if (st.locked) { err.textContent = 'Trop d\'essais : patientez avant de réessayer.'; return; }
        if (!(await verifyPin(u.pin, val(form, 'old')))) { lockout.fail(u.id); err.textContent = 'PIN actuel incorrect.'; return; }
        lockout.success(u.id);
        run(changeOwnPin, { pin: await hashPin(val(form, 'new')) });
      }
      await closeSheet();
      toast('PIN modifié.', { tone: 'ok' });
    },
    async 'menu.install'() {
      if (!installPrompt) return;
      installPrompt.prompt();
      const { outcome } = await installPrompt.userChoice;
      installPrompt = null;
      closeDrawer();
      if (outcome === 'accepted') toast('Application installée.', { tone: 'ok' });
    },
    async 'menu.logout'() {
      closeDrawer();
      if (await confirmDialog({ title: 'Se déconnecter ?', confirmLabel: 'Se déconnecter' })) endSession('', { forget: true });
    },
  });
}
