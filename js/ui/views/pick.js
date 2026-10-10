// Préparation d'une commande d'atelier à l'entrepôt central : prise en charge (personne d'autre ne la
// prépare en même temps), liste triée par emplacement (tournée de prélèvement), contrôle par scan,
// quantités limitées au stock disponible, expédition avec reliquat automatique, bon de livraison.
import { html, fmtInt, fmtRelative, plural } from '../../lib/text.js';
import { isCode } from '../../lib/ean.js';
import { icon, actions, $, setHtml, val, whenReleased } from '../dom.js';
import { state, db, can, run } from '../state.js';
import { locCode, stockOf } from '../../core/queries.js';
import { pickList, orderLabel } from '../../core/planning.js';
import { claimOrder, releaseOrder, shipOrder, cancelOrder } from '../../core/ops-orders.js';
import { pageHead, emptyState } from '../components.js';
import { confirmDialog, promptDialog } from '../dialogs.js';
import { navigate } from '../router.js';
import { toast } from '../toast.js';
import { feedback } from '../feedback.js';
import { codeBar, listenWedge, openCamera } from '../codebar.js';
import { printSlip } from './orders.js';

const P = { id: null, qty: new Map(), checked: new Set(), backorder: true };
let stopWedge = null;

const order = () => db().orders[P.id];
const mine = (o) => o.status === 'picking' && o.pickedBy === state.session.user.name;

function init(id) {
  if (P.id === id) return;
  const o = db().orders[id];
  P.id = id; P.checked = new Set(); P.backorder = true;
  P.qty = new Map(o ? o.lines.map((l) => [l.ean, Math.min(l.qty, stockOf(db(), o.sourceId, l.ean))]) : []);
}

function lineRow(l) {
  const q = P.qty.get(l.ean) ?? 0;
  const ok = P.checked.has(l.ean);
  return html`<li class="row row--compact recv-line ${ok ? 'is-checked' : ''} ${l.short ? 'is-short' : ''}" id="pick-${l.ean}">
    <span class="pick-loc num">${l.loc ? locCode(l.loc) : '—'}</span>
    <span class="row__body"><span class="row__title">${l.name}</span>
      <span class="row__meta">Demandé ${fmtInt(l.qty)} · dispo ${fmtInt(l.avail)}</span>
      ${q < l.qty ? html`<span class="row__meta ${l.short ? 'text-red' : 'text-amber'}">${l.short && q === l.avail ? `Rupture partielle : ${fmtInt(l.qty - q)} en reliquat` : `${fmtInt(l.qty - q)} non préparé(s)`}</span>` : ''}</span>
    <span class="mini-qty"><button type="button" class="mini-qty__btn" data-action="pick.step" data-ean="${l.ean}" data-delta="-1" aria-label="Une de moins">${icon('minus', 'i--sm')}</button>
      <input class="mini-qty__input num" type="number" inputmode="numeric" min="0" max="${Math.min(l.qty, l.avail)}" value="${q}" aria-label="Quantité préparée de ${l.name}" data-change="pick.qty" data-ean="${l.ean}">
      <button type="button" class="mini-qty__btn" data-action="pick.step" data-ean="${l.ean}" data-delta="1" aria-label="Une de plus">${icon('plus', 'i--sm')}</button></span>
    <span class="recv-line__check" role="img" aria-label="${ok ? 'Prélevée' : 'À prélever'}">${icon(ok ? 'check' : 'scan', 'i--sm')}</span></li>`;
}

