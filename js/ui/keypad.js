// Clavier numérique pour les PIN : gros boutons tactiles + saisie au clavier physique.
import { html } from '../lib/text.js';
import { icon } from './dom.js';

export const keypadHtml = () => html`
  <div class="keypad" role="group" aria-label="Clavier numérique">
    ${['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => html`<button type="button" class="keypad__key" data-key="${d}">${d}</button>`)}
    <button type="button" class="keypad__key keypad__key--fn" data-key="back" aria-label="Effacer le dernier chiffre">${icon('back')}</button>
    <button type="button" class="keypad__key" data-key="0">0</button>
    <button type="button" class="keypad__key keypad__key--fn" data-key="ok">OK</button>
  </div>`;

export const dotsHtml = (n = 4) => html`<div class="pin-dots" role="img" aria-label="Saisie du PIN">${Array.from({ length: n }, () => html`<span class="pin-dot"></span>`)}</div>`;

/**
 * Branche un clavier PIN.
 * @param {HTMLElement} root conteneur du clavier et des points
 * @param {{max?:number, expected?:number, onSubmit:(pin:string)=>void|Promise<void>}} opt
 *   `expected` : longueur connue → validation automatique à la dernière touche.
 */
export function bindKeypad(root, { max = 8, expected = 0, onSubmit }) {
  let pin = '';
  let busy = false;
  const dots = root.querySelector('.pin-dots');
  const shown = () => Math.max(expected || 4, pin.length);

  function paint() {
    if (!dots) return;
    const n = shown();
    while (dots.children.length < n) dots.append(Object.assign(document.createElement('span'), { className: 'pin-dot' }));
    while (dots.children.length > n) dots.lastElementChild.remove();
    [...dots.children].forEach((d, i) => d.classList.toggle('is-on', i < pin.length));
  }
  async function submit() {
    if (busy || pin.length < 4) return;
    busy = true;
    try { await onSubmit(pin); } finally { busy = false; }
  }
  function press(key) {
    if (busy) return;
    if (/^\d$/.test(key)) {
      if (pin.length >= max) return;
      pin += key; paint();
      if (expected && pin.length === expected) submit();
    } else if (key === 'back') { pin = pin.slice(0, -1); paint(); }
    else if (key === 'ok') submit();
  }

  const onClick = (e) => { const k = e.target.closest?.('[data-key]'); if (k && root.contains(k)) press(k.dataset.key); };
  const onKey = (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (/^\d$/.test(e.key)) { press(e.key); e.preventDefault(); }
    else if (e.key === 'Backspace') { press('back'); e.preventDefault(); }
    else if (e.key === 'Enter') { press('ok'); e.preventDefault(); }
  };
  root.addEventListener('click', onClick);
  document.addEventListener('keydown', onKey);
  paint();

  return {
    value: () => pin,
    clear() { pin = ''; paint(); },
    /** Secoue les points et vide la saisie. */
    fail() {
      pin = ''; paint();
      if (dots) { dots.classList.remove('is-error'); void dots.offsetWidth; dots.classList.add('is-error'); }
    },
    destroy() { root.removeEventListener('click', onClick); document.removeEventListener('keydown', onKey); },
  };
}
