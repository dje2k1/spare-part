// Panier de commande de l'atelier (brouillon partagé par tous les appareils de l'atelier) :
// suggestions (sous le seuil, rien en route), ajout par scan ou recherche, quantités au conditionnement,
// puis « Envoyer » à l'entrepôt central.
import { html, fmtInt, plural } from '../../lib/text.js';
import { isCode } from '../../lib/ean.js';
import { icon, actions, $, setHtml, val } from '../dom.js';
import { db, depot, can, run } from '../state.js';
import { stockOf, levelOf, reorderList, searchArticles, incomingQty, resolveEan } from '../../core/queries.js';
import { draftFor, orderLabel } from '../../core/planning.js';
import { setDraftLines, submitOrder, discardDraft } from '../../core/ops-orders.js';
import { centralDepot } from '../../core/ops-kit.js';
import { pageHead, emptyState, thumb } from '../components.js';
import { confirmDialog } from '../dialogs.js';
import { navigate, refresh } from '../router.js';
import { toast } from '../toast.js';
import { feedback } from '../feedback.js';
import { codeBar, listenWedge, openCamera } from '../codebar.js';

const C = { q: '' };
let stopWedge = null;

const draft = () => draftFor(db(), depot().id);
const packOf = (ean) => db().articles[ean]?.pack || 1;

function lineRow(l) {
  const a = db().articles[l.ean];
  if (!a) return '';
  const d = depot();
  const lv = levelOf(db(), d.id, a);
  const pack = a.pack || 1;
  return html`<li class="row row--compact cart-line">
    <span class="row__lead">${thumb(a)}</span>
    <span class="row__body"><span class="row__title">${a.name}</span>
      <span class="row__meta">Stock ${fmtInt(stockOf(db(), d.id, a.ean))}${lv.min ? ` · seuil ${fmtInt(lv.min)} · max ${fmtInt(lv.max)}` : ''}${pack > 1 ? ` · par ${pack}` : ''}</span></span>
    <span class="mini-qty"><button type="button" class="mini-qty__btn" data-action="cart.step" data-ean="${a.ean}" data-delta="-1" aria-label="Diminuer ${a.name}">${icon('minus', 'i--sm')}</button>
      <input class="mini-qty__input num" type="number" inputmode="numeric" min="0" step="${pack}" value="${l.qty}" aria-label="Quantité de ${a.name}" data-change="cart.qty" data-ean="${a.ean}">
      <button type="button" class="mini-qty__btn" data-action="cart.step" data-ean="${a.ean}" data-delta="1" aria-label="Augmenter ${a.name}">${icon('plus', 'i--sm')}</button></span></li>`;
}

function results() {
  const rows = C.q ? searchArticles(db(), depot().id, { q: C.q, sort: 'name' }).slice(0, 6) : [];
  return rows.length ? html`<ul class="list cart-results">${rows.map((r) => html`<li><button type="button" class="row row--compact" data-action="cart.add" data-ean="${r.article.ean}"><span class="row__body"><span class="row__title">${r.article.name}</span><span class="row__meta">Stock ${fmtInt(r.qty)}${r.min ? ` · seuil ${fmtInt(r.min)}` : ''}</span></span>${icon('plus', 'i--sm')}</button></li>`)}</ul>` : '';
}

function render() {
  const d = depot();
  const central = centralDepot(db());
  if (!central) {
    return html`<section>${pageHead({ eyebrow: 'Commande', title: 'Panier' })}${emptyState({ icon: 'store', title: 'Aucun entrepôt central', text: 'Un administrateur doit désigner l\'entrepôt central (Administration → Dépôts) avant de pouvoir commander.' })}</section>`;
  }
  const o = draft();
  const lines = o?.lines ?? [];
  const inCart = new Set(lines.map((l) => l.ean));
  const sugg = reorderList(db(), d.id, { withDraft: true });
  const units = lines.reduce((n, l) => n + l.qty, 0);
  return html`<section class="cart">
    ${pageHead({ eyebrow: 'Commande à l\'entrepôt', title: 'Panier', sub: `${d.name} → ${central.name}` })}
    <div class="pad stack">
      ${sugg.length ? html`<div class="card card--gold suggest">
        <div class="flex flex--between"><strong>${plural(sugg.length, 'pièce')} à commander</strong><button type="button" class="btn btn--primary btn--sm" data-action="cart.addall">${icon('plus', 'i--sm')}Tout ajouter</button></div>
        <p class="muted suggest__text">Sous le seuil, rien en route. Quantité proposée : jusqu'au maximum, au conditionnement.</p>
        <ul class="suggest__list">${sugg.slice(0, 5).map((r) => html`<li><span class="grow">${r.article.name} <span class="muted">· stock ${fmtInt(r.qty)}/${fmtInt(r.min)}</span></span><button type="button" class="btn btn--text" data-action="cart.addone" data-ean="${r.article.ean}" data-qty="${r.suggested}">+${fmtInt(r.suggested)}</button></li>`)}</ul>
        ${sugg.length > 5 ? html`<p class="muted">… et ${sugg.length - 5} autre(s)</p>` : ''}</div>` : ''}
      ${codeBar({ id: 'cart-q', placeholder: 'Ajouter : scanner ou rechercher une pièce', submit: 'cart.find', input: 'cart.search', camera: 'cart.camera' })}
      <div id="cart-results" aria-live="polite">${results()}</div>
    </div>
    ${lines.length ? html`<h3 class="eyebrow section-title">${plural(lines.length, 'ligne')} · ${plural(units, 'pièce')}</h3>
      <ul class="list">${lines.map(lineRow)}</ul>
      <div class="pad stack"><label class="field"><span class="field__label">Note pour l'entrepôt (facultatif)</span><input class="input" maxlength="200" value="${o.note ?? ''}" placeholder="Urgent pour mardi…" data-change="cart.note"></label>
        <button type="button" class="btn btn--ghost btn--sm" data-action="cart.discard">${icon('trash', 'i--sm')}Vider le panier</button></div>
      <div class="sticky-action"><button type="button" class="btn btn--primary btn--block" data-action="cart.submit" data-testid="cart-submit">${icon('send')}Envoyer la commande · ${plural(units, 'pièce')}</button></div>`
      : emptyState({ icon: 'cart', title: 'Panier vide', text: sugg.length ? 'Ajoutez les pièces suggérées ou scannez celles dont vous avez besoin.' : 'Aucune pièce sous le seuil. Scannez ou recherchez une pièce pour l\'ajouter.' })}
  </section>`;
}

