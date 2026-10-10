// Accueil de l'application : première installation (démo / vide / restauration) puis connexion
// en 3 temps — dépôt, profil, PIN — au lieu de saisir nom + dépôt + PIN au clavier.
import { html, initials } from '../../lib/text.js';
import { $, setHtml, icon, actions, val } from '../dom.js';
import { store, lockout, prefs, db } from '../state.js';
import { verifyPin, pinPolicy, upgradeLegacyPins } from '../../core/auth.js';
import { buildDemoDb, buildFreshDb } from '../../core/seed.js';
import { ROLES } from '../../core/config.js';
import { keypadHtml, dotsHtml, bindKeypad } from '../keypad.js';
import { startSession } from '../session.js';
import { toast } from '../toast.js';
import { feedback } from '../feedback.js';

const L = { step: 'depot', depotId: null, userId: null, message: '' };
let pad = null;
let countdown = null;

const stopTimers = () => { pad?.destroy(); pad = null; if (countdown) clearInterval(countdown); countdown = null; };

const logo = html`<div class="login__brand"><h1 class="login__logo">MODE</h1><p class="eyebrow">Atelier — Gestion de stock</p></div>`;

/** Point d'entrée : choisit l'écran selon l'état de la base. */
export function showLogin(message = '') {
  stopTimers();
  $('#boot')?.remove();
  $('#app').hidden = true;
  const root = $('#login');
  root.hidden = false;
  document.body.classList.add('no-tabbar');
  L.message = message;
  if (store.isEmpty) { L.step = 'welcome'; return paint(); }
  const depots = Object.values(db().depots);
  const last = prefs.get('lastDepot');
  L.depotId = db().depots[last] ? last : depots[0].id;
  L.userId = null;
  L.step = depots.length > 1 ? 'depot' : 'user';
  paint();
}

function paint() {
  stopTimers();
  const root = $('#login');
  const views = { welcome, setup, depot: depotStep, user: userStep, pin: pinStep };
  setHtml(root, html`<div class="login__in">${logo}${views[L.step]()}</div>`);
  if (L.step === 'pin') mountPin(root);
  const first = root.querySelector('[data-autofocus]');
  first?.focus({ preventScroll: true });
}

// ── Première installation ──
function welcome() {
  return html`
    <div class="login__panel stack">
      ${store.status.recovered ? html`<div class="card card--gold"><strong>Données illisibles.</strong> Une copie de sauvegarde a été conservée sur cet appareil. Vous pouvez restaurer un fichier de sauvegarde ou démarrer à neuf.</div>` : html`<h2 class="login__h">Bienvenue</h2><p class="muted">Comment souhaitez-vous commencer ?</p>`}
      <button type="button" class="btn btn--primary btn--block" data-action="login.setup" data-autofocus>${icon('plus')}Démarrer mon atelier</button>
      <button type="button" class="btn btn--secondary btn--block" data-action="login.demo">${icon('sparkles')}Explorer avec des données de démonstration</button>
      <label class="btn btn--ghost btn--block" for="restore-file">${icon('upload')}Restaurer une sauvegarde</label>
      <input type="file" id="restore-file" class="sr-only" accept="application/json,.json" data-change="login.restore">
      <p class="login__note">Les données restent sur cet appareil. Pensez à exporter régulièrement une sauvegarde.</p>
    </div>`;
}

function setup() {
  return html`
    <form class="login__panel stack" data-submit="login.create" novalidate>
      <h2 class="login__h">Votre atelier</h2>
      <label class="field"><span class="field__label">Nom du dépôt</span><input class="input" name="depot" required maxlength="60" placeholder="Atelier Paris" autocomplete="off" data-autofocus></label>
      <label class="field"><span class="field__label">Code (facultatif)</span><input class="input" name="code" maxlength="10" placeholder="DEP-01" autocomplete="off" autocapitalize="characters"></label>
      <label class="field"><span class="field__label">Administrateur</span><input class="input" name="admin" required maxlength="60" placeholder="Prénom Nom" autocomplete="off"></label>
      <label class="field"><span class="field__label">PIN (4 à 8 chiffres)</span><input class="input input--mono" name="pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" autocomplete="new-password" required></label>
      <label class="field"><span class="field__label">Confirmer le PIN</span><input class="input input--mono" name="pin2" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" autocomplete="new-password" required></label>
      <p class="field__error" data-err role="alert"></p>
      <button type="submit" class="btn btn--primary btn--block">Créer et continuer</button>
      <button type="button" class="btn btn--ghost btn--block" data-action="login.back">Retour</button>
    </form>`;
}

// ── Connexion ──
function depotStep() {
  const depots = Object.values(db().depots);
  return html`
    <div class="login__panel stack">
      ${L.message ? html`<p class="banner banner--info" role="status">${L.message}</p>` : ''}
      <h2 class="login__h">Où travaillez-vous ?</h2>
      <ul class="login__list">${depots.map((d, i) => html`<li><button type="button" class="login__choice" data-action="login.depot" data-id="${d.id}" ${i === 0 ? 'data-autofocus' : ''}>
        <span class="login__choice-main"><strong>${d.name}</strong><span class="muted">${d.location || d.code}</span></span>${icon('chevron')}</button></li>`)}</ul>
      ${demoHint()}
    </div>`;
}

function usersFor(depotId) {
  return Object.values(db().users).filter((u) => u.depotId === depotId || u.role === 'admin')
    .sort((a, b) => ['admin', 'manager', 'operator'].indexOf(a.role) - ['admin', 'manager', 'operator'].indexOf(b.role) || a.name.localeCompare(b.name, 'fr'));
}

