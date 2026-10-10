// Analyse d'une pièce par photo : l'IA suggère les pièces détachées probables, à importer au catalogue.
import { html } from '../../lib/text.js';
import { shrink } from '../../lib/image.js';
import { icon, actions, $, setHtml, val } from '../dom.js';
import { can, run, storage, state } from '../state.js';
import { importSuggestedParts } from '../../core/ops.js';
import { analyzePhoto, readApiKey, saveApiKey, clearApiKey, AiError, AI } from '../../core/ai.js';
import { pageHead } from '../components.js';
import { navigate } from '../router.js';
import { confirmDialog } from '../dialogs.js';
import { toast } from '../toast.js';

const P = { phase: 'idle', photo: null, result: null, selected: new Set(), error: '', abort: null };
const PRIORITY = { high: ['pill--zero', 'Essentiel'], medium: ['pill--low', 'Courant'], low: ['', 'Optionnel'] };

const render = () => html`<section>
  ${pageHead({ eyebrow: 'Reconnaissance produit', title: 'Analyser une pièce', sub: 'Photographiez un article pour obtenir la liste de ses pièces détachées probables.' })}
  <div id="photo-body" class="pad stack"></div></section>`;

function keyBox() {
  return html`<form class="card card--gold stack" data-submit="photo.key.save" novalidate>
    <h3 class="card__title">${icon('key', 'i--sm')} Clé API Anthropic requise</h3>
    <p class="muted">L'analyse utilise l'API Claude avec <strong>votre propre clé</strong>. Elle est enregistrée uniquement sur cet appareil et envoyée uniquement à api.anthropic.com.
      Créez une clé dédiée (console.anthropic.com), idéalement avec une limite de dépense, et supprimez-la d'ici si l'appareil est partagé.</p>
    <label class="field"><span class="field__label">Clé API</span><input class="input input--mono" name="key" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="sk-ant-…" required></label>
    <p class="field__error" data-err role="alert"></p>
    <button type="submit" class="btn btn--primary btn--block">Enregistrer la clé</button></form>`;
}

function body() {
  const hasKey = Boolean(readApiKey(storage));
  if (!hasKey && P.phase !== 'loading') return html`${P.phase === 'error' ? html`<div class="banner banner--error" role="alert">${icon('alert', 'i--sm')}<span class="banner__text">${P.error}</span></div>` : ''}${keyBox()}`;
  switch (P.phase) {
    case 'loading':
      return html`<div class="empty"><span class="spinner" role="status"></span><p class="empty__title">Analyse en cours…</p><p>Identification du produit puis liste des pièces.</p>
        <button type="button" class="btn btn--ghost btn--sm" data-action="photo.cancel">Annuler</button></div>`;
    case 'preview':
      return html`<img class="photo-big" src="${P.photo.dataUrl}" alt="Photo à analyser">
        <button type="button" class="btn btn--primary btn--block" data-action="photo.analyze">${icon('sparkles')}Analyser le produit</button>
        <label class="btn btn--secondary btn--block" for="photo-file">${icon('camera')}Reprendre une photo</label>${fileInput()}`;
    case 'error':
      return html`<div class="banner banner--error" role="alert">${icon('alert', 'i--sm')}<span class="banner__text">${P.error}</span></div>
        <button type="button" class="btn btn--primary btn--block" data-action="photo.analyze">Réessayer</button>
        <label class="btn btn--secondary btn--block" for="photo-file">Choisir une autre photo</label>${fileInput()}`;
    case 'result': return resultView();
    default:
      return html`<label class="photo-drop" for="photo-file">${icon('camera', 'i--xl')}<span class="photo-drop__title">Prendre ou choisir une photo</span><span class="muted">Le produit entier, bien éclairé</span></label>${fileInput()}`;
  }
}

const fileInput = () => html`<input type="file" id="photo-file" class="sr-only" accept="image/*" data-change="photo.file">`;

