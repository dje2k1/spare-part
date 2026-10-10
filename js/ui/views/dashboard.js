// Tableau de bord : indicateurs sur une période réelle, courbe d'évolution, flux, tops, activité, dépôts.
import { html, fmtInt, fmtEur, plural } from '../../lib/text.js';
import { lineChart } from '../../lib/charts.js';
import { icon, actions } from '../dom.js';
import { db, depot, can } from '../state.js';
import { kpis, evolution, flow, heatmap, topArticles, operatorStats, depotComparison, reorderList } from '../../core/queries.js';
import { pageHead, segmented, kpi, avatar } from '../components.js';
import { refresh } from '../router.js';

const D = { days: 30 };
const DAYS_FR = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];

const pct = (v, max) => Math.max(v > 0 ? 3 : 0, Math.round((v / (max || 1)) * 100));

function barRows(items, valueOf, labelOf, { gold = false } = {}) {
  const max = Math.max(...items.map(valueOf), 1);
  return html`<div class="bars">${items.map((it) => html`<div class="bar-row"><span class="bar-row__label" title="${labelOf(it)}">${labelOf(it)}</span>
    <span class="bar ${gold ? 'bar--gold' : ''}"><i style="--w:${pct(valueOf(it), max)}%"></i></span><span class="bar-row__value num">${fmtInt(valueOf(it))}</span></div>`)}</div>`;
}