function userStep() {
  const d = db().depots[L.depotId];
  const multi = Object.keys(db().depots).length > 1;
  return html`
    <div class="login__panel stack">
      ${L.message ? html`<p class="banner banner--info" role="status">${L.message}</p>` : ''}
      <h2 class="login__h">Qui êtes-vous ?</h2>
      <p class="muted">${d.name}</p>
      <ul class="login__list">${usersFor(L.depotId).map((u, i) => html`<li><button type="button" class="login__choice" data-action="login.user" data-id="${u.id}" ${i === 0 ? 'data-autofocus' : ''}>
        <span class="avatar">${initials(u.name)}</span>
        <span class="login__choice-main"><strong>${u.name}</strong><span class="muted">${ROLES[u.role].label}</span></span>${icon('chevron')}</button></li>`)}</ul>
      ${multi ? html`<button type="button" class="btn btn--ghost btn--block" data-action="login.back">Changer de dépôt</button>` : ''}
      ${demoHint()}
    </div>`;
}

function pinStep() {
  const u = db().users[L.userId];
  return html`
    <div class="login__panel">
      <div class="login__who"><span class="avatar">${initials(u.name)}</span><div><strong>${u.name}</strong><div class="muted">${db().depots[L.depotId].name}</div></div></div>
      <div data-pin>
        ${dotsHtml(u.pin?.len || 4)}
        <p class="field__error pin-error center" data-err role="alert" aria-live="assertive"></p>
        ${keypadHtml()}
      </div>
      <button type="button" class="btn btn--ghost btn--block login__back" data-action="login.back">Ce n'est pas moi</button>
    </div>`;
}

function demoHint() {
  const pins = db()?.meta.demo ? db().meta.demoPins : null;
  if (!pins?.length) return '';
  return html`<details class="login__demo"><summary>Mode démonstration</summary>
    <p>Comptes d'essai (PIN) :</p><ul>${pins.map((p) => html`<li><span>${p.name}</span><code>${p.pin}</code></li>`)}</ul></details>`;
}

function lockText(ms) {
  const s = Math.ceil(ms / 1000);
  return `Trop d'essais. Réessayez dans ${s >= 60 ? `${Math.ceil(s / 60)} min` : `${s} s`}.`;
}

function mountPin(root) {
  const u = db().users[L.userId];
  const box = root.querySelector('[data-pin]');
  const err = box.querySelector('[data-err]');
  const paintLock = () => {
    const st = lockout.status(u.id);
    err.textContent = st.locked ? lockText(st.remainingMs) : (err.dataset.msg || '');
    if (!st.locked && countdown) { clearInterval(countdown); countdown = null; err.textContent = ''; }
    return st.locked;
  };
  pad = bindKeypad(box, {
    expected: u.pin?.len || 0,
    async onSubmit(pin) {
      if (paintLock()) { pad.fail(); return; }
      if (await verifyPin(u.pin, pin)) {
        lockout.success(u.id);
        const depotId = L.depotId;
        stopTimers();
        feedback('ok');
        startSession(u, depotId);
        return;
      }
      const r = lockout.fail(u.id);
      feedback('error');
      err.dataset.msg = 'PIN incorrect.';
      err.textContent = r.remainingMs ? lockText(r.remainingMs) : 'PIN incorrect.';
      pad.fail();
      if (r.remainingMs && !countdown) countdown = setInterval(paintLock, 1000);
    },
  });
  if (paintLock() && !countdown) countdown = setInterval(paintLock, 1000);
}

async function finishInstall(newDb) {
  await upgradeLegacyPins(newDb);
  store.replace(newDb);
  showLogin();
}

export function initLogin() {
  actions({
    'login.depot': (el) => { L.depotId = el.dataset.id; L.step = 'user'; L.message = ''; paint(); },
    'login.user': (el) => { L.userId = el.dataset.id; L.step = 'pin'; L.message = ''; paint(); },
    'login.back': () => {
      if (L.step === 'pin') L.step = 'user';
      else if (L.step === 'user' && Object.keys(db().depots).length > 1) L.step = 'depot';
      else if (L.step === 'setup') L.step = 'welcome';
      paint();
    },
    'login.setup': () => { L.step = 'setup'; paint(); },
    async 'login.demo'(el) {
      el.disabled = true;
      await finishInstall(await buildDemoDb(new Date()));
      toast('Données de démonstration chargées.', { tone: 'ok' });
    },
    async 'login.create'(form) {
      const err = form.querySelector('[data-err]');
      const fail = (m) => { err.textContent = m; };
      const depotName = val(form, 'depot'), adminName = val(form, 'admin'), pin = val(form, 'pin');
      if (!depotName || !adminName) return fail('Renseignez le nom du dépôt et de l\'administrateur.');
      const policy = pinPolicy(pin);
      if (!policy.ok) return fail(policy.reason);
      if (pin !== val(form, 'pin2')) return fail('Les deux PIN ne correspondent pas.');
      form.querySelector('[type=submit]').disabled = true;
      await finishInstall(await buildFreshDb(new Date(), { adminName, pin, depotName, depotCode: val(form, 'code') }));
      toast('Atelier créé. Connectez-vous.', { tone: 'ok' });
    },
    async 'login.restore'(input) {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const { db: restored } = store.importBackup(await file.text());
        await finishInstall(restored);
        toast('Sauvegarde restaurée.', { tone: 'ok' });
      } catch (e) { toast(e.message, { tone: 'error' }); }
      input.value = '';
    },
  });
}

