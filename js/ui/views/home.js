// Accueil magasinier : un héros (salutation, dépôt, trois indicateurs), la barre « Scanner ou rechercher »,
// 4 grandes tuiles adaptées au dépôt (atelier ou entrepôt central) avec leur compteur, 3 lignes
// « Aujourd'hui » au plus et l'activité de la semaine. Le reste est dans le menu « Plus ».
import { html, fmtInt, fmtLongDate, plural } from '../../lib/text.js';
import { isCode } from '../../lib/ean.js';
import { icon, actions, $$ } from '../dom.js';
import { state, db, depot, can } from '../state.js';
import { pendingIncoming, reorderList, kpis, flow } from '../../core/queries.js';
import { atelierOrders, centralQueue, purchaseOverview, briefing } from '../../core/planning.js';
import { APP_LABEL, DEPOT_KINDS } from '../../core/config.js';
import { navigate } from '../router.js';
import { switchDepot, updateChrome } from '../session.js';
import { listenWedge } from '../codebar.js';
import { openArticle } from './article-sheet.js';
import { openBriefing } from '../briefing.js';
import { toast } from '../toast.js';
import { feedback } from '../feedback.js';

let stopWedge = null;
const RING = 2 * Math.PI * 20; // circonférence de l'anneau « stock sain » (r = 20)
const DAYS = ['D', 'L', 'M', 'M', 'J', 'V', 'S'];

/** Tuiles du dépôt actif : [{to, icon, fam, title, sub, count}] */
function tiles() {
  const d = depot();
  const out = [];
  if (d.kind === 'central') {
    const q = centralQueue(db(), d.id);
    const p = purchaseOverview(db(), d.id);
    out.push({ to: q.toPrepare.length === 1 && !q.picking.length ? `pick/${q.toPrepare[0].id}` : 'orders', icon: 'box', fam: 'blue', title: 'Préparer', sub: 'Commandes des ateliers', count: q.toPrepare.length + q.picking.length, testid: 'tile-prepare' });
    out.push({ to: 'purchases?tab=open', icon: 'inbox', fam: 'green', title: 'Réceptionner', sub: 'Livraisons fournisseurs', count: p.open.length, testid: 'tile-receive' });
    out.push({ to: 'scan/out', icon: 'out', fam: 'red', title: 'Sortir', sub: 'Consommation, casse', count: 0, testid: 'tile-out' });
    if (can('purchase.manage')) out.push({ to: 'purchases?tab=buy', icon: 'cart', fam: 'amber', title: 'Commander', sub: 'Aux fournisseurs', count: reorderList(db(), d.id).length, testid: 'tile-order' });
    else out.push({ to: 'scan/in', icon: 'in', fam: 'teal', title: 'Entrée', sub: 'Hors commande', count: 0, testid: 'tile-in' });
  } else {
    const o = atelierOrders(db(), d.id);
    const incoming = o.toReceive.length + pendingIncoming(db(), d.id).length;
    out.push({ to: o.toReceive.length === 1 && !pendingIncoming(db(), d.id).length ? `receive/${o.toReceive[0].id}` : 'orders', icon: 'inbox', fam: 'green', title: 'Réceptionner', sub: 'Livraisons de l\'entrepôt', count: incoming, testid: 'tile-receive' });
    out.push({ to: 'scan/out', icon: 'out', fam: 'red', title: 'Sortir', sub: 'Consommation, casse', count: 0, testid: 'tile-out' });
    if (can('order.request')) out.push({ to: 'order', icon: 'cart', fam: 'amber', title: 'Commander', sub: 'À l\'entrepôt central', count: reorderList(db(), d.id, { withDraft: true }).length, testid: 'tile-order' });
    if (can('inventory')) out.push({ to: 'inventory', icon: 'clipboard', fam: 'violet', title: 'Inventaire', sub: 'Comptage guidé', count: 0, testid: 'tile-inventory' });
    else out.push({ to: 'scan/in', icon: 'in', fam: 'teal', title: 'Entrée', sub: 'Hors commande', count: 0, testid: 'tile-in' });
  }
  return out;
}

