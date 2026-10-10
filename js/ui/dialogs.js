// Fenêtres : feuille (fiches), modale (confirmation, PIN, saisie) et tiroir (menu), toutes basées sur
// <dialog> natif (piège de focus, Échap, arrière-plan inerte gérés par le navigateur).
//
// Historique : l'ouverture d'une feuille ajoute une entrée d'historique ; le bouton « Retour » du
// téléphone la ferme au lieu de quitter l'écran en cours.
import { html } from '../lib/text.js';
import { $, setHtml, icon, actions } from './dom.js';
import { keypadHtml, dotsHtml, bindKeypad } from './keypad.js';

const sheet = () => $('#sheet');
const modal = () => $('#modal');
const drawer = () => $('#drawer');

let sheetPushed = false;
let sheetOnClose = null;
let sheetClosing = [];
let sheetGen = 0; // incrémenté à chaque ouverture : un délai de fermeture ne vise que SA feuille

// ── Feuille ──
/**
 * @param {{title:string, body:import('../lib/text.js').SafeHtml, foot?:import('../lib/text.js').SafeHtml,
 *          mount?:(dlg:HTMLDialogElement)=>void, onClose?:()=>void}} opt
 */
export function openSheet({ title, body, foot, mount, onClose }) {
  const dlg = sheet();
  setHtml(dlg, html`
    <div class="sheet__grab" aria-hidden="true"></div>
    <div class="sheet__head">
      <h2 class="sheet__title" id="sheet-title">${title}</h2>
      <button type="button" class="icon-btn" data-action="sheet.close" aria-label="Fermer">${icon('x')}</button>
    </div>
    <div class="sheet__body">${body}</div>
    ${foot ? html`<div class="sheet__foot">${foot}</div>` : ''}`);
  sheetOnClose = onClose ?? null;
  sheetGen++;
  if (!dlg.open) {
    dlg.showModal();
    history.pushState({ sheet: true }, '');
    sheetPushed = true;
  }
  dlg.querySelector('.sheet__body')?.scrollTo?.(0, 0);
  mount?.(dlg);
}

/** Ferme la feuille ; la promesse se résout une fois réellement fermée (avant de naviguer ailleurs). */
export function closeSheet() {
  const dlg = sheet();
  if (!dlg.open) return Promise.resolve();
  const gen = sheetGen;
  return new Promise((resolve) => {
    sheetClosing.push(resolve);
    if (sheetPushed && history.state?.sheet) history.back(); else dlg.close();
    // Filet de sécurité si l'événement « popstate » n'arrive pas — sans jamais fermer une feuille rouverte entre-temps
    setTimeout(() => { if (dlg.open && gen === sheetGen) dlg.close(); }, 400);
  });
}
export const isSheetOpen = () => sheet().open;

function afterSheetClosed() {
  if (sheetPushed) { sheetPushed = false; if (history.state?.sheet) history.back(); }
  const cb = sheetOnClose; sheetOnClose = null;
  cb?.();
  const waiting = sheetClosing; sheetClosing = [];
  waiting.forEach((r) => r());
}

// ── Tiroir ──
export function openDrawer(body) {
  const dlg = drawer();
  setHtml(dlg, body);
  if (!dlg.open) dlg.showModal();
}
export const closeDrawer = () => { if (drawer().open) drawer().close(); };

/** Ferme tout ce qui est transitoire (changement de route, déconnexion). */
export function closeTransient() {
  closeDrawer();
  if (modal().open) modal().close('cancel');
  if (sheet().open) { sheetPushed = false; sheet().close(); }
}

// ── Modale générique ──
function showModal(content) {
  const dlg = modal();
  setHtml(dlg, content);
  dlg.returnValue = '';
  dlg.showModal();
  return dlg;
}

/** Confirmation. Résout true/false. */
export function confirmDialog({ title, message = '', confirmLabel = 'Confirmer', cancelLabel = 'Annuler', danger = false }) {
  return new Promise((resolve) => {
    const dlg = showModal(html`
      <h2 class="modal__title" id="modal-title">${title}</h2>
      ${message ? html`<p class="modal__text">${message}</p>` : ''}
      <div class="modal__actions">
        <button type="button" class="btn btn--secondary" data-r="no">${cancelLabel}</button>
        <button type="button" class="btn ${danger ? 'btn--danger' : 'btn--primary'}" data-r="yes">${confirmLabel}</button>
      </div>`);
    let result = false;
    dlg.querySelector('[data-r="yes"]').addEventListener('click', () => { result = true; dlg.close(); });
    dlg.querySelector('[data-r="no"]').addEventListener('click', () => dlg.close());
    dlg.addEventListener('close', () => resolve(result), { once: true });
    dlg.querySelector(danger ? '[data-r="no"]' : '[data-r="yes"]').focus();
  });
}

