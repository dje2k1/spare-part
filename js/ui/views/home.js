// Accueil magasinier : la plaque du dépôt (« vous êtes ici », salutation, trois chiffres), la barre « Scanner
// ou rechercher », la ligne des commandes en cours (chaque commande sur le tronçon de son état réel), 4 plaques
// d'action adaptées au dépôt (atelier ou entrepôt central) avec leur compteur, 3 tâches « Aujourd'hui » au plus
// et l'activité de la semaine. Le reste est dans le menu « Plus ».
import { html, fmtInt, fmtLongDate, plural } from '../../lib/text.js';
import { isCode } from '../../lib/ean.js';
import { icon, actions } from '../dom.js';
import { state, db, depot, can } from '../state.js';
import { pendingIncoming, reorderList, kpis, flow, resolveEan } from '../../core/queries.js';
import { atelierOrders, centralQueue, purchaseOverview, briefing, orderLabel } from '../../core/planning.js';
import { APP_LABEL, DEPOT_KINDS } from '../../core/config.js';
import { navigate } from '../router.js';
import { switchDepot, updateChrome } from '../session.js';
import { listenWedge } from '../codebar.js';
import { openArticle } from './article-sheet.js';
import { openBriefing } from '../briefing.js';
import { toast } from '../toast.js';
import { feedback } from '../feedback.js';
import { depotHue } from '../look.js';

let stopWedge = null;
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

/** Trois chiffres sous la plaque : santé du stock, alertes, flux du jour (réception ou préparation). */
function heroStats(d, now) {
  const k = kpis(db(), d.id, { days: 7, now });
  const health = k.serviceRate; // même calcul que le tableau de bord : pièces suivies au-dessus de leur seuil
  const third = d.kind === 'central'
    ? { to: 'orders', value: centralQueue(db(), d.id).toPrepare.length, label: 'À préparer' }
    : { to: 'orders', value: atelierOrders(db(), d.id).toReceive.length + pendingIncoming(db(), d.id).length, label: 'À recevoir' };
  return html`<div class="hstats">
    <a class="hstat" href="#/dashboard"><strong class="hstat__value num">${health}<small>%</small></strong><span class="hstat__label">Stock sain</span></a>
    <a class="hstat ${k.alerts ? 'is-alert' : ''}" href="#/articles?f=alert"><strong class="hstat__value num">${fmtInt(k.alerts)}</strong><span class="hstat__label">${k.alerts > 1 ? 'Alertes' : 'Alerte'}</span></a>
    <a class="hstat" href="#/${third.to}"><strong class="hstat__value num">${fmtInt(third.value)}</strong><span class="hstat__label">${third.label}</span></a>
  </div>`;
}

/** « Atelier Paris – Maroquinerie » → ['Atelier Paris', 'Maroquinerie'] : la plaque porte le lieu, puis le métier. */
function splitName(name) {
  const m = /^(.+?)\s+[–—-]\s+(.+)$/.exec(name);
  return m ? [m[1], m[2]] : [name, ''];
}

/**
 * La ligne des commandes en cours, de l'entrepôt central vers l'atelier (ou vers les ateliers, vue de l'entrepôt).
 * Quatre stations (commande, préparation, expédition, arrivée) ; chaque état occupe le milieu d'un tronçon et y
 * place un « train » : la commande la plus ancienne de cet état, plus le nombre des suivantes.
 */
