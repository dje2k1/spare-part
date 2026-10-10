// Saisie d'un code commune aux écrans de travail (réception, préparation, panier, consultation) :
//   - douchette Bluetooth/USB (rafale de touches terminée par Entrée), partout sur l'écran ;
//   - saisie au clavier (code ou nom, avec suggestions) ;
//   - caméra du téléphone dans une feuille, en lecture continue (bip à chaque code).
import { html } from '../lib/text.js';
import { isCode } from '../lib/ean.js';
import { icon, $ } from './dom.js';
import { openSheet, closeSheet } from './dialogs.js';
import { createScanner, scannerAvailable, cameraErrorMessage } from './scanner.js';
import { touch } from './session.js';

/**
 * Barre de saisie : champ + bouton caméra. `submit` / `input` / `camera` : noms d'actions (data-*).
 */
export function codeBar({ id, placeholder = 'Scanner ou saisir un code', submit, input = '', camera, label = placeholder }) {
  return html`<form class="codebar" data-submit="${submit}" role="search">
    <span class="codebar__icon" aria-hidden="true">${icon('scan')}</span>
    <input class="input codebar__input" id="${id}" name="q" type="text" inputmode="search" enterkeyhint="go" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${placeholder}" aria-label="${label}" ${input ? html`data-input="${input}"` : ''}>
    ${camera ? html`<button type="button" class="btn btn--primary btn--icon codebar__cam" data-action="${camera}" aria-label="Scanner avec la caméra">${icon('camera')}</button>` : ''}
  </form>`;
}

/**
 * Douchette : écoute globale tant que l'écran est affiché. Un lecteur envoie ses caractères en rafale
 * (< 80 ms d'écart) puis Entrée ; une saisie humaine dans un champ n'est pas interceptée.
 * @returns {() => void} pour arrêter l'écoute
 */
export function listenWedge(onCode) {
  let buf = '';
  let at = 0;
  const handler = (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // Un champ a le focus : la douchette y tape et Entrée valide le formulaire (géré par l'écran).
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '')) return;
    if (document.querySelector('#modal[open], #drawer[open]')) return;
    const now = performance.now();
    if (now - at > 80) buf = '';
    at = now;
    if (/^[0-9A-Za-z:-]$/.test(e.key)) buf += e.key;
    else if (e.key === 'Enter' && buf.length >= 8) { const t = buf; buf = ''; e.preventDefault(); touch(); onCode(t); }
  };
  document.addEventListener('keydown', handler);
  return () => document.removeEventListener('keydown', handler);
}

let cam = null;

/**
 * Caméra en feuille, lecture continue. `onCode(code)` peut renvoyer `false` pour fermer la feuille.
 * La caméra est coupée à la fermeture (bouton, geste retour, fin de saisie).
 */
export function openCamera({ title = 'Scanner', hint = 'Visez le code-barres de la pièce', onCode }) {
  openSheet({
    title,
    body: html`<div class="camsheet">
      <div class="scanner" id="camsheet-box" data-state="starting">
        <div id="camsheet-video" class="scanner__video"></div>
        <div class="reticle" aria-hidden="true"><i class="reticle__c reticle__c--tl"></i><i class="reticle__c reticle__c--tr"></i><i class="reticle__c reticle__c--bl"></i><i class="reticle__c reticle__c--br"></i><i class="reticle__line"></i></div>
        <div class="scanner__start" id="camsheet-msg"><span class="spinner" role="status"></span><span class="scanner__hint">Démarrage de la caméra…</span></div>
      </div>
      <p class="muted center" id="camsheet-hint">${hint}</p>
      <p class="camsheet__last" id="camsheet-last" aria-live="polite"></p></div>`,
    foot: html`<button type="button" class="btn btn--secondary btn--block" data-action="sheet.close">Terminer</button>`,
    onClose: () => { cam?.stop(); cam = null; },
    async mount() {
      const box = $('#camsheet-box');
      const msg = $('#camsheet-msg');
      if (!scannerAvailable()) { box.dataset.state = 'error'; msg.textContent = 'Le module de scan n\'a pas pu être chargé. Utilisez la saisie ou une douchette.'; return; }
      cam = createScanner({
        containerId: 'camsheet-video',
        onCode: async (text) => {
          touch();
          const last = $('#camsheet-last');
          if (last) last.textContent = text;
          const keep = await onCode(text);
          if (keep === false) await closeSheet();
        },
      });
      try {
        await cam.start();
        box.dataset.state = 'live';
        msg.hidden = true;
      } catch (e) {
        await cam?.stop();
        cam = null;
        box.dataset.state = 'error';
        msg.textContent = cameraErrorMessage(e);
      }
    },
  });
}

/** Normalise une saisie : code (8-14 chiffres) ou texte libre. */
export const readCode = (text) => {
  const t = String(text ?? '').trim();
  return isCode(t) ? { code: t } : { text: t };
};
