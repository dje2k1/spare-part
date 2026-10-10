// Tiroir « Plus » : écrans secondaires, préférences, PIN, installation, déconnexion.
import { html, initials } from '../lib/text.js';
import { icon, actions, val } from './dom.js';
import { state, db, depot, can, prefs, applyTheme, run, lockout } from './state.js';
import { openDrawer, closeDrawer, openSheet, closeSheet, confirmDialog } from './dialogs.js';
import { navigate } from './router.js';
import { endSession } from './session.js';
import { toast } from './toast.js';
import { pendingIncoming } from '../core/queries.js';
import { ROLES, APP_LABEL, APP_VERSION } from '../core/config.js';
import { hashPin, verifyPin, pinPolicy } from '../core/auth.js';
import { changeOwnPin } from '../core/ops.js';

let installPrompt = null;
export const setInstallPrompt = (e) => { installPrompt = e; };

const THEMES = { auto: ['Thème : automatique', 'sun'], light: ['Thème : clair', 'sun'], dark: ['Thème : sombre', 'moon'] };

function item(to, ic, label, extra = '') {
  return html`<button type="button" class="menu-item" data-action="menu.go" data-to="${to}">${icon(ic)}<span>${label}</span>${extra}</button>`;
}

function menu() {
  const u = state.session.user;
  const pending = pendingIncoming(db(), depot().id).length;
  const theme = prefs.get('theme', 'auto');
  const sound = prefs.get('sound', true);
  return html`
    <div class="drawer__head">
      <span class="avatar">${initials(u.name)}</span>
      <div class="grow"><strong>${u.name}</strong><div class="muted">${ROLES[u.role].label} · ${depot().name}</div></div>
      <button type="button" class="icon-btn" data-action="drawer.close" aria-label="Fermer le menu">${icon('x')}</button>
    </div>
    <div class="drawer__body">
      <p class="menu-group eyebrow">Stock</p>
      ${item('plan', 'map', 'Plan des emplacements')}
      ${item('transfers', 'swap', 'Transferts', pending ? html`<span class="menu-item__badge">${pending}</span>` : '')}
      ${can('inventory') ? item('inventory', 'clipboard', 'Inventaire guidé') : ''}
      ${can('stock.adjust') ? item('reorder', 'cart', 'À réapprovisionner') : ''}
      <p class="menu-group eyebrow">Suivi</p>
      ${item('dashboard', 'chart', 'Tableau de bord')}
      ${item('journal', 'clock', can('audit.view') ? 'Journal & audit' : 'Historique')}
      ${can('article.edit') ? item('photo', 'sparkles', 'Analyser une pièce (photo)') : ''}
      ${can('import') ? html`<p class="menu-group eyebrow">Gestion</p>${item('admin', 'settings', 'Administration')}` : ''}
      <p class="menu-group eyebrow">Cet appareil</p>
      <button type="button" class="menu-item" data-action="menu.theme">${icon(THEMES[theme][1])}<span>${THEMES[theme][0]}</span></button>
      <button type="button" class="menu-item" data-action="menu.sound">${icon('flash')}<span>Son et vibration : ${sound ? 'activés' : 'désactivés'}</span></button>
      <button type="button" class="menu-item" data-action="menu.pin">${icon('key')}<span>Changer mon PIN</span></button>
      ${installPrompt ? html`<button type="button" class="menu-item" data-action="menu.install">${icon('download')}<span>Installer l'application</span></button>` : ''}
    </div>
    <div class="drawer__foot">
      <button type="button" class="btn btn--secondary btn--block" data-action="menu.logout">${icon('logout')}Se déconnecter</button>
      <p class="muted center menu-version">MODE Stock · ${APP_LABEL} (${APP_VERSION})</p>
    </div>`;
}

const repaint = () => openDrawer(menu());

function changePinSheet() {
  openSheet({
    title: 'Changer mon PIN',
    body: html`<form class="stack" data-submit="menu.pin.save" novalidate>
      <label class="field"><span class="field__label">PIN actuel</span><input class="input input--mono" name="old" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" autocomplete="current-password" required></label>
      <label class="field"><span class="field__label">Nouveau PIN (4 à 8 chiffres)</span><input class="input input--mono" name="new" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" autocomplete="new-password" required></label>
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
    'menu.pin': () => { closeDrawer(); changePinSheet(); },
    async 'menu.pin.save'(form) {
      const err = form.querySelector('[data-err]');
      const u = db().users[state.session.user.id];
      const st = lockout.status(u.id);
      if (st.locked) { err.textContent = 'Trop d\'essais : patientez avant de réessayer.'; return; }
      if (!(await verifyPin(u.pin, val(form, 'old')))) { lockout.fail(u.id); err.textContent = 'PIN actuel incorrect.'; return; }
      lockout.success(u.id);
      const policy = pinPolicy(val(form, 'new'));
      if (!policy.ok) { err.textContent = policy.reason; return; }
      if (val(form, 'new') !== val(form, 'new2')) { err.textContent = 'Les deux PIN ne correspondent pas.'; return; }
      const record = await hashPin(val(form, 'new'));
      run(changeOwnPin, record);
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
      if (await confirmDialog({ title: 'Se déconnecter ?', confirmLabel: 'Se déconnecter' })) endSession();
    },
  });
}

