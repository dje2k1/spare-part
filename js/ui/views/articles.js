// Articles : une seule liste (catalogue + stock) → une seule fiche. Réassort : pièces sous leur seuil.
import { html, fmtInt, fmtEur, plural } from '../../lib/text.js';
import { stringify } from '../../lib/csv.js';
import { icon, actions, $, setHtml, download } from '../dom.js';
import { db, depot, can } from '../state.js';
import { searchArticles, families, reorderList, locCode } from '../../core/queries.js';
import { pageHead, articleRow, chips, emptyState, thumb, locBadge } from '../components.js';
import { openArticle } from './article-sheet.js';

const A = { q: '', filter: 'all', family: '', sort: 'loc', limit: 60 };
let timer = null;

function counts() {
  const rows = searchArticles(db(), depot().id, {});
  return { all: rows.length, alert: rows.filter((r) => r.status !== 'ok').length, zero: rows.filter((r) => r.status === 'zero').length };
}

function render(r) {
  const f = r.params.get('f');
  if (['all', 'alert', 'zero'].includes(f)) { A.filter = f; A.limit = 60; }
  const c = counts();
  const fams = families(db());
  return html`
    <section>
      ${pageHead({ eyebrow: 'Catalogue & stock', title: 'Articles', sub: `${plural(c.all, 'référence')} · ${depot().name}`,
        actions: can('article.create') ? html`<button type="button" class="btn btn--primary btn--sm" data-action="articles.new">${icon('plus', 'i--sm')}Pièce</button>` : '' })}
      <div class="sticky-tools">
        <div class="searchbar">${icon('search')}<input class="input" type="search" id="articles-q" placeholder="Nom, code, famille, emplacement…" value="${A.q}" autocomplete="off" aria-label="Rechercher une pièce" data-input="articles.search"></div>
        ${chips({ action: 'articles.filter', value: A.filter, label: 'Filtrer', items: [{ value: 'all', label: 'Tous', count: c.all }, { value: 'alert', label: 'Alertes', count: c.alert }, { value: 'zero', label: 'Épuisés', count: c.zero }] })}
        <div class="toolbar">
          <select class="select select--plain" data-change="articles.family" aria-label="Famille"><option value="">Toutes les familles</option>${fams.map((x) => html`<option ${x === A.family ? 'selected' : ''}>${x}</option>`)}</select>
          <select class="select select--plain" data-change="articles.sort" aria-label="Tri">
            ${[['loc', 'Par emplacement'], ['name', 'Par nom'], ['qty-asc', 'Stock croissant'], ['qty-desc', 'Stock décroissant']].map(([v, l]) => html`<option value="${v}" ${v === A.sort ? 'selected' : ''}>${l}</option>`)}
          </select>
        </div>
      </div>
      <div id="articles-list"></div>
    </section>`;
}

function paintList() {
  const host = $('#articles-list');
  if (!host) return;
  const rows = searchArticles(db(), depot().id, { q: A.q, filter: A.filter, family: A.family, sort: A.sort });
  if (!rows.length) {
    setHtml(host, emptyState({ icon: 'search', title: A.q || A.family || A.filter !== 'all' ? 'Aucune pièce trouvée' : 'Catalogue vide',
      text: A.q || A.filter !== 'all' ? 'Modifiez la recherche ou les filtres.' : 'Ajoutez votre première pièce ou importez un fichier CSV (Administration).' }));
    return;
  }
  const shown = rows.slice(0, A.limit);
  setHtml(host, html`<div class="list">${shown.map((r) => articleRow(r))}</div>
    ${rows.length > shown.length ? html`<div class="pad center"><button type="button" class="btn btn--secondary" data-action="articles.more">Afficher plus (${fmtInt(rows.length - shown.length)} restantes)</button></div>` : ''}`);
}

export const articlesRoute = { title: 'Articles', nav: 'articles', render, mount: paintList };

// ── Réassort ──
function renderReorder() {
  const rows = reorderList(db(), depot().id);
  const total = rows.reduce((s, r) => s + r.cost, 0);
  return html`
    <section>
      ${pageHead({ eyebrow: 'Réassort', title: 'À réapprovisionner', sub: rows.length ? `${plural(rows.length, 'référence')} sous le seuil · coût estimé ${fmtEur(total)}` : 'Tout est au-dessus des seuils.',
        actions: rows.length ? html`<button type="button" class="btn btn--secondary btn--sm" data-action="reorder.csv">${icon('download', 'i--sm')}CSV</button>` : '' })}
      ${rows.length ? html`<p class="pad muted">Objectif : 2 × le seuil d'alerte. Touchez une ligne pour ouvrir la fiche.</p><div class="list">${rows.map((r) => html`
        <button type="button" class="row" data-action="article.open" data-ean="${r.article.ean}">
          <span class="row__lead">${thumb(r.article)}</span>
          <span class="row__body"><span class="row__eyebrow">${r.article.family || '—'}</span><span class="row__title">${r.article.name}</span>
            <span class="row__meta">En stock ${fmtInt(r.qty)} / seuil ${fmtInt(r.threshold)}${r.locs[0] ? html` · ${locBadge(locCode(r.locs[0]))}` : ''}</span></span>
          <span class="row__trail"><span class="row__qty">+${fmtInt(r.suggested)}</span><span class="row__sub">${r.cost ? fmtEur(r.cost) : 'à commander'}</span></span>
        </button>`)}</div>`
        : emptyState({ icon: 'check', title: 'Aucune alerte', text: 'Aucune pièce n\'est sous son seuil dans ce dépôt.' })}
    </section>`;
}

export const reorderRoute = { title: 'Réassort', back: true, perm: 'stock.adjust', render: renderReorder };

export function initArticles() {
  actions({
    'articles.new': () => openArticle(null),
    'articles.search': (el) => { clearTimeout(timer); timer = setTimeout(() => { A.q = el.value; A.limit = 60; paintList(); }, 100); },
    'articles.filter': (el) => {
      A.filter = el.dataset.value; A.limit = 60;
      el.parentElement.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', String(c === el)));
      paintList();
    },
    'articles.family': (el) => { A.family = el.value; A.limit = 60; paintList(); },
    'articles.sort': (el) => { A.sort = el.value; paintList(); },
    'articles.more': () => { A.limit += 60; paintList(); },
    'reorder.csv': () => {
      const rows = reorderList(db(), depot().id);
      download(`reassort-${depot().code || 'depot'}-${new Date().toISOString().slice(0, 10)}.csv`, stringify(rows, [
        { label: 'EAN', get: (r) => r.article.ean }, { label: 'Désignation', get: (r) => r.article.name }, { label: 'Famille', get: (r) => r.article.family },
        { label: 'Référence', get: (r) => r.article.ref }, { label: 'Stock', get: (r) => r.qty }, { label: 'Seuil', get: (r) => r.threshold },
        { label: 'Objectif', get: (r) => r.target }, { label: 'À commander', get: (r) => r.suggested }, { label: 'Prix unitaire', get: (r) => String(r.article.price).replace('.', ',') },
        { label: 'Coût estimé', get: (r) => String(Math.round(r.cost * 100) / 100).replace('.', ',') },
      ]), 'text/csv');
    },
  });
}
