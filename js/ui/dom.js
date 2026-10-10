// Aides DOM : sélection, injection HTML sûre, icônes, délégation d'événements.
// Aucun gestionnaire en ligne (onclick=…) : tout passe par `data-action` / `data-input` / `data-change`
// / `data-submit` / `data-enter`, ce qui permet une CSP sans 'unsafe-inline' pour les scripts.
import { SafeHtml, raw, html } from '../lib/text.js';
import { toast } from './toast.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/**
 * Injecte du HTML — uniquement un `SafeHtml` (résultat de html``/raw()), jamais une chaîne brute.
 * Le champ actif est d'abord quitté (blur) : son éventuel « change » part AVANT la suppression du nœud,
 * jamais pendant (ce qui provoquerait un rendu imbriqué et une erreur DOM).
 */
export function setHtml(el, safe) {
  if (!(safe instanceof SafeHtml)) throw new TypeError('setHtml : un SafeHtml est requis (utilisez html``)');
  const active = document.activeElement;
  if (active && active !== el && el.contains(active) && typeof active.blur === 'function') active.blur();
  el.innerHTML = safe.value;
  return el;
}

// ── Jamais de nouveau rendu sous le doigt ──
// Modifier une quantité puis toucher aussitôt « Valider » : le « change » du champ arrive entre l'appui et
// le relâchement ; redessiner à ce moment ferait disparaître le bouton visé et perdre le geste.
let pressed = false;
const queued = new Set();
function release() {
  pressed = false;
  setTimeout(() => { const fns = [...queued]; queued.clear(); fns.forEach((fn) => fn()); }, 0);
}
if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', () => { pressed = true; }, { capture: true, passive: true });
  for (const ev of ['pointerup', 'pointercancel']) document.addEventListener(ev, () => { if (pressed) setTimeout(release, 0); }, { capture: true, passive: true });
}
/** Exécute `fn` maintenant, ou juste après le geste en cours (une seule fois par fonction). */
export function whenReleased(fn) {
  if (pressed) queued.add(fn); else fn();
}

/** Icône du sprite : icon('scan'), icon('x', 'i--sm'). */
export const icon = (name, cls = '') => raw(`<svg class="i${cls ? ` ${cls}` : ''}" aria-hidden="true" focusable="false"><use href="#i-${name}"/></svg>`);

// ── Délégation ──
const handlers = Object.create(null);

/** Enregistre des actions : actions({ 'scan.submit': (el, event) => … }). */
export function actions(map) {
  for (const [name, fn] of Object.entries(map)) {
    if (handlers[name]) throw new Error(`Action déjà définie : ${name}`);
    handlers[name] = fn;
  }
}

/** Point de passage unique des erreurs d'actions : validation → message ; imprévu → message générique. */
export function reportError(err) {
  if (err?.isOpError) { toast(err.message, { tone: 'error' }); return; }
  console.error(err);
  (window.__errors ??= []).push(String(err?.stack || err));
  toast('Une erreur inattendue est survenue. L\'opération a été annulée.', { tone: 'error' });
}

async function dispatch(name, el, event) {
  const fn = handlers[name];
  if (!fn) { console.warn(`Action inconnue : ${name}`); return; }
  try { await fn(el, event); } catch (err) { reportError(err); }
}

export function initDelegation(root = document) {
  root.addEventListener('click', (e) => {
    const el = e.target instanceof Element ? e.target.closest('[data-action]') : null;
    if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') return;
    dispatch(el.dataset.action, el, e);
  });
  root.addEventListener('input', (e) => {
    const el = e.target instanceof Element ? e.target.closest('[data-input]') : null;
    if (el) dispatch(el.dataset.input, el, e);
  });
  root.addEventListener('change', (e) => {
    const el = e.target instanceof Element ? e.target.closest('[data-change]') : null;
    if (el) dispatch(el.dataset.change, el, e);
  });
  root.addEventListener('submit', (e) => {
    const form = e.target instanceof Element ? e.target.closest('form[data-submit]') : null;
    if (form) { e.preventDefault(); dispatch(form.dataset.submit, form, e); }
  });
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    const el = e.target instanceof Element ? e.target.closest('[data-enter]') : null;
    if (el) { e.preventDefault(); dispatch(el.dataset.enter, el, e); }
  });
}

/**
 * Variables CSS pour un attribut style (positions d'étiquettes, barres de graphique). Seules des
 * variables `--nom` à valeur NUMÉRIQUE sont produites : aucune mise en forme arbitraire en ligne.
 */
export function cssVars(vars, unit = '') {
  return Object.entries(vars).filter(([k, v]) => /^[a-z]{1,12}$/.test(k) && Number.isFinite(v)).map(([k, v]) => `--${k}:${Math.round(v * 1000) / 1000}${unit}`).join(';');
}

/** Valeur d'un champ du formulaire `root` par son attribut name. */
export const field = (root, name) => root.querySelector(`[name="${name}"]`);
export const val = (root, name) => (field(root, name)?.value ?? '').trim();

/** Télécharge un texte (CSV, JSON) sous forme de fichier. */
export function download(filename, text, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export { html, raw };
