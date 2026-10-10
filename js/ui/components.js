// Fragments d'interface partagés entre les vues. Tout passe par html`` (auto-échappement).
import { html, fmtInt, fmtRelative, initials } from '../lib/text.js';
import { isImageDataUrl } from '../lib/image.js';
import { icon } from './dom.js';
import { hueClass, sectionIcon } from './look.js';
import { MOVES } from '../core/config.js';
import { locCode } from '../core/queries.js';

/** Vignette : photo (data-URL validée) ou monogramme sur la teinte de sa famille d'articles. */
export function thumb(article, cls = '') {
  const photo = isImageDataUrl(article.photo);
  const inner = photo
    ? html`<img src="${article.photo}" alt="" loading="lazy" decoding="async">`
    : html`<span aria-hidden="true">${(article.name || '?').trim().charAt(0).toUpperCase()}</span>`;
  return html`<span class="thumb ${photo ? '' : hueClass(article.family || article.name)} ${cls}">${inner}</span>`;
}

/** Pastille d'initiales d'une personne (teinte stable par nom). */
export const avatar = (name, cls = '') => html`<span class="avatar ${hueClass(name)} ${cls}">${initials(name)}</span>`;

const STATUS = { zero: ['pill--zero', 'Épuisé'], low: ['pill--low', 'Alerte'] };
export const statusPill = (status) => (STATUS[status] ? html`<span class="pill ${STATUS[status][0]}">${STATUS[status][1]}</span>` : '');

export const locBadge = (code) => (code ? html`<span class="loc">${icon('pin')}${code}</span>` : '');

/** Ligne d'article cliquable (liste des articles, résultats de recherche). */
export function articleRow({ article, qty, status, locs, min = article.threshold }, { action = 'article.open', extra = '' } = {}) {
  const qtyCls = status === 'zero' ? 'row__qty--zero' : status === 'low' ? 'row__qty--low' : '';
  return html`
    <button type="button" class="row" data-action="${action}" data-ean="${article.ean}">
      <span class="row__lead">${thumb(article)}</span>
      <span class="row__body">
        <span class="row__title">${article.name} ${statusPill(status)}</span>
        <span class="row__meta">${locs.length ? html`${locBadge(locCode(locs[0]))}${locs.length > 1 ? html`<span class="muted">+${locs.length - 1}</span>` : ''}` : html`<span class="muted">Sans emplacement</span>`}${article.family ? html`<span>${article.family}</span>` : ''}${extra}</span>
      </span>
      <span class="row__trail">
        <span class="row__qty ${qtyCls}">${fmtInt(qty)}</span>
        ${min > 0 ? html`<span class="row__sub">min ${fmtInt(min)}</span>` : ''}
      </span>
    </button>`;
}

/** Ligne de mouvement (historique). */
export function movementRow(h, { depot = false, now = new Date() } = {}) {
  const m = MOVES[h.type] ?? { label: h.type, sign: '', tone: 'inv' };
  const qty = h.type === 'inv' ? html`→ ${fmtInt(h.qty)}` : html`${m.sign}${fmtInt(h.qty)}`;
  const bits = [fmtRelative(h.date, now), h.operator, depot ? h.depotName : '', h.loc, h.reason, h.note].filter(Boolean);
  return html`
    <div class="row ${h.undone ? 'is-undone' : ''}">
      <span class="row__bar row__bar--${m.tone}" aria-hidden="true"></span>
      <span class="row__body">
        <span class="row__title">${h.name}</span>
        <span class="row__meta">${bits.join(' · ')}</span>
      </span>
      <span class="row__trail">
        <span class="row__qty row__qty--${m.tone}">${qty}</span>
        <span class="row__sub">${m.label}${h.undone ? ' · annulé' : ''}${h.type === 'inv' && h.delta ? ` (${h.delta > 0 ? '+' : ''}${fmtInt(h.delta)})` : ''}</span>
      </span>
    </div>`;
}

/**
 * En-tête de page : la plaque émaillée de la section (aplat, liseré intérieur), avec la cocarde de la section
 * (ou `icon`). Pas de sur-titre au-dessus du titre : `eyebrow` (catégorie) est accepté pour compatibilité,
 * mais le titre parle seul.
 */
export function pageHead({ title, sub = '', actions = '', icon: ic = sectionIcon() }) {
  return html`
    <div class="page-head ${String(title).length > 22 ? 'page-head--long' : ''}">
      <span class="page-head__icon" aria-hidden="true">${icon(ic)}</span>
      <div class="grow">
        <h2 class="page-head__title">${title}</h2>
        ${sub ? html`<p class="page-head__sub">${sub}</p>` : ''}
      </div>
      ${actions}
    </div>`;
}

export function emptyState({ icon: ic = 'box', title, text = '', action = '' }) {
  return html`<div class="empty"><span class="empty__art" aria-hidden="true">${icon(ic)}</span><p class="empty__title">${title}</p>${text ? html`<p>${text}</p>` : ''}${action}</div>`;
}

/** Tuile d'indicateur ; cliquable si `action` est fourni (data-action). */
export function kpi({ label, value, tone = '', sub = '', action = '', data = '' }) {
  const inner = html`<span class="kpi__value kpi__value--${tone} num">${value}</span><span class="kpi__label">${label}</span>${sub ? html`<span class="kpi__sub">${sub}</span>` : ''}`;
  return action ? html`<button type="button" class="kpi" data-action="${action}" data-value="${data}">${inner}</button>` : html`<div class="kpi">${inner}</div>`;
}

/** Contrôle segmenté (boutons à état pressé). `items` : [{value,label,tone?,badge?}] */
export function segmented({ action, value, items, label }) {
  return html`<div class="seg" role="group" aria-label="${label}">${items.map((it) => html`
    <button type="button" class="seg__btn ${it.tone ? `seg__btn--${it.tone}` : ''}" data-action="${action}" data-value="${it.value}" aria-pressed="${String(it.value === value)}">${it.icon ? icon(it.icon, 'i--sm') : ''}${it.label}${it.badge ? html`<span class="seg__badge">${it.badge}</span>` : ''}</button>`)}</div>`;
}

export function chips({ action, value, items, label }) {
  return html`<div class="chips" role="group" aria-label="${label}">${items.map((it) => html`
    <button type="button" class="chip" data-action="${action}" data-value="${it.value}" aria-pressed="${String(it.value === value)}">${it.label}${it.count !== undefined ? html`<span class="chip__count">${it.count}</span>` : ''}</button>`)}</div>`;
}