function setLine(ean, qty) {
  run(setDraftLines, { lines: [{ ean, qty: Math.max(0, qty) }] });
  refresh();
}

function addEan(scanned, qty) {
  const code = resolveEan(db(), scanned);
  if (!code) { feedback('error'); toast(`Code ${scanned} inconnu du catalogue.`, { tone: 'error' }); return false; }
  feedback('scan');
  const cur = draft()?.lines.find((l) => l.ean === code)?.qty ?? 0;
  setLine(code, cur + (qty ?? packOf(code)));
  C.q = '';
  toast(`${db().articles[code].name} : ${cur + (qty ?? packOf(code))} au panier`);
  return true;
}

export const cartRoute = {
  title: 'Panier', back: true, perm: 'order.request', render,
  mount() {
    if (depot().kind === 'central') { navigate('purchases', { replace: true }); return; }
    stopWedge?.();
    stopWedge = listenWedge((code) => addEan(code));
  },
  unmount() { stopWedge?.(); stopWedge = null; },
};

export function initCart() {
  actions({
    'cart.search': (el) => { C.q = el.value.trim(); const host = $('#cart-results'); if (host) setHtml(host, html`${results()}`); },
    'cart.find'(form) {
      const q = val(form, 'q');
      if (isCode(q)) { addEan(q); return; }
      const found = searchArticles(db(), depot().id, { q, sort: 'name' });
      if (found.length === 1) addEan(found[0].article.ean); else if (!found.length) toast('Aucune pièce trouvée.', { tone: 'error' });
    },
    'cart.camera': () => openCamera({ title: 'Ajouter au panier', onCode: (code) => { addEan(code); return true; } }),
    'cart.add': (el) => addEan(el.dataset.ean),
    'cart.addone': (el) => addEan(el.dataset.ean, Number(el.dataset.qty)),
    'cart.addall'() {
      const o = draft();
      const have = new Set((o?.lines ?? []).map((l) => l.ean));
      const lines = reorderList(db(), depot().id, { withDraft: true }).filter((r) => !have.has(r.article.ean)).map((r) => ({ ean: r.article.ean, qty: r.suggested }));
      if (!lines.length) return;
      run(setDraftLines, { lines });
      toast(`${plural(lines.length, 'pièce')} ajoutée(s) au panier.`, { tone: 'ok' });
      refresh();
    },
    'cart.step'(el) {
      const ean = el.dataset.ean;
      const cur = draft()?.lines.find((l) => l.ean === ean)?.qty ?? 0;
      const pack = packOf(ean);
      const next = Number(el.dataset.delta) > 0 ? Math.floor(cur / pack) * pack + pack : Math.ceil(cur / pack) * pack - pack;
      setLine(ean, next);
    },
    'cart.qty'(el) {
      const n = Math.floor(Number(el.value));
      if (!Number.isFinite(n) || n < 0) { toast('Quantité invalide.', { tone: 'error' }); refresh(); return; }
      setLine(el.dataset.ean, n);
    },
    'cart.note'(el) { const o = draft(); if (o) run(setDraftLines, { lines: [], note: el.value }); },
    async 'cart.discard'() {
      const o = draft();
      if (!o || !(await confirmDialog({ title: 'Vider le panier ?', message: 'Toutes les lignes seront retirées.', confirmLabel: 'Vider', danger: true }))) return;
      run(discardDraft, { id: o.id });
      refresh();
    },
    async 'cart.submit'(el) {
      const o = draft();
      if (!o) return;
      const units = o.lines.reduce((n, l) => n + l.qty, 0);
      if (!(await confirmDialog({ title: 'Envoyer la commande ?', message: `${plural(o.lines.length, 'ligne')}, ${plural(units, 'pièce')} à ${centralDepot(db())?.name}.`, confirmLabel: 'Envoyer' }))) return;
      el.disabled = true;
      const r = run(submitOrder, { id: o.id });
      feedback('ok');
      toast(`Commande ${orderLabel({ kind: 'internal', no: r.no })} envoyée à l'entrepôt.`, { tone: 'ok' });
      navigate('orders');
    },
  });
}

/** Nombre de pièces en route vers l'atelier (affiché dans la fiche article). */
export const onTheWay = (ean) => incomingQty(db(), depot().id, ean);
export const canOrder = () => can('order.request') && depot().kind !== 'central' && Boolean(centralDepot(db()));