const STAGES = [['submitted', 1 / 6], ['picking', 3 / 6], ['shipped', 5 / 6]];
function ligne(d) {
  const central = d.kind === 'central';
  if (!Object.values(db().depots).some((x) => x.kind === 'central')) return ''; // dépôt isolé : pas de commandes internes
  let orders;
  if (central) { const q = centralQueue(db(), d.id); orders = [...q.toPrepare, ...q.picking, ...q.shipped]; }
  else { const o = atelierOrders(db(), d.id); orders = [...o.pending, ...o.toReceive]; }
  const words = { submitted: central ? 'à préparer' : 'en attente', picking: 'en préparation', shipped: 'en route' };
  const trains = STAGES.map(([status, x], i) => ({ status, x, i, list: orders.filter((o) => o.status === status) })).filter((t) => t.list.length);
  const sum = trains.map((t) => `${t.list.length} ${words[t.status]}`).join(' · ');
  return html`<a class="ligne ${depotHue(d)}" href="#/orders" data-testid="ligne">
    <span class="ligne__head"><span class="ligne__title">${central ? 'Commandes des ateliers' : 'Commandes en cours'}</span>${sum ? html`<span class="ligne__sum">${sum}</span>` : ''}</span>
    <span class="ligne__track" aria-hidden="true">
      <span class="ligne__rail"></span>
      <span class="ligne__stop ligne__stop--0"></span><span class="ligne__stop ligne__stop--1"></span><span class="ligne__stop ligne__stop--2"></span><span class="ligne__stop ligne__stop--end"></span>
      ${trains.map((t) => html`<span class="ligne__lane" style="--x:${(t.x * 100).toFixed(3)}%;--d:${60 + t.i * 80}ms"><span class="ligne__train" data-status="${t.status}">${orderLabel(t.list[0])}${t.list.length > 1 ? html`<b>+${t.list.length - 1}</b>` : ''}</span></span>`)}
    </span>
    <span class="ligne__stops"><span>Commande</span><span>Préparation</span><span>Expédition</span><span>${central ? 'Ateliers' : splitName(d.name)[0]}</span></span>
    ${orders.length ? '' : html`<span class="ligne__empty">${central ? 'Aucune commande à préparer.' : 'Aucune commande en cours.'}</span>`}
  </a>`;
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
  const [place, trade] = splitName(d.name);
  const kind = DEPOT_KINDS[d.kind]?.label ?? 'Atelier';
  const showKind = !d.name.toLowerCase().includes(kind.toLowerCase());
  return html`
    <section class="home">
      <header class="hero">
        <div class="hero__plaque">
          <h2 class="hero__place">${place}${trade ? html`<small>${trade}</small>` : ''}</h2>
          <p class="hero__hello">${hello} ${u.name.split(' ')[0]} — ${fmtLongDate(now)}</p>
          ${multi || showKind ? html`<div class="hero__where">
            ${multi ? html`<label class="home__depot">${icon(d.kind === 'central' ? 'store' : 'pin', 'i--sm')}<span class="sr-only">Dépôt actif</span>
              <select class="select select--plain" data-change="home.depot" aria-label="Dépôt actif">${Object.values(db().depots).map((x) => html`<option value="${x.id}" ${x.id === d.id ? 'selected' : ''}>${x.name}</option>`)}</select></label>` : ''}
            ${showKind ? html`<span class="hero__kind">${kind}</span>` : ''}
          </div>` : ''}
        </div>
        ${heroStats(d, now)}
      </header>

      <button type="button" class="lookup" data-action="home.lookup" data-testid="lookup">
        ${icon('search')}<span class="lookup__text">Scanner ou rechercher une pièce</span><span class="lookup__scan">${icon('scan')}</span>
      </button>

      ${ligne(d)}

      <nav class="tiles" aria-label="Tâches principales">
        ${tiles().map((t) => html`<a class="tile fam-${t.fam}" href="#/${t.to}" data-testid="${t.testid}">
          <span class="tile__icon">${icon(t.icon)}</span>
          ${t.count ? html`<span class="tile__count num">${fmtInt(t.count)}<span class="sr-only"> à traiter</span></span>` : ''}
          <span><span class="tile__title">${t.title}</span><span class="tile__sub">${t.sub}</span></span></a>`)}
      </nav>

      <section class="today" aria-labelledby="today-title">
        <header class="today__head"><h3 id="today-title">Aujourd'hui</h3>
          ${todo.length > 3 ? html`<button type="button" class="btn btn--text" data-action="home.briefing">Tout voir (${todo.length})</button>` : ''}</header>
        ${todo.length ? html`<ul class="today__list">${todo.slice(0, 3).map((t) => html`<li><a class="today__item today__item--${t.tone}" href="#/${t.to}">
            ${icon(t.icon, 'i--sm')}<span class="grow"><strong>${t.title}</strong>${t.text ? html`<span class="today__text">${t.text}</span>` : ''}</span>${icon('chevron', 'i--sm')}</a></li>`)}</ul>`
          : html`<p class="today__clear">${icon('check', 'i--sm')} Rien d'urgent : tout est à jour.</p>`}
      </section>

      ${activity(d, now)}

      <p class="home__foot"><span class="pill pill--gold" data-testid="version-pill"><span class="pill__dot" aria-hidden="true"></span>${APP_LABEL}</span></p>
    </section>`;
}

export const homeRoute = {
  title: 'Accueil', brand: true, nav: 'home', render,
  mount() {
    // Douchette depuis l'accueil : la fiche de la pièce s'ouvre directement
    stopWedge?.(); // mount est rappelé à chaque rafraîchissement : un seul écouteur à la fois
    stopWedge = listenWedge((code) => {
      if (!isCode(code)) { feedback('error'); toast('Code non reconnu.', { tone: 'error' }); return; }
      feedback('scan');
      const known = resolveEan(db(), code);
      if (known) openArticle(known);
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
