// Commandes : une seule entrée, adaptée au dépôt.
//   Atelier : à réceptionner (livraisons de l'entrepôt), en cours, historique ; bouton « Nouvelle commande ».
//   Entrepôt central : à préparer (plus anciennes d'abord), en préparation, expédiées, historique.
// Toucher une commande ouvre directement le bon écran de travail (réception, préparation) ou son détail.
import { html, fmtInt, fmtDateTime, fmtRelative, plural } from '../../lib/text.js';
import { icon, actions } from '../dom.js';
import { state, db, depot, can, run } from '../state.js';
import { stockOf, pendingIncoming } from '../../core/queries.js';
import { atelierOrders, centralQueue, draftFor, orderLabel, orderUnits } from '../../core/planning.js';
import { cancelOrder } from '../../core/ops-orders.js';
import { ORDER_STATUS } from '../../core/config.js';
import { pageHead, segmented, chips, emptyState } from '../components.js';
import { openSheet, closeSheet, promptDialog, confirmDialog } from '../dialogs.js';
import { printDocument } from '../print.js';
import { navigate, refresh } from '../router.js';
import { toast } from '../toast.js';

const O = { tab: null, depotId: null };
const TONE = { draft: '', submitted: 'pill--info', picking: 'pill--info', shipped: 'pill--low', received: 'pill--ok', cancelled: 'pill--zero', sent: 'pill--info', partial: 'pill--low', closed: 'pill--ok' };
export const statusPill = (o) => html`<span class="pill ${TONE[o.status] ?? ''}">${ORDER_STATUS[o.status]}</span>`;

const depotName = (id) => db().depots[id]?.name ?? '—';

function orderRow(o, { central = false } = {}) {
  const who = central ? depotName(o.depotId) : o.kind === 'supplier' ? db().suppliers[o.supplierId]?.name : depotName(o.sourceId);
  const units = o.status === 'shipped' || o.status === 'received' ? orderUnits(o, o.status === 'received' ? 'received' : 'shipped') : orderUnits(o);
  const when = { submitted: o.submittedAt, picking: o.pickingAt, shipped: o.shippedAt, received: o.receivedAt, cancelled: o.cancelledAt }[o.status] ?? o.createdAt;
  const short = central && (o.status === 'submitted' || o.status === 'picking') && o.lines.some((l) => stockOf(db(), o.sourceId, l.ean) < l.qty);
  return html`<li><button type="button" class="row order-row" data-action="orders.open" data-id="${o.id}">
    <span class="row__lead order-row__no num">${o.no || '—'}</span>
    <span class="row__body"><span class="row__title">${who}</span>
      <span class="row__meta">${plural(o.lines.length, 'ligne')} · ${plural(units, 'pièce')} · ${fmtRelative(when)}${o.status === 'picking' && o.pickedBy ? ` · ${o.pickedBy}` : ''}${o.backorderOf ? ' · reliquat' : ''}</span>
      ${short ? html`<span class="row__meta text-amber">${icon('alert', 'i--sm')} Stock insuffisant pour certaines lignes</span>` : ''}
      ${o.status === 'cancelled' && o.reason ? html`<span class="row__meta text-red">${o.reason}</span>` : ''}
      ${o.gaps ? html`<span class="row__meta text-amber">${plural(o.gaps, 'écart')} à la réception</span>` : ''}</span>
    <span class="row__trail">${statusPill(o)}</span></button></li>`;
}

function render() {
  const d = depot();
  if (O.depotId !== d.id) { O.tab = null; O.depotId = d.id; }
  return d.kind === 'central' ? renderCentral(d) : renderAtelier(d);
}

