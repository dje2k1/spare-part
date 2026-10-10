// Transferts inter-dépôts : à recevoir, en transit, historique. Réceptionner · refuser · annuler.
import { html, fmtInt, fmtDateTime, fmtRelative, plural } from '../../lib/text.js';
import { icon, actions } from '../dom.js';
import { db, depot, can, state, run } from '../state.js';
import { transferOverview } from '../../core/queries.js';
import { receiveTransfer, refuseTransfer, cancelTransfer } from '../../core/ops.js';
import { TRANSFER_STATUS } from '../../core/config.js';
import { pageHead, segmented, emptyState } from '../components.js';
import { confirmDialog } from '../dialogs.js';
import { refresh } from '../router.js';
import { toast } from '../toast.js';

let tab = null;

const canAct = (depotId) => can('depot.any') || state.session.user.depotId === depotId;

function card(t, kind) {
  const outgoing = kind === 'out';
  const mine = t.operatorId === state.session.user.id;
  return html`
    <li class="tr-card">
      <div class="tr-card__top"><strong class="tr-card__name">${t.name}</strong><span class="tr-card__qty num">${fmtInt(t.qty)}</span></div>
      <p class="tr-card__route"><span class="tr-card__rail" aria-hidden="true"></span><span>${t.fromDepotName}</span><span><span class="sr-only">vers </span>${t.toDepotName}</span></p>
      <p class="muted tr-card__meta">${fmtRelative(t.date)} · ${t.operator}</p>
      ${kind === 'in' && can('transfer.receive') && canAct(t.toDepotId) ? html`<div class="tr-card__actions">
        <button type="button" class="btn btn--primary btn--sm" data-action="tr.receive" data-id="${t.id}">${icon('check', 'i--sm')}Réceptionner</button>
        <button type="button" class="btn btn--ghost btn--sm" data-action="tr.refuse" data-id="${t.id}">Refuser</button></div>` : ''}
      ${outgoing && canAct(t.fromDepotId) && (mine || can('transfer.cancel')) ? html`<div class="tr-card__actions"><button type="button" class="btn btn--secondary btn--sm" data-action="tr.cancel" data-id="${t.id}">Annuler le transfert</button></div>` : ''}
    </li>`;
}

function pastRow(t) {
  const tone = { done: 'pill--ok', cancelled: '', refused: 'pill--zero' }[t.status] ?? '';
  const when = t.receivedDate || t.cancelledDate || t.date;
  return html`<li class="row"><span class="row__body"><span class="row__title">${t.name}</span>
    <span class="row__meta">${t.fromDepotName} → ${t.toDepotName} · ${fmtDateTime(when)}${t.receivedBy ? ` · reçu par ${t.receivedBy}` : t.cancelledBy ? ` · ${t.cancelledBy}` : ''}</span></span>
    <span class="row__trail"><span class="row__qty num">${fmtInt(t.qty)}</span><span class="pill ${tone}">${TRANSFER_STATUS[t.status]}</span></span></li>`;
}

function render() {
  const o = transferOverview(db(), depot().id);
  if (!tab) tab = o.incoming.length ? 'in' : o.outgoing.length ? 'out' : 'past';
  const items = [
    { value: 'in', label: 'À recevoir', badge: o.incoming.length || '' },
    { value: 'out', label: 'En transit' },
    { value: 'past', label: 'Historique' },
  ];
  const content = {
    in: o.incoming.length ? html`<ul class="tr-list">${o.incoming.map((t) => card(t, 'in'))}</ul>` : emptyState({ icon: 'swap', title: 'Rien à recevoir', text: 'Les transferts envoyés vers ce dépôt apparaîtront ici.' }),
    out: o.outgoing.length ? html`<ul class="tr-list">${o.outgoing.map((t) => card(t, 'out'))}</ul>` : emptyState({ icon: 'swap', title: 'Aucun transfert en transit', text: 'Créez un transfert depuis l\'écran de scan.' }),
    past: o.past.length ? html`<p class="pad muted">${plural(o.received30d, 'transfert')} reçu${o.received30d > 1 ? 's' : ''} ces 30 jours${o.avgDelayHours !== null ? ` · délai moyen ${o.avgDelayHours} h` : ''}</p><ul class="list">${o.past.slice(0, 60).map(pastRow)}</ul>` : emptyState({ icon: 'clock', title: 'Aucun historique' }),
  }[tab];
  return html`<section>${pageHead({ eyebrow: 'Entre dépôts', title: 'Transferts', sub: depot().name })}
    <div class="pad">${segmented({ action: 'tr.tab', value: tab, items, label: 'Type de transferts' })}</div>${content}</section>`;
}

export const transfersRoute = { title: 'Transferts', back: true, render };

export function initTransfers() {
  actions({
    'tr.tab': (el) => { tab = el.dataset.value; refresh(); },
    'tr.receive': (el) => {
      const r = run(receiveTransfer, { id: el.dataset.id });
      toast(`Réceptionné · stock ${fmtInt(r.stock)}`, { tone: 'ok' });
    },
    async 'tr.refuse'(el) {
      if (!(await confirmDialog({ title: 'Refuser ce transfert ?', message: 'Les pièces retournent au stock du dépôt expéditeur.', confirmLabel: 'Refuser', danger: true }))) return;
      run(refuseTransfer, { id: el.dataset.id });
      toast('Transfert refusé : stock restitué à l\'expéditeur.');
    },
    async 'tr.cancel'(el) {
      if (!(await confirmDialog({ title: 'Annuler ce transfert ?', message: 'Les pièces reviennent dans le stock de ce dépôt.', confirmLabel: 'Annuler le transfert', cancelLabel: 'Conserver', danger: true }))) return;
      run(cancelTransfer, { id: el.dataset.id });
      toast('Transfert annulé : stock restitué.', { tone: 'ok' });
    },
  });
}