/** Information simple (une seule action). */
export function alertDialog({ title, message, okLabel = 'Compris' }) {
  return new Promise((resolve) => {
    const dlg = showModal(html`
      <h2 class="modal__title" id="modal-title">${title}</h2>
      <p class="modal__text">${message}</p>
      <div class="modal__actions"><button type="button" class="btn btn--primary" data-r="ok">${okLabel}</button></div>`);
    dlg.querySelector('[data-r="ok"]').addEventListener('click', () => dlg.close());
    dlg.addEventListener('close', () => resolve(), { once: true });
  });
}

/**
 * Saisie de PIN. `verify(pin)` renvoie une valeur truthy (succès, retournée par la promesse),
 * `{error:'…'}` ou falsy (échec). Résout null si annulé.
 */
export function pinDialog({ title, message = '', verify, expected = 0 }) {
  return new Promise((resolve) => {
    const dlg = showModal(html`
      <h2 class="modal__title" id="modal-title">${title}</h2>
      ${message ? html`<p class="modal__text modal__text--flush">${message}</p>` : ''}
      <div data-pin>${dotsHtml(expected || 4)}<p class="field__error pin-error center" data-err role="alert" aria-live="assertive"></p>${keypadHtml()}</div>
      <div class="modal__actions"><button type="button" class="btn btn--secondary" data-r="no">Annuler</button></div>`);
    let result = null;
    const root = dlg.querySelector('[data-pin]');
    const err = root.querySelector('[data-err]');
    const pad = bindKeypad(root, {
      expected,
      async onSubmit(pin) {
        const r = await verify(pin);
        if (r && !r.error) { result = r; dlg.close(); return; }
        err.textContent = r?.error || 'PIN incorrect.';
        pad.fail();
      },
    });
    dlg.querySelector('[data-r="no"]').addEventListener('click', () => dlg.close());
    dlg.addEventListener('close', () => { pad.destroy(); resolve(result); }, { once: true });
  });
}

/** Saisie d'une valeur texte. Résout la chaîne saisie, ou null. */
export function promptDialog({ title, label, value = '', type = 'text', hint = '', confirmLabel = 'Enregistrer', validate }) {
  return new Promise((resolve) => {
    const dlg = showModal(html`
      <h2 class="modal__title" id="modal-title">${title}</h2>
      <form data-form novalidate>
        <label class="field"><span class="field__label">${label}</span>
          <input class="input" name="v" type="${type}" value="${value}" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
        ${hint ? html`<p class="field__hint">${hint}</p>` : ''}
        <p class="field__error" data-err role="alert"></p>
        <div class="modal__actions">
          <button type="button" class="btn btn--secondary" data-r="no">Annuler</button>
          <button type="submit" class="btn btn--primary">${confirmLabel}</button>
        </div>
      </form>`);
    let result = null;
    const form = dlg.querySelector('[data-form]');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = form.elements.v.value.trim();
      const problem = validate?.(v);
      if (problem) { dlg.querySelector('[data-err]').textContent = problem; return; }
      result = v; dlg.close();
    });
    dlg.querySelector('[data-r="no"]').addEventListener('click', () => dlg.close());
    dlg.addEventListener('close', () => resolve(result), { once: true });
    form.elements.v.focus();
  });
}

// ── Branchements globaux (une seule fois) ──
export function initDialogs() {
  sheet().addEventListener('close', afterSheetClosed);
  // Clic sur l'arrière-plan = fermeture
  for (const dlg of [sheet(), drawer()]) {
    dlg.addEventListener('click', (e) => { if (e.target === dlg) (dlg === sheet() ? closeSheet() : closeDrawer()); });
  }
  modal().addEventListener('click', (e) => { if (e.target === modal()) modal().close(); });
  // Retour système : ferme la feuille ouverte
  window.addEventListener('popstate', () => {
    if (sheet().open && !history.state?.sheet) { sheetPushed = false; sheet().close(); }
  });
  actions({
    'sheet.close': () => closeSheet(),
    'drawer.close': () => closeDrawer(),
  });
}