function resultView() {
  const { product, parts } = P.result;
  return html`
    <div class="card"><p class="eyebrow">Produit identifié${product.category ? ` · ${product.category}` : ''}</p><h3 class="card__title">${product.name}</h3>
      <p class="muted">${product.description}${product.confidence === 'low' ? ' ⚠ Identification incertaine.' : ''}</p></div>
    ${parts.length ? html`<h3 class="eyebrow">Pièces détachées suggérées</h3>
      <ul class="list">${parts.map((p) => html`<li><label class="row row--check"><input type="checkbox" data-change="photo.toggle" data-id="${p.id}" ${P.selected.has(p.id) ? 'checked' : ''}>
        <span class="row__body"><span class="row__eyebrow">${p.family || '—'}</span><span class="row__title">${p.name} ${PRIORITY[p.priority][1] ? html`<span class="pill ${PRIORITY[p.priority][0]}">${PRIORITY[p.priority][1]}</span>` : ''}</span><span class="row__meta">${p.description}</span></span>
        <span class="row__trail"><span class="row__sub">Seuil</span><span class="row__qty">${p.typical_threshold}</span></span></label></li>`)}</ul>
      <p class="muted">Les pièces importées reçoivent un code interne (aucun code-barres n'est inventé) et un stock à 0.</p>
      ${can('article.edit') ? html`<button type="button" class="btn btn--primary btn--block" data-action="photo.import" ${P.selected.size ? '' : 'disabled'}>${icon('plus')}Importer ${P.selected.size} pièce${P.selected.size > 1 ? 's' : ''}</button>` : ''}`
      : html`<div class="empty"><p class="empty__title">Aucune pièce identifiée</p></div>`}
    <button type="button" class="btn btn--secondary btn--block" data-action="photo.reset">Analyser un autre produit</button>`;
}

function paint() {
  const host = $('#photo-body');
  if (!host) return;
  setHtml(host, html`${body()}${readApiKey(storage) ? html`<p class="center"><button type="button" class="btn btn--text" data-action="photo.key.remove">Supprimer ma clé API de cet appareil</button></p><p class="muted center photo-model">Modèle : ${AI.model}</p>` : ''}`);
}

export const photoRoute = { title: 'Analyser une pièce', back: true, perm: 'article.edit', refresh: 'none', render, mount: paint, unmount: () => { P.abort?.abort(); P.phase = 'idle'; P.photo = null; P.result = null; P.selected = new Set(); } };

export function initPhoto() {
  actions({
    'photo.key.save'(form) {
      try { saveApiKey(storage, val(form, 'key')); P.phase = P.photo ? 'preview' : 'idle'; P.error = ''; toast('Clé enregistrée.', { tone: 'ok' }); paint(); } catch (e) { if (e instanceof AiError) form.querySelector('[data-err]').textContent = e.message; else throw e; }
    },
    async 'photo.key.remove'() {
      if (!(await confirmDialog({ title: 'Supprimer la clé API ?', message: 'Vous devrez la saisir à nouveau pour analyser une photo.', confirmLabel: 'Supprimer', danger: true }))) return;
      clearApiKey(storage); P.phase = 'idle'; paint(); toast('Clé supprimée de cet appareil.');
    },
    async 'photo.file'(input) {
      const f = input.files?.[0];
      if (!f) return;
      try { P.photo = await shrink(f, { max: 1024, quality: 0.8 }); P.phase = 'preview'; } catch { P.error = 'Image illisible.'; P.phase = 'error'; }
      input.value = ''; paint();
    },
    async 'photo.analyze'() {
      P.phase = 'loading'; P.abort = new AbortController(); paint();
      try {
        P.result = await analyzePhoto({ apiKey: readApiKey(storage), base64: P.photo.base64, mime: 'image/jpeg', signal: P.abort.signal });
        P.selected = new Set(P.result.parts.filter((p) => p.priority === 'high').map((p) => p.id));
        P.phase = 'result';
      } catch (e) {
        if (!(e instanceof AiError)) throw e;
        if (e.clearKey) clearApiKey(storage);
        if (e.code === 'abort') { P.phase = 'preview'; paint(); return; }
        P.error = state.online ? e.message : 'Vous êtes hors ligne : l\'analyse nécessite une connexion.';
        P.phase = 'error';
      }
      paint();
    },
    'photo.cancel': () => P.abort?.abort(),
    'photo.toggle'(el) { if (el.checked) P.selected.add(el.dataset.id); else P.selected.delete(el.dataset.id); paint(); },
    'photo.reset': () => { P.phase = 'idle'; P.photo = null; P.result = null; paint(); },
    'photo.import'() {
      const parts = P.result.parts.filter((p) => P.selected.has(p.id));
      const eans = run(importSuggestedParts, parts);
      toast(`${eans.length} pièce(s) ajoutée(s) au catalogue.`, { tone: 'ok' });
      navigate('articles');
    },
  });
}
