// Seuils intelligents (responsables) : pour chaque pièce consommée dans le dépôt, le seuil et le maximum
// actuels face à ceux calculés sur la consommation réelle, le délai de réapprovisionnement et le niveau
// de service. Sélection puis « Appliquer ». Calcul détaillé dans core/planning.js (proposeLevel).
import { html, fmtInt, plural } from '../../lib/text.js';
import { icon, actions, $, setHtml } from '../dom.js';
import { db, depot, run } from '../state.js';
import { levelProposals, measuredLeadDays } from '../../core/planning.js';
import { setLevels } from '../../core/ops-orders.js';
import { pageHead, segmented, emptyState } from '../components.js';
import { confirmDialog } from '../dialogs.js';
import { refresh } from '../router.js';
import { toast } from '../toast.js';

const V = { filter: 'changed', q: '', selected: new Set(), depotId: null };
const CONF = { high: ['pill--ok', 'Fiable'], medium: ['pill--info', 'Correct'], low: ['pill--low', 'Peu de données'] };
const fmtRate = (r) => (r >= 10 ? fmtInt(Math.round(r)) : r.toLocaleString('fr-FR', { maximumFractionDigits: 1 }));
const fmtDays = (d) => (Number.isFinite(d) ? `${fmtInt(Math.floor(d))} j` : '—');

function rows() {
  return levelProposals(db(), depot().id, new Date(), { changedOnly: V.filter === 'changed', q: V.q });
}

function list() {
  const r = rows();
  if (!r.length) return emptyState({ icon: 'check', title: V.filter === 'changed' ? 'Aucun seuil à revoir' : 'Aucune consommation observée', text: V.filter === 'changed' ? 'Les seuils actuels correspondent à la consommation réelle.' : 'Les propositions apparaissent dès que des pièces sortent du stock.' });
  return html`<ul class="list levels">${r.map((x) => {
    const sel = V.selected.has(x.article.ean);
    const [cls, label] = CONF[x.proposed.confidence] ?? ['', ''];
    return html`<li class="row levels__row ${sel ? 'is-selected' : ''}">
      <label class="levels__pick"><input type="checkbox" data-change="lv.toggle" data-ean="${x.article.ean}" ${sel ? 'checked' : ''} aria-label="Sélectionner ${x.article.name}"></label>
      <span class="row__body">
        <button type="button" class="linklike row__title" data-action="article.open" data-ean="${x.article.ean}">${x.article.name}</button>
        <span class="row__meta">Conso ≈ ${fmtRate(x.proposed.avgDaily)}/j · stock ${fmtInt(x.qty)} (≈ ${fmtDays(x.daysLeft)}) · délai ${fmtRate(x.proposed.lead)} j ${label ? html`<span class="pill ${cls}">${label}</span>` : ''}</span>
        <span class="levels__vals num"><span class="muted">${fmtInt(x.current.min)}–${fmtInt(x.current.max)}</span> ${icon('chevron', 'i--sm')} <strong class="${x.trend === 'up' ? 'text-amber' : x.trend === 'down' ? 'text-green' : ''}">${fmtInt(x.proposed.min)}–${fmtInt(x.proposed.max)}</strong>
          ${x.current.source === 'article' ? html`<span class="muted levels__src">(seuil de la fiche)</span>` : ''}</span>
      </span></li>`;
  })}</ul>`;
}

function paintList() {
  const host = $('#levels-list');
  if (host) setHtml(host, list());
  const n = V.selected.size;
  const btn = $('#levels-apply');
  if (btn) { btn.disabled = !n; btn.lastChild.textContent = `Appliquer ${plural(n, 'seuil')}`; }
}

function render() {
  const d = depot();
  if (V.depotId !== d.id) { V.depotId = d.id; V.selected = new Set(); }
  const s = db().meta.settings;
  const lead = d.kind === 'central' ? `délai fournisseur (fiche fournisseur, sinon ${s.leadDaysSupplier} j)` : `délai de livraison de l'entrepôt (${measuredLeadDays(db(), d.id) ?? s.leadDaysInternal} j${measuredLeadDays(db(), d.id) ? ', mesuré' : ', réglage'})`;
  const changed = levelProposals(db(), d.id, new Date(), { changedOnly: true }).length;
  return html`<section>
    ${pageHead({ eyebrow: 'Pilotage', title: 'Seuils intelligents', sub: d.name })}
    <div class="pad stack">
      <details class="explain"><summary>${icon('info', 'i--sm')} Comment sont calculés les seuils ?</summary>
        <p><strong>Seuil</strong> = consommation pendant le ${lead} + stock de sécurité (niveau de service ${s.serviceLevel} % sur la variabilité de la consommation).</p>
        <p><strong>Maximum</strong> = seuil + ${d.kind === 'central' ? s.coverDaysCentral : s.coverDaysAtelier} jours de consommation, arrondi au conditionnement. Consommation observée sur les 13 dernières semaines.</p>
        <p class="muted">Réglages modifiables par un administrateur (Administration → Données et sécurité).</p></details>
      ${segmented({ action: 'lv.filter', value: V.filter, label: 'Filtre', items: [{ value: 'changed', label: 'À revoir', badge: changed || '' }, { value: 'all', label: 'Toutes les pièces' }] })}
      <div class="searchbar searchbar--flat">${icon('search')}<input class="input" type="search" placeholder="Rechercher une pièce" value="${V.q}" aria-label="Rechercher une pièce" data-input="lv.search"></div>
      <div class="flex flex--between"><button type="button" class="btn btn--text" data-action="lv.all">Tout sélectionner</button><button type="button" class="btn btn--text" data-action="lv.none">Aucune</button></div>
    </div>
    <div id="levels-list">${list()}</div>
    <div class="sticky-action"><button type="button" class="btn btn--primary btn--block" id="levels-apply" data-action="lv.apply" ${V.selected.size ? '' : 'disabled'}>${icon('check')}<span>Appliquer ${plural(V.selected.size, 'seuil')}</span></button></div>
  </section>`;
}

export const levelsRoute = { title: 'Seuils intelligents', back: true, perm: 'levels.manage', render };

export function initLevels() {
  let timer = null;
  actions({
    'lv.filter': (el) => { V.filter = el.dataset.value; refresh(); },
    'lv.search': (el) => { clearTimeout(timer); timer = setTimeout(() => { V.q = el.value.trim(); paintList(); }, 150); },
    'lv.toggle': (el) => { if (el.checked) V.selected.add(el.dataset.ean); else V.selected.delete(el.dataset.ean); paintList(); },
    'lv.all': () => { for (const r of rows()) V.selected.add(r.article.ean); paintList(); },
    'lv.none': () => { V.selected.clear(); paintList(); },
    async 'lv.apply'() {
      const all = levelProposals(db(), depot().id, new Date());
      const items = all.filter((r) => V.selected.has(r.article.ean)).map((r) => ({ ean: r.article.ean, min: r.proposed.min, max: r.proposed.max }));
      if (!items.length) return;
      if (!(await confirmDialog({ title: `Appliquer ${plural(items.length, 'seuil')} ?`, message: `Les alertes et les quantités suggérées de ${depot().name} utiliseront ces nouveaux seuils.`, confirmLabel: 'Appliquer' }))) return;
      run(setLevels, { depotId: depot().id, items });
      V.selected.clear();
      toast(`${plural(items.length, 'seuil')} mis à jour.`, { tone: 'ok' });
      refresh();
    },
  });
}