function renderAtelier(d) {
  const o = atelierOrders(db(), d.id);
  const draft = draftFor(db(), d.id);
  const transfers = pendingIncoming(db(), d.id).length;
  O.tab ??= o.toReceive.length ? 'receive' : o.pending.length ? 'pending' : 'receive';
  const items = [
    { value: 'receive', label: 'À recevoir', badge: o.toReceive.length || '' },
    { value: 'pending', label: 'En cours', badge: '' },
    { value: 'past', label: 'Historique' },
  ];
  const list = { receive: o.toReceive, pending: o.pending, past: o.past.slice(0, 50) }[O.tab];
  const empty = {
    receive: emptyState({ icon: 'inbox', title: 'Aucune livraison attendue', text: 'Les commandes expédiées par l\'entrepôt apparaîtront ici.', action: can('move') ? html`<a class="btn btn--secondary btn--sm" href="#/scan/in">${icon('in', 'i--sm')}Entrée hors commande</a>` : '' }),
    pending: emptyState({ icon: 'truck', title: 'Aucune commande en cours', text: 'Créez une commande à partir des pièces à réapprovisionner.' }),
    past: emptyState({ icon: 'clock', title: 'Aucun historique' }),
  }[O.tab];
  return html`<section>
    ${pageHead({ eyebrow: 'Approvisionnement', title: 'Commandes', sub: `${d.name} ← ${Object.values(db().depots).find((x) => x.kind === 'central')?.name ?? 'aucun entrepôt central'}` })}
    ${can('order.request') ? html`<div class="pad pad--tight"><a class="btn btn--primary btn--block" href="#/order" data-testid="new-order">${icon('cart')}${draft ? `Panier en cours · ${plural(draft.lines.length, 'ligne')}` : 'Nouvelle commande'}</a></div>` : ''}
    ${transfers ? html`<a class="banner banner--info banner--link" href="#/transfers">${icon('swap', 'i--sm')}<span class="banner__text">${plural(transfers, 'transfert')} d'un autre atelier à réceptionner</span>${icon('chevron', 'i--sm')}</a>` : ''}
    <div class="pad">${segmented({ action: 'orders.tab', value: O.tab, items, label: 'Commandes' })}</div>
    ${list.length ? html`<ul class="list">${list.map((x) => orderRow(x))}</ul>` : empty}
  </section>`;
}

function renderCentral(d) {
  const q = centralQueue(db(), d.id);
  const mine = q.picking.filter((x) => x.pickedBy === state.session.user.name);
  O.tab ??= mine.length ? 'picking' : 'prepare';
  const items = [
    { value: 'prepare', label: 'À préparer', count: q.toPrepare.length },
    { value: 'picking', label: 'En préparation', count: q.picking.length },
    { value: 'shipped', label: 'Expédiées', count: q.shipped.length },
    { value: 'past', label: 'Historique' },
  ];
  const list = { prepare: q.toPrepare, picking: q.picking, shipped: q.shipped, past: q.past.slice(0, 50) }[O.tab];
  return html`<section>
    ${pageHead({ eyebrow: 'Entrepôt central', title: 'Commandes des ateliers', sub: d.name,
      actions: can('purchase.manage') ? html`<a class="btn btn--secondary btn--sm" href="#/purchases">${icon('cart', 'i--sm')}Fournisseurs</a>` : '' })}
    ${chips({ action: 'orders.tab', value: O.tab, items, label: 'Commandes' })}
    ${list.length ? html`<ul class="list">${list.map((x) => orderRow(x, { central: true }))}</ul>`
      : emptyState({ icon: 'box', title: O.tab === 'prepare' ? 'Rien à préparer' : 'Aucune commande', text: O.tab === 'prepare' ? 'Les commandes envoyées par les ateliers apparaîtront ici, les plus anciennes en premier.' : '' })}
  </section>`;
}

export const ordersRoute = { title: 'Commandes', nav: 'orders', render };

// ── Détail d'une commande ──
const STEPS = [['submittedAt', 'submittedBy', 'Envoyée'], ['pickingAt', 'pickedBy', 'Préparation'], ['shippedAt', 'shippedBy', 'Expédiée'], ['receivedAt', 'receivedBy', 'Reçue']];

export function openOrder(id) {
  const o = db().orders[id];
  if (!o) return;
  const d = depot();
  const atCentral = d.id === o.sourceId;
  const shipped = o.status === 'shipped' || o.status === 'received';
  const canCancel = !atCentral && o.status === 'submitted' && can('order.request');
  const canRefuse = atCentral && (o.status === 'submitted' || o.status === 'picking') && can('order.manage');
  openSheet({
    title: `${orderLabel(o)} · ${atCentral ? depotName(o.depotId) : depotName(o.sourceId)}`,
    body: html`
      <p>${statusPill(o)}${o.backorderOf ? html` <span class="pill">Reliquat de ${orderLabel(db().orders[o.backorderOf] ?? { kind: 'internal', no: '?' })}</span>` : ''}</p>
      ${o.note ? html`<p class="muted order-note">${icon('info', 'i--sm')} ${o.note}</p>` : ''}
      ${o.status === 'cancelled' ? html`<p class="banner banner--error">${icon('alert', 'i--sm')}<span class="banner__text">Annulée par ${o.cancelledBy ?? '—'}${o.reason ? ` : ${o.reason}` : ''}</span></p>` : ''}
      <ol class="timeline">${STEPS.filter(([at]) => o[at]).map(([at, by, label]) => html`<li><strong>${label}</strong> <span class="muted">${fmtDateTime(o[at])}${o[by] ? ` · ${o[by]}` : ''}</span></li>`)}</ol>
      <table class="lines"><thead><tr><th>Pièce</th><th class="num">Dem.</th>${shipped ? html`<th class="num">Exp.</th>` : ''}${o.status === 'received' ? html`<th class="num">Reçu</th>` : ''}</tr></thead>
        <tbody>${o.lines.map((l) => html`<tr class="${o.status === 'received' && l.received !== l.shipped ? 'lines__gap' : ''}"><td>${l.name}<span class="muted lines__ean num">${l.ean}</span></td><td class="num">${fmtInt(l.qty)}</td>${shipped ? html`<td class="num">${fmtInt(l.shipped ?? 0)}</td>` : ''}${o.status === 'received' ? html`<td class="num">${fmtInt(l.received ?? 0)}</td>` : ''}</tr>`)}</tbody></table>`,
    foot: html`
      ${shipped ? html`<button type="button" class="btn btn--secondary" data-action="orders.slip" data-id="${o.id}">${icon('printer', 'i--sm')}Bon</button>` : ''}
      ${canCancel ? html`<button type="button" class="btn btn--danger" data-action="orders.cancel" data-id="${o.id}">Annuler</button>` : ''}
      ${canRefuse ? html`<button type="button" class="btn btn--danger" data-action="orders.refuse" data-id="${o.id}">Refuser</button>` : ''}
      ${o.status === 'shipped' && !atCentral && can('order.receive') ? html`<button type="button" class="btn btn--primary" data-action="orders.go" data-to="receive/${o.id}">Réceptionner</button>` : ''}
      ${(o.status === 'submitted' || o.status === 'picking') && atCentral && can('order.fulfil') ? html`<button type="button" class="btn btn--primary" data-action="orders.go" data-to="pick/${o.id}">Préparer</button>` : ''}`,
  });
}

/** Bon de livraison (expédition) ou de réception, imprimable. */
export function printSlip(o) {
  const received = o.status === 'received';
  printDocument({
    title: received ? 'Bon de réception' : 'Bon de livraison',
    subtitle: `${orderLabel(o)} · ${depotName(o.sourceId)} → ${depotName(o.depotId)}`,
    meta: [o.shippedAt && `expédiée le ${fmtDateTime(o.shippedAt)} par ${o.shippedBy}`, received && `reçue le ${fmtDateTime(o.receivedAt)} par ${o.receivedBy}`].filter(Boolean).join(' · '),
    columns: [{ label: 'EAN' }, { label: 'Désignation' }, { label: 'Demandé', num: true }, { label: 'Expédié', num: true }, ...(received ? [{ label: 'Reçu', num: true }] : [])],
    rows: o.lines.map((l) => [l.ean, l.name, l.qty, l.shipped ?? 0, ...(received ? [l.received ?? 0] : [])]),
    alert: new Set(o.lines.map((l, i) => ((received ? l.received !== l.shipped : (l.shipped ?? 0) < l.qty) ? i : -1)).filter((i) => i >= 0)),
    notes: o.note || '',
    signatures: true,
  });
}

export function initOrders() {
  actions({
    'orders.tab': (el) => { O.tab = el.dataset.value; refresh(); },
    'orders.open'(el) {
      const o = db().orders[el.dataset.id];
      if (!o) return;
      const d = depot();
      if (o.kind === 'internal' && o.status === 'shipped' && d.id === o.depotId && can('order.receive')) return navigate(`receive/${o.id}`);
      if (o.kind === 'internal' && (o.status === 'submitted' || o.status === 'picking') && d.id === o.sourceId && can('order.fulfil')) return navigate(`pick/${o.id}`);
      return openOrder(o.id);
    },
    async 'orders.go'(el) { await closeSheet(); navigate(el.dataset.to); },
    'orders.slip': (el) => printSlip(db().orders[el.dataset.id]),
    async 'orders.cancel'(el) {
      if (!(await confirmDialog({ title: 'Annuler la commande ?', message: 'L\'entrepôt ne la préparera pas.', confirmLabel: 'Annuler la commande', cancelLabel: 'Garder', danger: true }))) return;
      run(cancelOrder, { id: el.dataset.id });
      await closeSheet(); toast('Commande annulée.'); refresh();
    },
    async 'orders.refuse'(el) {
      const reason = await promptDialog({ title: 'Refuser la commande', label: 'Motif (affiché à l\'atelier)', confirmLabel: 'Refuser', validate: (v) => (v.trim() ? '' : 'Le motif est obligatoire.') });
      if (!reason) return;
      run(cancelOrder, { id: el.dataset.id, reason });
      await closeSheet(); toast('Commande refusée : l\'atelier est informé.'); refresh();
    },
  });
}