/** Trois indicateurs du héros : santé du stock (anneau), alertes, flux du jour (réception ou préparation). */
function heroStats(d, now) {
  const k = kpis(db(), d.id, { days: 7, now });
  const health = k.refs ? Math.round(((k.refs - k.alerts) / k.refs) * 100) : 100;
  const third = d.kind === 'central'
    ? { to: 'orders', value: centralQueue(db(), d.id).toPrepare.length, label: 'À préparer' }
    : { to: 'orders', value: atelierOrders(db(), d.id).toReceive.length + pendingIncoming(db(), d.id).length, label: 'À recevoir' };
  return html`<div class="hstats">
    <a class="hstat hstat--ring" href="#/dashboard">
      <span class="ring-wrap"><svg class="ring" viewBox="0 0 48 48" aria-hidden="true"><circle class="ring__track" cx="24" cy="24" r="20"/><circle class="ring__value" cx="24" cy="24" r="20" stroke-dasharray="${RING.toFixed(2)}" stroke-dashoffset="${(RING * (1 - health / 100)).toFixed(2)}"/></svg>
        <strong class="ring__pct num"><span data-count="${health}">${health}</span><small>%</small></strong></span>
      <span class="hstat__label">Stock sain</span></a>
    <a class="hstat ${k.alerts ? 'is-alert' : ''}" href="#/articles?f=alert"><strong class="hstat__value num" data-count="${k.alerts}">${fmtInt(k.alerts)}</strong><span class="hstat__label">${k.alerts > 1 ? 'Alertes' : 'Alerte'}</span></a>
    <a class="hstat" href="#/${third.to}"><strong class="hstat__value num" data-count="${third.value}">${fmtInt(third.value)}</strong><span class="hstat__label">${third.label}</span></a>
  </div>`;
}

/** Entrées et sorties des 7 derniers jours (barres animées). */
function activity(d, now) {
  const days = flow(db(), d.id, { days: 7, now });
  const max = Math.max(1, ...days.flatMap((b) => [b.ins, b.outs]));
  const pct = (v) => (v ? Math.max(6, Math.round((v / max) * 100)) : 0);
  const ins = days.reduce((n, b) => n + b.ins, 0);
  const outs = days.reduce((n, b) => n + b.outs, 0);
  return html`<section class="card activity" aria-labelledby="activity-title">
    <header class="activity__head"><h3 class="card__title" id="activity-title">Cette semaine</h3>
      <span class="activity__tot num"><span class="text-green">+${fmtInt(ins)}</span> · <span class="text-red">−${fmtInt(outs)}</span></span></header>
    <div class="activity__bars" role="img" aria-label="${plural(ins, 'pièce')} entrée${ins > 1 ? 's' : ''} et ${plural(outs, 'pièce')} sortie${outs > 1 ? 's' : ''} sur 7 jours">
      ${days.map((b, i) => html`<div class="activity__day ${i === days.length - 1 ? 'is-today' : ''}">
        <span class="activity__cols"><i class="activity__in" style="--h:${pct(b.ins)}%"></i><i class="activity__out" style="--h:${pct(b.outs)}%"></i></span>
        <span class="activity__lbl" aria-hidden="true">${DAYS[new Date(now.getTime() - (days.length - 1 - i) * 86_400_000).getDay()]}</span></div>`)}
    </div>
    <p class="activity__legend"><span><i class="is-in"></i>Entrées</span><span><i class="is-out"></i>Sorties</span></p>
  </section>`;
}

