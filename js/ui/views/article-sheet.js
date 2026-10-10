// Fiche article unifiée (remplace l'ancienne fiche catalogue, la fiche stock et la fiche historique) :
// onglets Stock · Fiche · Emplacements · Historique. S'ouvre depuis la liste, le plan, le scan, le réassort…
import { html, fmtInt, fmtEur } from '../../lib/text.js';
import { nextInternalEan } from '../../lib/ean.js';
import { shrink, isImageDataUrl } from '../../lib/image.js';
import { icon, actions, $, val } from '../dom.js';
import { db, depot, can, run } from '../state.js';
import { upsertArticle, deleteArticle, adjustStock, setArticleLocation, removeArticleLocation } from '../../core/ops.js';
import { stockOf, articleLocations, locCode, families, depotLocationCodes, statusOf, movements } from '../../core/queries.js';
import { thumb, statusPill, movementRow, locBadge, segmented, emptyState } from '../components.js';
import { openSheet, closeSheet, confirmDialog } from '../dialogs.js';
import { navigate } from '../router.js';
import { printLabels } from '../print.js';
import { toast } from '../toast.js';

const SH = { ean: null, tab: 'stock', photo: undefined, isNew: false, draftEan: '' };

const TABS = [{ value: 'stock', label: 'Stock' }, { value: 'form', label: 'Fiche' }, { value: 'locs', label: 'Rangement' }, { value: 'history', label: 'Historique' }];

function header(a) {
  const q = stockOf(db(), depot().id, a.ean);
  return html`
    <div class="sheet-art">
      ${thumb(a, 'thumb--lg')}
      <div class="grow"><p class="eyebrow">${a.family || 'Sans famille'}</p><p class="num muted">${a.ean}${a.ref ? ` · ${a.ref}` : ''}</p>
        <p class="sheet-art__qty"><strong class="num">${fmtInt(q)}</strong> <span class="muted">en stock</span> ${statusPill(statusOf(a, q))}</p></div>
    </div>
    <div class="sheet-actions">
      <button type="button" class="btn btn--in btn--sm" data-action="art.scan" data-mode="in">${icon('in', 'i--sm')}Entrée</button>
      <button type="button" class="btn btn--out btn--sm" data-action="art.scan" data-mode="out">${icon('out', 'i--sm')}Sortie</button>
      ${Object.keys(db().depots).length > 1 ? html`<button type="button" class="btn btn--transfer btn--sm" data-action="art.scan" data-mode="transfer">${icon('swap', 'i--sm')}Transfert</button>` : ''}
    </div>`;
}

function stockTab(a) {
  const d = depot();
  const q = stockOf(db(), d.id, a.ean);
  const others = Object.values(db().depots).filter((x) => x.id !== d.id).map((x) => ({ x, qty: stockOf(db(), x.id, a.ean) }));
  return html`
    <div class="kpis">
      <div class="kpi"><span class="kpi__value num">${fmtInt(q)}</span><span class="kpi__label">${d.code || d.name}</span></div>
      <div class="kpi"><span class="kpi__value num">${a.threshold ? fmtInt(a.threshold) : '—'}</span><span class="kpi__label">Seuil d'alerte</span></div>
      <div class="kpi"><span class="kpi__value num">${a.price ? fmtEur(q * a.price) : '—'}</span><span class="kpi__label">Valeur</span></div>
    </div>
    ${others.length ? html`<h3 class="eyebrow sheet-sec">Autres dépôts</h3><ul class="plain-list">${others.map(({ x, qty }) => html`<li><span>${x.name}</span><strong class="num">${fmtInt(qty)}</strong></li>`)}</ul>` : ''}
    ${can('stock.adjust') ? html`
      <h3 class="eyebrow sheet-sec">Corriger le stock constaté</h3>
      <form class="adjust" data-submit="art.adjust" novalidate>
        <label class="field"><span class="field__label">Quantité réelle</span><input class="input input--mono" name="qty" type="number" inputmode="numeric" min="0" step="1" value="${q}" required></label>
        <label class="field"><span class="field__label">Motif</span><select class="select" name="reason"><option value="">—</option><option>Inventaire</option><option>Casse / rebut</option><option>Erreur de saisie</option><option>Perte</option><option>Autre</option></select></label>
        <button type="submit" class="btn btn--secondary">Appliquer</button>
      </form>` : ''}`;
}

