// Rapport périodique (hebdomadaire par défaut) : consommation, valeur, commandes (taux de service, délai,
// écarts), ruptures ; détail par atelier pour l'entrepôt central. Imprimable et exportable.
import { html, fmtInt, fmtEur, fmtDateTime, localDay } from '../../lib/text.js';
import { stringify } from '../../lib/csv.js';
import { icon, actions, download } from '../dom.js';
import { db, depot } from '../state.js';
import { weeklyReport } from '../../core/planning.js';
import { pageHead, segmented, kpi } from '../components.js';
import { printDocument } from '../print.js';
import { refresh } from '../router.js';

const RP = { days: 7 };
const pct = (v) => (v === null ? '—' : `${v} %`);

function render() {
  const r = weeklyReport(db(), depot().id, new Date(), { days: RP.days });
  const max = Math.max(1, ...r.top.map((t) => t.units));
  return html`<section>
    ${pageHead({ eyebrow: 'Pilotage', title: RP.days === 7 ? 'Rapport hebdomadaire' : `Rapport ${RP.days} jours`, sub: `${depot().name} · du ${fmtDateTime(r.from)} au ${fmtDateTime(r.to)}`,
      actions: html`<button type="button" class="btn btn--secondary btn--sm" data-action="rp.print">${icon('printer', 'i--sm')}Imprimer</button>` })}
    <div class="pad pad--tight">${segmented({ action: 'rp.days', value: String(RP.days), label: 'Période', items: [{ value: '7', label: '7 jours' }, { value: '30', label: '30 jours' }] })}</div>
    <div class="kpis">
      ${kpi({ label: 'Pièces sorties', value: fmtInt(r.outUnits), sub: fmtEur(r.outValue) })}
      ${kpi({ label: 'Pièces entrées', value: fmtInt(r.inUnits) })}
      ${kpi({ label: 'Taux de service', value: pct(r.orders.serviceRate), tone: r.orders.serviceRate === null ? '' : r.orders.serviceRate >= 95 ? 'green' : r.orders.serviceRate >= 85 ? 'amber' : 'red', sub: 'quantités expédiées / demandées' })}
      ${kpi({ label: 'Délai moyen', value: r.orders.avgLeadDays === null ? '—' : `${String(r.orders.avgLeadDays).replace('.', ',')} j`, sub: 'envoi → réception' })}
      ${kpi({ label: 'Réceptions avec écart', value: fmtInt(r.orders.gaps), tone: r.orders.gaps ? 'amber' : 'green' })}
      ${kpi({ label: 'Valeur du stock', value: fmtEur(r.stock.value), sub: `${fmtInt(r.stock.alerts)} alerte(s) · ${fmtInt(r.stock.zeros)} rupture(s)`, tone: 'blue' })}
    </div>
    <section class="card dash-card"><h3 class="card__title">Commandes</h3>
      <p class="muted">${fmtInt(r.orders.shipped)} expédiée(s) · ${fmtInt(r.orders.received)} reçue(s) · ${fmtInt(r.corrections)} correction(s) de stock</p></section>
    ${r.perAtelier.length ? html`<section class="card dash-card"><h3 class="card__title">Par atelier</h3>
      <ul class="plain-list">${r.perAtelier.map((x) => html`<li><span>${x.depot.name}</span><strong class="num">${fmtInt(x.orders)} cmd · ${fmtInt(x.units)} pièces</strong></li>`)}</ul></section>` : ''}
    <section class="card dash-card"><header class="flex flex--between"><h3 class="card__title">Plus fortes consommations</h3><button type="button" class="btn btn--text" data-action="rp.csv">CSV</button></header>
      ${r.top.length ? html`<div class="bars">${r.top.map((t) => html`<div class="bar-row"><span class="bar-row__label" title="${t.name}">${t.name}</span><span class="bar"><i style="--w:${Math.max(3, Math.round((t.units / max) * 100))}%"></i></span><span class="bar-row__value num">${fmtInt(t.units)}</span></div>`)}</div>` : html`<p class="muted">Aucune sortie sur la période.</p>`}</section>
  </section>`;
}

export const reportsRoute = { title: 'Rapport', back: true, perm: 'reports', render };

export function initReports() {
  actions({
    'rp.days': (el) => { RP.days = Number(el.dataset.value); refresh(); },
    'rp.print'() {
      const r = weeklyReport(db(), depot().id, new Date(), { days: RP.days });
      printDocument({
        title: `Rapport ${RP.days} jours`, subtitle: depot().name,
        meta: `sorties ${fmtInt(r.outUnits)} (${fmtEur(r.outValue)}) · taux de service ${pct(r.orders.serviceRate)} · délai moyen ${r.orders.avgLeadDays ?? '—'} j · écarts ${r.orders.gaps}`,
        columns: [{ label: 'EAN' }, { label: 'Pièce' }, { label: 'Unités sorties', num: true }, { label: 'Valeur', num: true }],
        rows: r.top.map((t) => [t.ean, t.name, t.units, fmtEur(t.value, true)]),
        notes: `Valeur du stock ${fmtEur(r.stock.value)} · ${r.stock.alerts} alerte(s) · ${r.stock.zeros} rupture(s).${r.perAtelier.length ? ` Par atelier : ${r.perAtelier.map((x) => `${x.depot.name} ${x.orders} cmd / ${x.units} pièces`).join(' ; ')}.` : ''}`,
      });
    },
    'rp.csv'() {
      const r = weeklyReport(db(), depot().id, new Date(), { days: RP.days });
      download(`rapport-${RP.days}j-${depot().code || 'depot'}-${localDay()}.csv`, stringify(r.top, [
        { label: 'EAN', get: (t) => t.ean }, { label: 'Pièce', get: (t) => t.name }, { label: 'Unités sorties', get: (t) => t.units }, { label: 'Valeur', get: (t) => String(Math.round(t.value * 100) / 100).replace('.', ',') },
      ]), 'text/csv');
    },
  });
}
