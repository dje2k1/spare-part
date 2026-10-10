// Saisie d'un code commune aux écrans de travail (réception, préparation, panier, consultation) :
//   - douchette Bluetooth/USB (rafale de touches terminée par Entrée), partout sur l'écran ;
//   - saisie au clavier (code ou nom, avec suggestions) ;
//   - caméra du téléphone dans une feuille, en lecture continue (bip à chaque code).
import { html } from '../lib/text.js';
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
    <input class="input codebar__input" id="${id}" name="q" type="text" inputmode="search" enterkeyhint="go" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${placeholder}" aria-label="${label}" data-scan-target ${input ? html`data-input="${input}"` : ''}>
    ${camera ? html`<button type="button" class="btn btn--primary btn--icon codebar__cam" data-action="${camera}" aria-label="Scanner avec la caméra">${icon('camera')}</button>` : ''}
  </form>`;
}

// Écart maximal entre deux caractères d'une douchette (les lecteurs envoient en 5 à 30 ms ; certains modèles
// Bluetooth un peu plus). Hors champ ou dans un champ numérique (quantité), 80 ms : personne n'y tape 8 chiffres
// d'affilée. Dans un champ de texte, seuil strict : 8 caractères à moins de 35 ms d'intervalle chacun, puis
// Entrée, ne sont pas humains.
const GAP_LOOSE = 80;
const GAP_TEXT = 35;
const isField = (el) => Boolean(el) && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
const isNumeric = (el) => el.type === 'number' || el.inputMode === 'numeric' || el.inputMode === 'decimal';
const gapFor = (el) => (!isField(el) || isNumeric(el) ? GAP_LOOSE : GAP_TEXT);

/**
 * Douchette (lecteur Bluetooth/USB en mode clavier) : écoute globale tant que l'écran est affiché. Le lecteur
 * envoie ses caractères en rafale puis Entrée.
 *   - focus hors champ : le code est intercepté ;
 *   - focus dans un champ de code (`data-scan-target`, barre de saisie) : rien n'est intercepté, le formulaire
 *     reçoit le code et l'Entrée ;
 *   - focus dans un autre champ de l'écran (quantité…) : la rafale y a été tapée par erreur — le champ retrouve
 *     sa valeur d'avant la rafale et le code est traité comme un scan (plus de quantité « 3700089690011 »).
 * Une fenêtre (confirmation, PIN) ou le menu ouverts ne sont jamais interceptés, ni la saisie dans le formulaire
 * d'une fiche ; une fiche simplement consultée n'empêche pas de scanner.
 * @returns {() => void} pour arrêter l'écoute
 */
export function listenWedge(onCode) {
  let buf = '';
  let at = 0;
  let field = null; // champ qui avait le focus au début de la rafale, et sa valeur d'alors
  let before = '';
  const handler = (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
    if (document.querySelector('#modal[open], #drawer[open]')) return;
    const el = document.activeElement;
    const inField = isField(el);
    // Champ de code, ou formulaire d'une fiche (hors de l'écran principal) : on n'intercepte rien
    if (inField && (el.closest('[data-scan-target]') || !el.closest('#view'))) return;
    // Heure de l'ÉVÉNEMENT (et non du traitement) : si la page est occupée pendant une rafale, les touches attendent
    // puis arrivent groupées — l'écart réel envoyé par le lecteur reste mesuré correctement.
    const now = e.timeStamp || performance.now();
    const gap = gapFor(el);
    if (/^[0-9A-Za-z:-]$/.test(e.key)) {
      if (now - at > gap || field !== (inField ? el : null)) {
        buf = '';
        field = inField ? el : null;
        before = inField ? el.value : '';
      }
      at = now;
      buf += e.key;
      return;
    }
    if (e.key !== 'Enter') return;
    const fast = now - at <= gap * 2;
    if (buf.length >= 8 && fast && field === (inField ? el : null)) {
      const code = buf;
      buf = '';
      e.preventDefault();
      e.stopPropagation();
      if (field) {
        field.value = before;
        field.dispatchEvent(new Event('input', { bubbles: true })); // l'écran se recale sur la valeur restaurée
      }
      field = null;
      touch();
      onCode(code);
    }
    buf = '';
  };
  document.addEventListener('keydown', handler, true);
  return () => document.removeEventListener('keydown', handler, true);
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