function body() {
  const o = order();
  const list = pickList(db(), o);
  const done = list.filter((l) => P.checked.has(l.ean)).length;
  const units = list.reduce((n, l) => n + (P.qty.get(l.ean) ?? 0), 0);
  const missing = list.some((l) => (P.qty.get(l.ean) ?? 0) < l.qty);
  if (!mine(o)) {
    return html`<div class="banner banner--info">${icon('info', 'i--sm')}<span class="banner__text">En préparation par ${o.pickedBy}.</span></div>
      ${can('order.manage') ? html`<div class="pad"><button type="button" class="btn btn--secondary btn--block" data-action="pick.takeover">Reprendre la préparation</button></div>` : ''}
      <ul class="list">${list.map((l) => html`<li class="row row--compact"><span class="pick-loc num">${l.loc ? locCode(l.loc) : '—'}</span><span class="row__body"><span class="row__title">${l.name}</span><span class="row__meta">Demandé ${fmtInt(l.qty)}</span></span></li>`)}</ul>`;
  }
  return html`
    ${o.note ? html`<p class="banner banner--info">${icon('info', 'i--sm')}<span class="banner__text">${o.note}</span></p>` : ''}
    <div class="recv-progress"><progress max="${list.length}" value="${done}" aria-label="Lignes prélevées"></progress><span class="num">${done} / ${list.length} lignes prélevées</span></div>
    ${codeBar({ id: 'pick-q', placeholder: 'Scanner chaque pièce prélevée', submit: 'pick.find', camera: 'pick.camera' })}
    <ul class="list">${list.map(lineRow)}</ul>
    <div class="pad stack">
      ${missing ? html`<label class="check"><input type="checkbox" data-change="pick.backorder" ${P.backorder ? 'checked' : ''}><span>Créer un reliquat pour ce qui manque <span class="muted">(nouvelle commande, rien à ressaisir)</span></span></label>` : ''}
      <div class="flex flex--wrap">
        <button type="button" class="btn btn--ghost btn--sm" data-action="pick.release">Libérer la commande</button>
        ${can('order.manage') ? html`<button type="button" class="btn btn--ghost btn--sm text-red" data-action="pick.refuse">Refuser…</button>` : ''}</div>
    </div>
    <div class="sticky-action"><button type="button" class="btn btn--transfer btn--block" data-action="pick.ship" data-testid="pick-ship" ${units ? '' : 'disabled'}>${icon('truck')}Expédier · ${plural(units, 'pièce')}</button></div>`;
}

/** Mise à jour après une saisie : jamais sous le doigt (le bouton visé reste en place). */
const repaint = () => whenReleased(paint);

function paint() {
  const host = $('#pick-body');
  if (host && order()) setHtml(host, body());
}

function render(r) {
  init(r.rest[0]);
  const o = order();
  if (!o || o.kind !== 'internal' || !(o.status === 'submitted' || o.status === 'picking')) {
    return html`<section>${pageHead({ eyebrow: 'Préparation', title: 'Commande indisponible' })}${emptyState({ icon: 'box', title: o ? 'Cette commande n\'est plus à préparer' : 'Commande introuvable', text: 'Elle a peut-être été expédiée ou annulée depuis un autre appareil.', action: html`<a class="btn btn--secondary btn--sm" href="#/orders">Voir les commandes</a>` })}</section>`;
  }
  return html`<section>${pageHead({ eyebrow: 'Préparation', title: `${orderLabel(o)} · ${db().depots[o.depotId]?.name ?? '—'}`, sub: `Envoyée ${fmtRelative(o.submittedAt)}${o.submittedBy ? ` par ${o.submittedBy}` : ''}` })}<div id="pick-body"></div></section>`;
}

function onCode(code) {
  const o = order();
  if (!o || !mine(o)) return false;
  if (!isCode(code)) { feedback('error'); toast('Code non reconnu.', { tone: 'error' }); return true; }
  const l = o.lines.find((x) => x.ean === code);
  if (!l) { feedback('error'); toast(db().articles[code] ? `${db().articles[code].name} n'est pas dans cette commande.` : `Code ${code} inconnu.`, { tone: 'error' }); return true; }
  feedback('scan');
  P.checked.add(code);
  repaint();
  $(`#pick-${code}`)?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  return true;
}

export const pickRoute = {
  title: 'Préparation', back: true, nav: null, perm: 'order.fulfil', refresh: 'none', render,
  mount() {
    const o = order();
    if (o && o.status === 'submitted') {
      try { run(claimOrder, { id: o.id }); } catch (e) { if (!e.isOpError) throw e; toast(e.message, { tone: 'error' }); }
    }
    paint();
    stopWedge?.();
    stopWedge = listenWedge(onCode);
  },
  unmount() { stopWedge?.(); stopWedge = null; P.id = null; },
};