function render() {
  const now = new Date();
  const d = depot();
  const k = kpis(db(), d.id, { days: D.days, now });
  const evo = evolution(db(), d.id, { days: Math.min(D.days, 90), now });
  const fl = flow(db(), d.id, { days: D.days, now });
  const flMax = Math.max(...fl.flatMap((b) => [b.ins, b.outs]), 1);
  const top = topArticles(db(), d.id, { days: D.days, now });
  const ops = operatorStats(db(), d.id, { days: D.days, now });
  const heat = heatmap(db(), d.id, { days: D.days, now });
  const alerts = reorderList(db(), d.id).slice(0, 5);
  const every = Math.ceil(fl.length / 6);
  const delta = evo.points.at(-1).value - evo.points[0].value;
  const lvl = (v) => (v === 0 ? 0 : Math.min(4, Math.ceil((v / (heat.max || 1)) * 4)));
  const multi = can('depot.any') && Object.keys(db().depots).length > 1;
  return html`<section>
    ${pageHead({ eyebrow: 'Vue d\'ensemble', title: 'Tableau de bord', sub: d.name })}
    <div class="pad pad--tight">${segmented({ action: 'dash.days', value: String(D.days), label: 'Période', items: [{ value: '7', label: '7 jours' }, { value: '30', label: '30 jours' }, { value: '90', label: '90 jours' }] })}</div>
    <div class="kpis">
      ${kpi({ label: 'Références', value: fmtInt(k.refs) })}
      ${kpi({ label: 'Alertes', value: fmtInt(k.alerts), tone: k.alerts ? 'red' : 'green', sub: `${plural(k.zeros, 'épuisé')}`, action: 'dash.alerts' })}
      ${kpi({ label: 'Valeur du stock', value: k.value ? fmtEur(k.value) : '—', tone: 'blue' })}
      ${kpi({ label: 'Taux de service', value: `${k.serviceRate} %`, tone: k.serviceRate < 80 ? 'red' : k.serviceRate < 95 ? 'amber' : 'green' })}
      ${kpi({ label: `Entrées ${D.days} j`, value: `+${fmtInt(k.ins)}`, tone: 'green' })}
      ${kpi({ label: `Sorties ${D.days} j`, value: `−${fmtInt(k.outs)}`, tone: 'red' })}
    </div>

    <section class="card dash-card"><header class="flex flex--between"><h3 class="card__title">Évolution du stock</h3><span class="${delta >= 0 ? 'text-green' : 'text-red'} num">${delta >= 0 ? '+' : ''}${fmtInt(delta)} u</span></header>
      ${lineChart(evo.points.map((p) => ({ label: p.label, value: p.value })), { title: 'Évolution du stock', unit: ' unités' })}
      ${evo.truncated ? html`<p class="muted">Historique conservé limité : le début de la courbe est approximatif.</p>` : ''}</section>

    <section class="card dash-card"><header class="flex flex--between"><h3 class="card__title">Entrées et sorties</h3><span class="legend"><span><i class="legend__sw legend__sw--in"></i>Entrées</span><span><i class="legend__sw legend__sw--out"></i>Sorties</span></span></header>
      <div class="flow" role="img" aria-label="Entrées : ${fmtInt(k.ins)}, sorties : ${fmtInt(k.outs)} sur ${D.days} jours">${fl.map((b, i) => html`<div class="flow__col"><span class="flow__bars"><i class="flow__bar flow__bar--in" style="--h:${pct(b.ins, flMax)}%"></i><i class="flow__bar flow__bar--out" style="--h:${pct(b.outs, flMax)}%"></i></span><span class="flow__lbl">${i % every === 0 ? b.label : ''}</span></div>`)}</div></section>

    ${alerts.length ? html`<section class="card dash-card"><header class="flex flex--between"><h3 class="card__title">À surveiller</h3>${can('stock.adjust') ? html`<a class="btn btn--text" href="#/reorder">Réassort</a>` : ''}</header>
      <ul class="plain-list">${alerts.map((r) => html`<li><button type="button" class="linklike" data-action="article.open" data-ean="${r.article.ean}">${r.article.name}</button><strong class="num ${r.qty === 0 ? 'text-red' : 'text-amber'}">${fmtInt(r.qty)} <span class="muted">/ ${fmtInt(r.threshold)}</span></strong></li>`)}</ul></section>` : ''}

    <section class="card dash-card"><h3 class="card__title">Pièces les plus mouvementées</h3>
      ${top.length ? barRows(top, (t) => t.units, (t) => t.name) : html`<p class="muted">Aucun mouvement sur la période.</p>`}</section>

    <section class="card dash-card"><h3 class="card__title">Activité par opérateur</h3>
      ${ops.length ? html`<ul class="plain-list">${ops.map((o) => html`<li><span class="flex">${avatar(o.name, 'avatar--sm')}<span><strong>${o.name}</strong><br><span class="muted">${fmtInt(o.ins)} entrées · ${fmtInt(o.outs)} sorties</span></span></span><strong class="num">${plural(o.moves, 'mvt')}</strong></li>`)}</ul>` : html`<p class="muted">Aucune activité.</p>`}</section>

    <section class="card dash-card"><h3 class="card__title">Heures d'activité</h3>
      <div class="heat" role="img" aria-label="Carte de chaleur de l'activité par jour et heure">
        <span></span>${Array.from({ length: 24 }, (_, h) => html`<span class="heat__h">${h % 6 === 0 ? `${h}h` : ''}</span>`)}
        ${heat.grid.map((row, i) => html`<span class="heat__d">${DAYS_FR[i]}</span>${row.map((v, h) => html`<i class="heat__c heat__c--l${lvl(v)}" title="${DAYS_FR[i]} ${h}h : ${v}"></i>`)}`)}</div></section>

    ${multi ? html`<section class="card dash-card"><h3 class="card__title">Comparaison des dépôts</h3>
      ${barRows(depotComparison(db(), now), (x) => x.units, (x) => x.depot.code || x.depot.name, { gold: true })}</section>` : ''}
    <p class="pad muted">${icon('info', 'i--sm')} Indicateurs calculés sur les ${D.days} derniers jours, pour le dépôt actif.</p>
  </section>`;
}

export const dashboardRoute = { title: 'Tableau de bord', back: true, render };

export function initDashboard() {
  actions({
    'dash.days': (el) => { D.days = Number(el.dataset.value); refresh(); },
    'dash.alerts': () => { location.hash = '#/articles?f=alert'; },
  });
}