function render() {
  const d = depot();
  const u = state.session.user;
  const now = new Date();
  const todo = briefing(db(), { depotId: d.id, role: u.role, now });
  const multi = can('depot.any') && Object.keys(db().depots).length > 1;
  const hello = now.getHours() >= 18 ? 'Bonsoir' : 'Bonjour';
  return html`
    <section class="home">
      <header class="hero">
        <p class="hero__date">${fmtLongDate(now)}</p>
        <h2 class="hero__hello">${hello}, <em>${u.name.split(' ')[0]}</em></h2>
        <div class="hero__where">
          ${multi
            ? html`<label class="home__depot">${icon(d.kind === 'central' ? 'store' : 'pin', 'i--sm')}<span class="sr-only">Dépôt actif</span>
              <select class="select select--plain" data-change="home.depot" aria-label="Dépôt actif">${Object.values(db().depots).map((x) => html`<option value="${x.id}" ${x.id === d.id ? 'selected' : ''}>${x.name}</option>`)}</select></label>`
            : html`<p class="home__depot">${icon(d.kind === 'central' ? 'store' : 'pin', 'i--sm')}<span>${d.name}</span></p>`}
          ${d.name.toLowerCase().includes((DEPOT_KINDS[d.kind]?.label ?? '').toLowerCase()) ? '' : html`<span class="hero__kind">${DEPOT_KINDS[d.kind]?.label ?? 'Atelier'}</span>`}
        </div>
        ${heroStats(d, now)}
      </header>

      <button type="button" class="lookup" data-action="home.lookup" data-testid="lookup">
        ${icon('search')}<span class="lookup__text">Scanner ou rechercher une pièce</span><span class="lookup__scan">${icon('scan')}</span>
      </button>

      <nav class="tiles" aria-label="Tâches principales">
        ${tiles().map((t) => html`<a class="tile fam-${t.fam}" href="#/${t.to}" data-testid="${t.testid}">
          <span class="tile__art" aria-hidden="true">${icon(t.icon)}</span>
          <span class="tile__icon">${icon(t.icon, 'i--lg')}</span>
          ${t.count ? html`<span class="tile__count num">${fmtInt(t.count)}<span class="sr-only"> à traiter</span></span>` : ''}
          <span><span class="tile__title">${t.title}</span><span class="tile__sub">${t.sub}</span></span></a>`)}
      </nav>

      <section class="today" aria-labelledby="today-title">
        <header class="today__head"><h3 class="eyebrow" id="today-title">Aujourd'hui</h3>
          ${todo.length > 3 ? html`<button type="button" class="btn btn--text" data-action="home.briefing">Tout voir (${todo.length})</button>` : ''}</header>
        ${todo.length ? html`<ul class="today__list">${todo.slice(0, 3).map((t) => html`<li><a class="today__item today__item--${t.tone}" href="#/${t.to}">
            ${icon(t.icon, 'i--sm')}<span class="grow"><strong>${t.title}</strong>${t.text ? html`<span class="today__text">${t.text}</span>` : ''}</span>${icon('chevron', 'i--sm')}</a></li>`)}</ul>`
          : html`<p class="today__clear">${icon('check', 'i--sm')} Rien d'urgent : tout est à jour.</p>`}
      </section>

      ${activity(d, now)}

      <p class="home__foot"><span class="pill pill--gold" data-testid="version-pill"><span class="pill__dot" aria-hidden="true"></span>${APP_LABEL}</span></p>
    </section>`;
}

/** Compteurs qui défilent jusqu'à leur valeur à l'arrivée sur l'accueil (sauf mouvement réduit). */
function countUp(root) {
  if (!root.classList.contains('is-entering') || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const start = performance.now() + 150;
  const els = $$('[data-count]', root).map((el) => ({ el, to: Number(el.dataset.count) || 0, text: el.textContent })).filter((x) => x.to > 1);
  if (!els.length) return;
  els.forEach((x) => { x.el.textContent = '0'; });
  const step = (t) => {
    const p = Math.min(1, Math.max(0, (t - start) / 900));
    const e = 1 - (1 - p) ** 3;
    els.forEach((x) => { x.el.textContent = p >= 1 ? x.text : fmtInt(Math.round(x.to * e)); });
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

export const homeRoute = {
  title: 'Accueil', brand: true, nav: 'home', render,
  mount(root) {
    countUp(root);
    // Douchette depuis l'accueil : la fiche de la pièce s'ouvre directement
    stopWedge?.(); // mount est rappelé à chaque rafraîchissement : un seul écouteur à la fois
    stopWedge = listenWedge((code) => {
      if (!isCode(code)) { feedback('error'); toast('Code non reconnu.', { tone: 'error' }); return; }
      feedback('scan');
      if (db().articles[code]) openArticle(code);
      else toast(`Code ${code} inconnu du catalogue.`, { tone: 'error', action: can('article.create') ? { label: 'Créer', run: () => navigate('scan/in', { params: { ean: code } }) } : undefined });
    });
  },
  unmount() { stopWedge?.(); stopWedge = null; },
};

export function initHome() {
  actions({
    'home.lookup': () => navigate('scan/find'),
    'home.briefing': () => openBriefing(),
    'home.depot': (el) => { switchDepot(el.value); updateChrome(); navigate('home', { replace: true }); },
  });
}