function formTab(a) {
  const editable = a ? can('article.edit') : can('article.create');
  const photo = SH.photo !== undefined ? SH.photo : a?.photo;
  const ro = editable ? '' : 'readonly';
  return html`
    <form class="stack" data-submit="art.save" novalidate>
      <label class="field"><span class="field__label">Code (EAN / interne)</span>
        <span class="input-group"><input class="input input--mono" name="ean" inputmode="numeric" maxlength="14" value="${a ? a.ean : SH.draftEan}" ${a ? 'readonly' : ''} required placeholder="3700089690011">
        ${!a && editable ? html`<button type="button" class="btn btn--secondary btn--sm" data-action="art.gencode">Code interne</button>` : ''}</span></label>
      <label class="field"><span class="field__label">Désignation</span><input class="input" name="name" maxlength="120" value="${a?.name ?? ''}" ${ro} required></label>
      <div class="grid2">
        <label class="field"><span class="field__label">Famille</span><input class="input" name="family" list="art-fams" maxlength="60" value="${a?.family ?? ''}" ${ro}><datalist id="art-fams">${families(db()).map((f) => html`<option value="${f}"></option>`)}</datalist></label>
        <label class="field"><span class="field__label">Référence</span><input class="input" name="ref" maxlength="40" value="${a?.ref ?? ''}" ${ro}></label>
        <label class="field"><span class="field__label">Prix unitaire (€)</span><input class="input input--mono" name="price" inputmode="decimal" value="${a?.price ? String(a.price).replace('.', ',') : ''}" ${ro} placeholder="0,00"></label>
        <label class="field"><span class="field__label">Seuil d'alerte</span><input class="input input--mono" name="threshold" type="number" inputmode="numeric" min="0" step="1" value="${a?.threshold ?? ''}" ${ro} placeholder="0"></label>
      </div>
      <div class="field"><span class="field__label">Photo</span>
        <div class="photo-pick">${isImageDataUrl(photo) ? html`<img class="photo-pick__img" src="${photo}" alt="Photo de la pièce">` : html`<span class="thumb thumb--lg">${icon('image')}</span>`}
          ${editable ? html`<div class="photo-pick__btns"><label class="btn btn--secondary btn--sm" for="art-photo">${icon('camera', 'i--sm')}${isImageDataUrl(photo) ? 'Remplacer' : 'Ajouter'}</label>
            ${isImageDataUrl(photo) ? html`<button type="button" class="btn btn--ghost btn--sm" data-action="art.photo.remove">Retirer</button>` : ''}</div>
          <input type="file" id="art-photo" class="sr-only" accept="image/*" data-change="art.photo">` : ''}</div></div>
      <p class="field__error" data-err role="alert"></p>
      ${editable ? html`<button type="submit" class="btn btn--primary btn--block">${a ? 'Enregistrer' : 'Créer la pièce'}</button>` : html`<p class="muted">Lecture seule pour votre rôle.</p>`}
      ${a && can('labels') ? html`<button type="button" class="btn btn--secondary btn--block" data-action="art.label">${icon('printer')}Imprimer l'étiquette</button>` : ''}
      ${a && can('article.edit') ? html`<button type="button" class="btn btn--danger btn--block" data-action="art.delete">${icon('trash')}Supprimer la pièce</button>` : ''}
    </form>`;
}

function locsTab(a) {
  const d = depot();
  const locs = articleLocations(db(), a.ean, d.id);
  const edit = can('location.edit');
  return html`
    ${locs.length ? html`<ul class="list">${locs.map((l, i) => html`<li class="row"><span class="row__body"><span class="row__title">${locBadge(locCode(l))}</span><span class="row__meta">${i === 0 ? 'Par défaut · ' : ''}${l.desc || 'Sans description'}</span></span>
      ${edit ? html`<span class="row__trail flex">${i > 0 ? html`<button type="button" class="btn btn--text" data-action="art.loc.default" data-code="${locCode(l)}">Défaut</button>` : ''}<button type="button" class="icon-btn" data-action="art.loc.remove" data-id="${l.id}" aria-label="Retirer l'emplacement ${locCode(l)}">${icon('trash')}</button></span>` : ''}</li>`)}</ul>`
      : emptyState({ icon: 'pin', title: 'Aucun emplacement', text: `Cette pièce n'est pas encore rangée dans ${d.name}.` })}
    ${edit ? html`<form class="input-group sheet-sec" data-submit="art.loc.add" novalidate>
      <input class="input input--mono" name="code" list="art-locs" autocomplete="off" autocapitalize="characters" placeholder="R1-A2-E1-C1" aria-label="Nouvel emplacement">
      <datalist id="art-locs">${depotLocationCodes(db(), d.id).map((c) => html`<option value="${c}"></option>`)}</datalist>
      <button type="submit" class="btn btn--primary btn--sm">Ajouter</button></form><p class="field__error" data-err role="alert"></p>` : ''}`;
}

function historyTab(a) {
  const rows = movements(db(), { ean: a.ean, limit: 40 });
  return rows.length ? html`<div class="list">${rows.map((h) => movementRow(h, { depot: Object.keys(db().depots).length > 1 }))}</div>`
    : emptyState({ icon: 'clock', title: 'Aucun mouvement', text: 'Les entrées, sorties et transferts de cette pièce apparaîtront ici.' });
}

function body() {
  if (SH.isNew) return html`${formTab(null)}`;
  const a = db().articles[SH.ean];
  if (!a) return emptyState({ icon: 'box', title: 'Pièce introuvable' });
  const panel = { stock: stockTab, form: formTab, locs: locsTab, history: historyTab }[SH.tab](a);
  return html`${header(a)}<div class="tabs">${segmented({ action: 'art.tab', value: SH.tab, items: TABS, label: 'Sections de la fiche' })}</div><div class="sheet-panel">${panel}</div>`;
}

function paint() {
  const a = SH.isNew ? null : db().articles[SH.ean];
  openSheet({ title: SH.isNew ? 'Nouvelle pièce' : a?.name ?? 'Pièce', body: body(), onClose: () => { SH.ean = null; SH.photo = undefined; SH.isNew = false; } });
}

/** Ouvre la fiche d'un article (ou le formulaire de création si ean = null). */
export function openArticle(ean, tab = 'stock') {
  SH.isNew = !ean; SH.ean = ean; SH.tab = tab; SH.photo = undefined; SH.draftEan = '';
  paint();
}

const reopen = () => { const body_ = $('#sheet .sheet__body'); const y = body_?.scrollTop ?? 0; paint(); const b = $('#sheet .sheet__body'); if (b) b.scrollTop = y; };
const sheetBody = () => $('#sheet .sheet__body');

export function initArticleSheet() {
  actions({
    'article.open': (el) => openArticle(el.dataset.ean),
    'art.tab': (el) => { SH.tab = el.dataset.value; reopen(); },
    async 'art.scan'(el) { const ean = SH.ean; await closeSheet(); navigate(`scan/${el.dataset.mode}`, { params: { ean } }); },
    'art.gencode': (el) => {
      const form = el.closest('form');
      form.elements.ean.value = nextInternalEan(Object.keys(db().articles));
      form.elements.name.focus();
    },
    async 'art.photo'(input) {
      const f = input.files?.[0];
      if (!f) return;
      try { SH.photo = (await shrink(f, { max: 480, quality: 0.72 })).dataUrl; } catch { toast('Image illisible.', { tone: 'error' }); return; }
      keepForm();
    },
    'art.photo.remove': () => { SH.photo = ''; keepForm(); },
    'art.save'(form) {
      const err = form.querySelector('[data-err]');
      const fields = { ean: val(form, 'ean'), name: val(form, 'name'), family: val(form, 'family'), ref: val(form, 'ref'), price: val(form, 'price'), threshold: val(form, 'threshold') };
      if (SH.photo !== undefined) fields.photo = SH.photo;
      try {
        const r = run(upsertArticle, fields);
        toast(r.created ? 'Pièce créée.' : 'Pièce enregistrée.', { tone: 'ok' });
        SH.isNew = false; SH.ean = r.ean; SH.tab = r.created ? 'stock' : 'form'; SH.photo = undefined;
        paint();
      } catch (e) { if (e.isOpError) { err.textContent = e.message; } else throw e; }
    },
    async 'art.delete'() {
      const a = db().articles[SH.ean];
      if (!(await confirmDialog({ title: 'Supprimer cette pièce ?', message: `« ${a.name} » sera retirée du catalogue. Son historique est conservé.`, confirmLabel: 'Supprimer', danger: true }))) return;
      run(deleteArticle, a.ean);
      await closeSheet();
      toast('Pièce supprimée.', { tone: 'ok' });
    },
    'art.label': () => {
      const a = db().articles[SH.ean];
      const l = articleLocations(db(), a.ean, depot().id)[0];
      printLabels([{ kind: 'article', article: a, loc: l ? locCode(l) : '' }], { copies: 3 });
    },
    'art.adjust'(form) {
      const r = run(adjustStock, { ean: SH.ean, qty: val(form, 'qty'), reason: val(form, 'reason') });
      toast(`Stock corrigé : ${fmtInt(r.stock)} (${r.diff > 0 ? '+' : ''}${fmtInt(r.diff)}).`, { tone: 'ok' });
      reopen();
    },
    'art.loc.add'(form) {
      const err = form.parentElement.querySelector('[data-err]');
      try { run(setArticleLocation, { ean: SH.ean, code: val(form, 'code') }); reopen(); } catch (e) { if (e.isOpError) err.textContent = e.message; else throw e; }
    },
    'art.loc.default': (el) => { run(setArticleLocation, { ean: SH.ean, code: el.dataset.code, makeDefault: true }); reopen(); },
    'art.loc.remove': (el) => { run(removeArticleLocation, { ean: SH.ean, locId: el.dataset.id }); reopen(); },
  });
}

/** Rafraîchit le formulaire en conservant ce qui est saisi (photo ajoutée/retirée). */
function keepForm() {
  const form = sheetBody()?.querySelector('form[data-submit="art.save"]');
  const keep = form ? Object.fromEntries(['ean', 'name', 'family', 'ref', 'price', 'threshold'].map((k) => [k, form.elements[k]?.value ?? ''])) : null;
  if (SH.isNew) SH.draftEan = keep?.ean ?? '';
  reopen();
  if (!keep) return;
  const f = sheetBody()?.querySelector('form[data-submit="art.save"]');
  if (f) for (const [k, v] of Object.entries(keep)) if (f.elements[k] && !f.elements[k].readOnly) f.elements[k].value = v;
}

