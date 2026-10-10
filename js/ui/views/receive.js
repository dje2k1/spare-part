// Réception guidée par le scan, commune aux livraisons de l'entrepôt (atelier) et aux livraisons
// fournisseurs (entrepôt central) : chaque pièce scannée est cochée ; les quantités sont préremplies
// (expédié, ou reste à recevoir) et corrigeables ; les écarts sont signalés avant validation.
import { html, fmtInt, fmtRelative, plural } from '../../lib/text.js';
import { isCode } from '../../lib/ean.js';
import { icon, actions, $, setHtml, val, whenReleased } from '../dom.js';
import { db, depot, can, run } from '../state.js';
import { articleLocations, locCode } from '../../core/queries.js';
import { orderLabel } from '../../core/planning.js';
import { receiveOrder, receivePurchase } from '../../core/ops-orders.js';
import { pageHead, emptyState, thumb } from '../components.js';
import { confirmDialog } from '../dialogs.js';
import { navigate } from '../router.js';
import { toast } from '../toast.js';
import { feedback } from '../feedback.js';
import { codeBar, listenWedge, openCamera } from '../codebar.js';
import { presetLabels } from './labels.js';

const R = { id: null, qty: new Map(), checked: new Set() };
let stopWedge = null;

const order = () => db().orders[R.id];
const expected = (o, l) => (o.kind === 'supplier' ? Math.max(0, l.qty - (l.received ?? 0)) : l.shipped ?? 0);
const lines = (o) => o.lines.filter((l) => o.kind === 'supplier' ? expected(o, l) > 0 : true);

function init(id) {
  const o = db().orders[id];
  if (R.id === id && o) return;
  R.id = id; R.checked = new Set();
  R.qty = new Map(o ? lines(o).map((l) => [l.ean, expected(o, l)]) : []);
}

function lineRow(o, l) {
  const a = db().articles[l.ean];
  const exp = expected(o, l);
  const q = R.qty.get(l.ean) ?? exp;
  const ok = R.checked.has(l.ean);
  const loc = articleLocations(db(), l.ean, depot().id)[0];
  return html`<li class="row row--compact recv-line ${ok ? 'is-checked' : ''}" id="line-${l.ean}">
    <span class="recv-line__check" role="img" aria-label="${ok ? 'Contrôlée' : 'À contrôler'}">${icon(ok ? 'check' : 'scan', 'i--sm')}</span>
    <span class="row__lead">${a ? thumb(a) : ''}</span>
    <span class="row__body"><span class="row__title">${l.name}</span>
      <span class="row__meta">${o.kind === 'supplier' ? `Reste à recevoir ${fmtInt(exp)}` : `Expédié ${fmtInt(exp)}`}${loc ? ` · ranger en ${locCode(loc)}` : ''}</span>
      ${q !== exp ? html`<span class="row__meta ${q < exp ? 'text-red' : 'text-amber'}">${q < exp ? `Manque ${fmtInt(exp - q)}` : `Surplus ${fmtInt(q - exp)}`}</span>` : ''}</span>
    <span class="mini-qty"><button type="button" class="mini-qty__btn" data-action="recv.step" data-ean="${l.ean}" data-delta="-1" aria-label="Une de moins">${icon('minus', 'i--sm')}</button>
      <input class="mini-qty__input num" type="number" inputmode="numeric" min="0" value="${q}" aria-label="Quantité reçue de ${l.name}" data-change="recv.qty" data-ean="${l.ean}">
      <button type="button" class="mini-qty__btn" data-action="recv.step" data-ean="${l.ean}" data-delta="1" aria-label="Une de plus">${icon('plus', 'i--sm')}</button></span></li>`;
}

function body() {
  const o = order();
  const list = lines(o);
  const done = list.filter((l) => R.checked.has(l.ean)).length;
  const units = list.reduce((n, l) => n + (R.qty.get(l.ean) ?? 0), 0);
  return html`
    <div class="recv-progress"><progress max="${list.length}" value="${done}" aria-label="Lignes contrôlées"></progress><span class="num">${done} / ${list.length} lignes contrôlées</span></div>
    ${codeBar({ id: 'recv-q', placeholder: 'Scanner chaque pièce reçue', submit: 'recv.find', camera: 'recv.camera' })}
    <ul class="list">${list.map((l) => lineRow(o, l))}</ul>
    <div class="pad"><button type="button" class="btn btn--ghost btn--sm" data-action="recv.all">${icon('check', 'i--sm')}Tout est conforme</button></div>
    <div class="sticky-action"><button type="button" class="btn btn--in btn--block" data-action="recv.validate" data-testid="recv-validate">${icon('inbox')}Valider la réception · ${plural(units, 'pièce')}</button></div>`;
}

/** Mise à jour après une saisie : jamais sous le doigt (le bouton visé reste en place). */
const repaint = () => whenReleased(paint);

function paint() {
  const host = $('#recv-body');
  if (host && order()) setHtml(host, body());
}

