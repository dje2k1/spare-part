// Plan des emplacements : racks → allées × étagères, avec l'état de chaque case (vide, rempli, alerte, épuisé).
import { html, fmtInt, plural } from '../../lib/text.js';
import { icon, actions, $ } from '../dom.js';
import { db, depot, can, state } from '../state.js';
import { planModel, articlesAt, locCode, statusOf } from '../../core/queries.js';
import { pageHead, kpi, emptyState, articleRow } from '../components.js';
import { openSheet } from '../dialogs.js';
import { printLabels } from '../print.js';
import { switchDepot } from '../session.js';
import { refresh } from '../router.js';

const STATE_LABEL = { ok: 'Rempli', alert: 'Alerte', zero: 'Épuisé', empty: 'Vide' };

function render() {
  const d = depot();
  const m = planModel(db(), d.id);
  const multi = can('depot.any') && Object.keys(db().depots).length > 1;
  const rate = m.total ? Math.round((m.occupied / m.total) * 100) : 0;
  return html`
    <section>
      ${pageHead({ eyebrow: 'Plan d\'occupation', title: 'Emplacements', sub: d.name,
        actions: m.total && can('labels') ? html`<button type="button" class="btn btn--secondary btn--sm" data-action="plan.labels">${icon('printer', 'i--sm')}Étiquettes</button>` : '' })}
      ${multi ? html`<div class="pad"><select class="select" data-change="plan.depot" aria-label="Dépôt">${Object.values(db().depots).map((x) => html`<option value="${x.id}" ${x.id === d.id ? 'selected' : ''}>${x.name}</option>`)}</select></div>` : ''}
      ${m.total ? html`
        <div class="kpis kpis--3">${kpi({ label: 'Emplacements', value: fmtInt(m.total) })}${kpi({ label: 'Occupés', value: `${fmtInt(m.occupied)}`, sub: `${rate} %` })}${kpi({ label: 'Avec alerte', value: fmtInt(m.alerts), tone: m.alerts ? 'amber' : 'green' })}</div>
        <ul class="legend pad" aria-label="Légende">${['ok', 'alert', 'zero', 'empty'].map((s) => html`<li><i class="legend__dot legend__dot--${s}"></i>${STATE_LABEL[s]}</li>`)}</ul>
        ${m.racks.map((rack) => html`
          <section class="rack" aria-label="Rack ${rack.name}">
            <header class="rack__head"><h3>Rack ${rack.name}</h3><span class="muted">${plural(rack.occupied, 'case')} occupée${rack.occupied > 1 ? 's' : ''} sur ${rack.total}</span></header>
            <div class="rack__scroll"><div class="rack__grid" role="table">
              <div class="rack__row rack__row--head" role="row"><span class="rack__aisle"></span>${rack.columns.map((c) => html`<span class="rack__colhead" role="columnheader">${c}</span>`)}</div>
              ${rack.rows.map((row) => html`<div class="rack__row" role="row"><span class="rack__aisle" role="rowheader">${row.aisle}</span>
                ${row.cells.map((c) => (c ? html`<button type="button" role="cell" class="cell cell--${c.state}" data-action="plan.cell" data-id="${c.loc.id}" aria-label="${locCode(c.loc)} : ${STATE_LABEL[c.state]}, ${c.units} unités">
                  <span class="cell__units num">${fmtInt(c.units)}</span><span class="cell__refs">${c.refs ? plural(c.refs, 'réf.', 'réf.') : '—'}${c.alerts ? html` ${icon('alert', 'i--sm')}` : ''}</span></button>` : html`<span class="cell cell--none" role="cell" aria-hidden="true"></span>`))}</div>`)}
            </div></div>
          </section>`)}`
        : emptyState({ icon: 'map', title: 'Aucun emplacement', text: 'Créez vos emplacements dans Administration, ou saisissez-en un en recevant une pièce.' })}
    </section>`;
}

export const planRoute = { title: 'Plan', back: true, render };

function cellSheet(id) {
  const loc = db().locations[id];
  if (!loc) return;
  const list = articlesAt(db(), loc.depotId, id);
  const code = locCode(loc);
  openSheet({
    title: code,
    body: html`
      <p class="muted">${loc.desc || 'Pas de description'} · ${db().depots[loc.depotId].name}</p>
      ${list.length ? html`<div class="list sheet-sec">${list.map(({ article, qty }) => articleRow({ article, qty, status: statusOf(article, qty), locs: [loc] }))}</div>`
        : emptyState({ icon: 'box', title: 'Case vide', text: 'Aucune pièce n\'est rangée ici.' })}
      ${can('labels') ? html`<button type="button" class="btn btn--secondary btn--block sheet-sec" data-action="plan.label" data-id="${id}">${icon('qr')}Imprimer l'étiquette QR</button>` : ''}`,
  });
}

export function initPlan() {
  actions({
    'plan.depot': (el) => { switchDepot(el.value); refresh(); },
    'plan.cell': (el) => cellSheet(el.dataset.id),
    'plan.label': (el) => { const l = db().locations[el.dataset.id]; printLabels([{ kind: 'location', loc: l, depot: db().depots[l.depotId] }]); },
    'plan.labels': () => {
      const locs = Object.values(db().locations).filter((l) => l.depotId === state.session.depotId).sort((a, b) => locCode(a).localeCompare(locCode(b), 'fr', { numeric: true }));
      printLabels(locs.map((l) => ({ kind: 'location', loc: l, depot: depot() })));
    },
  });
}
