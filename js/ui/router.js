// Routeur à base de hash (#/articles?f=alert) : le bouton « Retour » du navigateur/téléphone fonctionne,
// les écrans sont partageables (liens profonds) et l'état est restauré au rechargement.
import { $, $$, setHtml, whenReleased } from './dom.js';
import { state, can } from './state.js';
import { closeTransient } from './dialogs.js';
import { toast } from './toast.js';
import { enterSection } from './look.js';

/** @type {Record<string, {title:string|((r:object)=>string), nav?:string, back?:boolean, perm?:string, render:(r:object)=>import('../lib/text.js').SafeHtml, mount?:(root:HTMLElement,r:object)=>void, unmount?:()=>void, refresh?:'render'|'none'}>} */
const routes = Object.create(null);
let current = null;
let currentDef = null;

export const defineRoutes = (map) => Object.assign(routes, map);

export function parseHash(hash = location.hash) {
  const m = /^#\/([a-z-]*)(?:\/([^?]*))?(?:\?(.*))?$/.exec(hash);
  return { name: m?.[1] || 'home', rest: (m?.[2] || '').split('/').filter(Boolean).map(decodeURIComponent), params: new URLSearchParams(m?.[3] || '') };
}

export const route = () => current ?? parseHash();

let lastHash = null;
const depth = () => (Number.isInteger(history.state?.i) ? history.state.i : 0);

/** navigate('articles', { params: { f: 'alert' } }) ou navigate('scan/out'). */
export function navigate(path, { params, replace = false } = {}) {
  const search = params ? new URLSearchParams(params).toString() : '';
  const qs = search ? `?${search}` : '';
  const hash = `#/${path}${qs}`;
  if (location.hash === hash) { render({ keepScroll: true }); return; }
  if (replace) history.replaceState({ i: depth() }, '', hash);
  else history.pushState({ i: depth() + 1 }, '', hash); // profondeur d'écran : permet un « Retour » fiable
  render();
}

function paintChrome(def, r) {
  const title = typeof def.title === 'function' ? def.title(r) : def.title;
  const top = $('#topbar-title');
  if (def.brand) { top.textContent = 'MODE'; top.className = 'topbar__title topbar__brand'; }
  else { top.textContent = title; top.className = 'topbar__title'; }
  document.title = def.brand ? 'MODE — Gestion de Stock' : `${title} · MODE Stock`;
  $('#btn-back').hidden = !def.back;
  $$('[data-nav]').forEach((a) => (a.dataset.nav === (def.nav ?? r.name) ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
}

let rendering = false;
let again = false;
const refreshLater = () => render({ keepScroll: true });

/** Rend la route courante. `keepScroll` : mise à jour sur place (données modifiées). */
export function render({ keepScroll = false } = {}) {
  if (!state.session) return;
  // Un rendu déclenché PENDANT un rendu (changement de champ au moment du remplacement) est rejoué après
  if (rendering) { again = true; return; }
  try {
    rendering = true;
    renderNow({ keepScroll });
  } finally {
    rendering = false;
  }
  if (again) { again = false; whenReleased(refreshLater); }
}

function renderNow({ keepScroll }) {
  lastHash = location.hash;
  const r = parseHash();
  let def = routes[r.name];
  if (!def) { navigate('home', { replace: true }); return; }
  if (def.perm && !can(def.perm)) { toast('Accès réservé à un rôle supérieur.', { tone: 'error' }); navigate('home', { replace: true }); return; }
  const sameRoute = current && current.name === r.name && currentDef === def;
  if (sameRoute && keepScroll && def.refresh === 'none') { current = r; return; }
  if (!sameRoute || !keepScroll) { currentDef?.unmount?.(); if (!sameRoute) closeTransient(); }
  current = r; currentDef = def;
  enterSection(r.name, r.rest);
  paintChrome(def, r);
  const root = $('#view');
  const y = window.scrollY;
  const arriving = !(keepScroll && sameRoute);
  if (arriving) markEntering(root);
  setHtml(root, def.render(r));
  def.mount?.(root, r);
  document.body.classList.toggle('no-tabbar', def.nav === null);
  if (keepScroll && sameRoute) window.scrollTo(0, y);
  else { window.scrollTo(0, 0); root.focus({ preventScroll: true }); }
  $('.topbar')?.classList.toggle('has-hero', Boolean(root.querySelector('.page-head, .hero')));
  syncTopbar();
}

// Animations d'arrivée : uniquement en entrant sur un écran (pas lors d'une mise à jour des données).
let enterTimer = null;
function markEntering(root) {
  clearTimeout(enterTimer);
  root.classList.remove('is-entering');
  void root.offsetWidth; // relance l'animation même si la classe était déjà là
  root.classList.add('is-entering');
  enterTimer = setTimeout(() => root.classList.remove('is-entering'), 950);
}

// Barre du haut : ombre au défilement ; titre affiché une fois l'en-tête coloré de la page dépassé.
let ticking = false;
function syncTopbar() {
  ticking = false;
  const bar = $('.topbar');
  if (!bar) return;
  const hero = $('#view')?.querySelector('.page-head, .hero');
  const limit = bar.getBoundingClientRect().bottom + 4;
  bar.classList.toggle('is-scrolled', hero ? hero.getBoundingClientRect().bottom < limit + 24 : window.scrollY > 4);
}
if (typeof window !== 'undefined') {
  window.addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(syncTopbar); } }, { passive: true });
}

/** Mise à jour sur place après une modification des données (différée si un geste est en cours). */
export const refresh = () => whenReleased(refreshLater);

/** Met à jour l'URL sans re-rendre l'écran (ex. changement de mode dans le scan). */
export function replaceHash(path) {
  history.replaceState(history.state, '', `#/${path}`);
  lastHash = location.hash;
  if (current) current = parseHash();
}

/** Retour d'un écran ; à défaut d'historique interne, retour à l'accueil. */
export function back() {
  if (depth() > 0) history.back(); else navigate('home', { replace: true });
}

export function startRouter() {
  const sync = () => { if (location.hash !== lastHash) render(); };
  if (!startRouter.bound) {
    window.addEventListener('hashchange', sync);
    window.addEventListener('popstate', sync);
    startRouter.bound = true;
  }
  render();
}

export function stopRouter() {
  currentDef?.unmount?.();
  current = null; currentDef = null;
}

