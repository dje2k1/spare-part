// Accueil magasinier : une barre « Scanner ou rechercher », 4 grandes tuiles adaptées au dépôt
// (atelier ou entrepôt central) avec leur compteur, et 3 lignes « Aujourd'hui » au plus.
// Tout le reste (tableaux de bord, journaux, réglages) est dans le menu « Plus ».
import { html, fmtInt } from '../../lib/text.js';
import { isCode } from '../../lib/ean.js';
import { icon, actions } from '../dom.js';
import { state, db, depot, can } from '../state.js';
import { pendingIncoming, reorderList } from '../../core/queries.js';
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

/** Tuiles du dépôt actif : [{to, icon, tone, title, sub, count}] */
function tiles() {
  const d = depot();
  const out = [];
  if (d.kind === 'central') {
    const q = centralQueue(db(), d.id);
    const p = purchaseOverview(db(), d.id);
    out.push({ to: q.toPrepare.length === 1 && !q.picking.length ? `pick/${q.toPrepare[0].id}` : 'orders', icon: 'box', tone: 'blue', title: 'Préparer', sub: 'Commandes des ateliers', count: q.toPrepare.length + q.picking.length, testid: 'tile-prepare' });
    out.push({ to: 'purchases?tab=open', icon: 'inbox', tone: 'green', title: 'Réceptionner', sub: 'Livraisons fournisseurs', count: p.open.length, testid: 'tile-receive' });
    out.push({ to: 'scan/out', icon: 'out', tone: 'red', title: 'Sortir', sub: 'Consommation, casse', count: 0, testid: 'tile-out' });
    if (can('purchase.manage')) out.push({ to: 'purchases?tab=buy', icon: 'cart', tone: 'gold', title: 'Commander', sub: 'Aux fournisseurs', count: reorderList(db(), d.id).length, testid: 'tile-order' });
    else out.push({ to: 'scan/in', icon: 'in', tone: 'green', title: 'Entrée', sub: 'Hors commande', count: 0, testid: 'tile-in' });
  } else {
    const o = atelierOrders(db(), d.id);
    const incoming = o.toReceive.length + pendingIncoming(db(), d.id).length;
    out.push({ to: o.toReceive.length === 1 && !pendingIncoming(db(), d.id).length ? `receive/${o.toReceive[0].id}` : 'orders', icon: 'inbox', tone: 'green', title: 'Réceptionner', sub: 'Livraisons de l\'entrepôt', count: incoming, testid: 'tile-receive' });
    out.push({ to: 'scan/out', icon: 'out', tone: 'red', title: 'Sortir', sub: 'Consommation, casse', count: 0, testid: 'tile-out' });
    if (can('order.request')) out.push({ to: 'order', icon: 'cart', tone: 'gold', title: 'Commander', sub: 'À l\'entrepôt central', count: reorderList(db(), d.id, { withDraft: true }).length, testid: 'tile-order' });
    if (can('inventory')) out.push({ to: 'inventory', icon: 'clipboard', tone: 'amber', title: 'Inventaire', sub: 'Comptage guidé', count: 0, testid: 'tile-inventory' });
    else out.push({ to: 'scan/in', icon: 'in', tone: 'green', title: 'Entrée', sub: 'Hors commande', count: 0, testid: 'tile-in' });
  }
  return out;
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
      <header class="home__head">
        <div class="grow">
          <p class="home__hello">${hello}, <strong>${u.name.split(' ')[0]}</strong></p>
          ${multi
            ? html`<label class="home__depot">${icon(d.kind === 'central' ? 'store' : 'pin', 'i--sm')}<span class="sr-only">Dépôt actif</span>
              <select class="select select--plain" data-change="home.depot" aria-label="Dépôt actif">${Object.values(db().depots).map((x) => html`<option value="${x.id}" ${x.id === d.id ? 'selected' : ''}>${x.name}</option>`)}</select></label>`
            : html`<p class="home__depot">${icon(d.kind === 'central' ? 'store' : 'pin', 'i--sm')}<span>${d.name}</span></p>`}
        </div>
        <span class="pill ${d.kind === 'central' ? 'pill--info' : 'pill--gold'}">${DEPOT_KINDS[d.kind]?.label ?? 'Atelier'}</span>
      </header>

      <button type="button" class="lookup" data-action="home.lookup" data-testid="lookup">
        ${icon('search')}<span class="lookup__text">Scanner ou rechercher une pièce</span><span class="lookup__scan">${icon('scan')}</span>
      </button>

      <nav class="tiles" aria-label="Tâches principales">
        ${tiles().map((t) => html`<a class="tile tile--${t.tone}" href="#/${t.to}" data-testid="${t.testid}">
          <span class="tile__icon">${icon(t.icon, 'i--lg')}</span>
          ${t.count ? html`<span class="tile__count num">${fmtInt(t.count)}<span class="sr-only"> à traiter</span></span>` : ''}
          <span class="tile__title">${t.title}</span><span class="tile__sub">${t.sub}</span></a>`)}
      </nav>

      <section class="today" aria-labelledby="today-title">
        <header class="today__head"><h3 class="eyebrow" id="today-title">Aujourd'hui</h3>
          ${todo.length > 3 ? html`<button type="button" class="btn btn--text" data-action="home.briefing">Tout voir (${todo.length})</button>` : ''}</header>
        ${todo.length ? html`<ul class="today__list">${todo.slice(0, 3).map((t) => html`<li><a class="today__item today__item--${t.tone}" href="#/${t.to}">
            ${icon(t.icon, 'i--sm')}<span class="grow"><strong>${t.title}</strong>${t.text ? html`<span class="today__text">${t.text}</span>` : ''}</span>${icon('chevron', 'i--sm')}</a></li>`)}</ul>`
          : html`<p class="today__clear">${icon('check', 'i--sm')} Rien d'urgent : tout est à jour.</p>`}
      </section>

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