export function initPick() {
  actions({
    'pick.find'(form) { onCode(val(form, 'q')); form.reset(); },
    'pick.camera': () => openCamera({ title: 'Prélèvement', hint: 'Scannez chaque pièce prélevée', onCode }),
    'pick.step'(el) {
      const l = order().lines.find((x) => x.ean === el.dataset.ean);
      const max = Math.min(l.qty, stockOf(db(), order().sourceId, l.ean));
      P.qty.set(l.ean, Math.max(0, Math.min(max, (P.qty.get(l.ean) ?? 0) + Number(el.dataset.delta))));
      P.checked.add(l.ean);
      repaint();
    },
    'pick.qty'(el) {
      const l = order().lines.find((x) => x.ean === el.dataset.ean);
      const max = Math.min(l.qty, stockOf(db(), order().sourceId, l.ean));
      const n = Math.floor(Number(el.value));
      if (!Number.isFinite(n) || n < 0 || n > max) { toast(`Quantité entre 0 et ${max}.`, { tone: 'error' }); repaint(); return; }
      P.qty.set(l.ean, n);
      P.checked.add(l.ean);
      repaint();
    },
    'pick.backorder': (el) => { P.backorder = el.checked; },
    'pick.takeover'() {
      const o = order();
      run(releaseOrder, { id: o.id });
      run(claimOrder, { id: o.id });
      repaint();
    },
    async 'pick.release'() {
      run(releaseOrder, { id: order().id });
      toast('Commande remise dans la file « À préparer ».');
      navigate('orders');
    },
    async 'pick.refuse'() {
      const reason = await promptDialog({ title: 'Refuser la commande', label: 'Motif (affiché à l\'atelier)', confirmLabel: 'Refuser', validate: (v) => (v.trim() ? '' : 'Le motif est obligatoire.') });
      if (!reason) return;
      run(cancelOrder, { id: order().id, reason });
      toast('Commande refusée : l\'atelier est informé.');
      navigate('orders');
    },
    async 'pick.ship'(el) {
      const o = order();
      const lines = o.lines.map((l) => ({ ean: l.ean, qty: P.qty.get(l.ean) ?? 0 }));
      const units = lines.reduce((n, l) => n + l.qty, 0);
      const missing = o.lines.filter((l) => (P.qty.get(l.ean) ?? 0) < l.qty);
      const unchecked = o.lines.filter((l) => (P.qty.get(l.ean) ?? 0) > 0 && !P.checked.has(l.ean)).length;
      const msg = [
        missing.length ? `${plural(missing.length, 'ligne')} incomplète${missing.length > 1 ? 's' : ''}${P.backorder ? ' : un reliquat sera créé.' : ' : le reste ne sera pas livré.'}` : '',
        unchecked ? `${plural(unchecked, 'ligne')} non scannée${unchecked > 1 ? 's' : ''}.` : '',
      ].filter(Boolean).join(' ');
      if (!(await confirmDialog({ title: `Expédier ${plural(units, 'pièce')} à ${db().depots[o.depotId]?.name} ?`, message: msg || 'Le stock quittera l\'entrepôt et sera en transit jusqu\'à la réception.', confirmLabel: 'Expédier' }))) return;
      el.disabled = true;
      const r = run(shipOrder, { id: o.id, lines, backorder: P.backorder });
      feedback('ok');
      toast(`${orderLabel(o)} expédiée${r.backorderId ? ' · reliquat créé' : ''}.`, { tone: 'ok' });
      const shipped = db().orders[o.id];
      if (await confirmDialog({ title: 'Imprimer le bon de livraison ?', message: 'À joindre au colis.', confirmLabel: 'Imprimer', cancelLabel: 'Non merci' })) printSlip(shipped);
      navigate('orders');
    },
  });
}