function render(r) {
  init(r.rest[0]);
  const o = order();
  const valid = o && ((o.kind === 'internal' && o.status === 'shipped') || (o.kind === 'supplier' && (o.status === 'sent' || o.status === 'partial')));
  if (!valid) return html`<section>${pageHead({ eyebrow: 'Réception', title: 'Livraison introuvable' })}${emptyState({ icon: 'inbox', title: o ? 'Cette commande n\'attend pas de réception' : 'Commande introuvable', text: 'Elle a peut-être déjà été réceptionnée sur un autre appareil.', action: html`<a class="btn btn--secondary btn--sm" href="#/orders">Voir les commandes</a>` })}</section>`;
  const from = o.kind === 'supplier' ? db().suppliers[o.supplierId]?.name : db().depots[o.sourceId]?.name;
  const when = o.kind === 'supplier' ? `commandée ${fmtRelative(o.sentAt)}` : `expédiée ${fmtRelative(o.shippedAt)}${o.shippedBy ? ` par ${o.shippedBy}` : ''}`;
  return html`<section>${pageHead({ eyebrow: 'Réception', title: orderLabel(o), sub: `${from ?? '—'} · ${when}` })}<div id="recv-body"></div></section>`;
}

function onCode(code) {
  const o = order();
  if (!o) return false;
  if (!isCode(code)) { feedback('error'); toast('Code non reconnu.', { tone: 'error' }); return true; }
  const l = lines(o).find((x) => x.ean === code);
  if (!l) { feedback('error'); toast(db().articles[code] ? `${db().articles[code].name} ne fait pas partie de cette livraison.` : `Code ${code} inconnu.`, { tone: 'error' }); return true; }
  feedback('scan');
  if (R.checked.has(code)) toast(`${l.name} déjà contrôlée : ajustez la quantité si besoin.`);
  R.checked.add(code);
  repaint();
  $(`#line-${code}`)?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  return true;
}

export const receiveRoute = {
  title: 'Réception', back: true, nav: null, refresh: 'none', render,
  mount() { paint(); stopWedge?.(); stopWedge = listenWedge(onCode); },
  unmount() { stopWedge?.(); stopWedge = null; R.id = null; },
};

export function initReceive() {
  actions({
    'recv.find'(form) { onCode(val(form, 'q')); form.reset(); },
    'recv.camera': () => openCamera({ title: 'Contrôle de réception', hint: 'Scannez chaque pièce de la livraison', onCode }),
    'recv.step'(el) {
      const cur = R.qty.get(el.dataset.ean) ?? 0;
      R.qty.set(el.dataset.ean, Math.max(0, cur + Number(el.dataset.delta)));
      R.checked.add(el.dataset.ean);
      repaint();
    },
    'recv.qty'(el) {
      const n = Math.floor(Number(el.value));
      if (!Number.isFinite(n) || n < 0) { toast('Quantité invalide.', { tone: 'error' }); repaint(); return; }
      R.qty.set(el.dataset.ean, n);
      R.checked.add(el.dataset.ean);
      repaint();
    },
    'recv.all'() { for (const l of lines(order())) R.checked.add(l.ean); repaint(); },
    async 'recv.validate'(el) {
      const o = order();
      const list = lines(o);
      const unchecked = list.filter((l) => !R.checked.has(l.ean)).length;
      const gaps = list.filter((l) => (R.qty.get(l.ean) ?? 0) !== expected(o, l));
      const units = list.reduce((n, l) => n + (R.qty.get(l.ean) ?? 0), 0);
      const notes = [
        unchecked ? `${plural(unchecked, 'ligne')} non contrôlée${unchecked > 1 ? 's' : ''} : validée${unchecked > 1 ? 's' : ''} telle${unchecked > 1 ? 's' : ''} qu'annoncée${unchecked > 1 ? 's' : ''}.` : '',
        gaps.length ? `${plural(gaps.length, 'écart')} : ${gaps.slice(0, 3).map((l) => `${l.name} ${fmtInt(R.qty.get(l.ean) ?? 0)}/${fmtInt(expected(o, l))}`).join(', ')}${gaps.length > 3 ? '…' : ''}` : '',
        o.kind === 'supplier' && gaps.some((l) => (R.qty.get(l.ean) ?? 0) < expected(o, l)) ? 'Le reste restera attendu (réception partielle).' : '',
      ].filter(Boolean).join(' ');
      if ((unchecked || gaps.length) && !(await confirmDialog({ title: `Valider ${plural(units, 'pièce')} ?`, message: notes, confirmLabel: 'Valider la réception' }))) return;
      el.disabled = true;
      const payload = { id: o.id, lines: list.map((l) => ({ ean: l.ean, qty: R.qty.get(l.ean) ?? 0 })) };
      if (o.kind === 'supplier') {
        if (!units) { toast('Saisissez au moins une quantité reçue.', { tone: 'error' }); el.disabled = false; return; }
        const r = run(receivePurchase, payload);
        toast(r.complete ? 'Livraison fournisseur réceptionnée : commande soldée.' : `${plural(r.units, 'pièce')} reçue(s) ; le reste reste attendu.`, { tone: 'ok', ms: 5000 });
      } else {
        const r = run(receiveOrder, payload);
        toast(`${orderLabel(o)} réceptionnée : ${plural(r.units, 'pièce')}${r.gaps ? `, ${plural(r.gaps, 'écart')} signalé(s) à l'entrepôt` : ''}.`, { tone: 'ok', ms: 5000 });
      }
      feedback('ok');
      const received = payload.lines.filter((l) => l.qty > 0);
      if (can('labels') && received.length && await confirmDialog({ title: 'Étiqueter les pièces reçues ?', message: `${plural(received.reduce((n, l) => n + l.qty, 0), 'étiquette')} (une par pièce), modifiables avant impression.`, confirmLabel: 'Préparer les étiquettes', cancelLabel: 'Plus tard' })) {
        presetLabels(received.map((l) => ({ ean: l.ean, copies: l.qty })));
        return;
      }
      navigate(o.kind === 'supplier' ? 'purchases' : 'home');
    },
  });
}
