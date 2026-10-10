// Commandes fournisseurs de l'entrepôt central : suggestions regroupées par fournisseur, brouillon
// modifiable, envoi (impression, fichier CSV, e-mail prérempli), réceptions partielles, solde.
// Fournisseurs : fiche (contact, délai de livraison utilisé par les seuils intelligents).
import { html, fmtInt, fmtEur, fmtDateTime, fmtRelative, plural } from '../../lib/text.js';
import { stringify } from '../../lib/csv.js';
import { isCode } from '../../lib/ean.js';
import { icon, actions, $, setHtml, val, download } from '../dom.js';
import { db, depot, can, run } from '../state.js';
import { stockOf, searchArticles, resolveEan } from '../../core/queries.js';
import { purchaseOverview, purchaseSuggestions, orderLabel, orderUnits } from '../../core/planning.js';
import { savePurchaseDraft, deletePurchaseDraft, sendPurchase, closePurchase, saveSupplier, deleteSupplier } from '../../core/ops-orders.js';
import { pageHead, segmented, emptyState } from '../components.js';
import { openSheet, closeSheet, confirmDialog } from '../dialogs.js';
import { printDocument } from '../print.js';
import { navigate, refresh } from '../router.js';
import { toast } from '../toast.js';
import { feedback } from '../feedback.js';
import { codeBar, listenWedge } from '../codebar.js';
import { statusPill } from './orders.js';

const PU = { tab: null, q: '' };
let stopWedge = null;
const supplierOf = (o) => db().suppliers[o.supplierId];
const total = (o) => o.lines.reduce((s, l) => s + l.qty * (l.price ?? 0), 0);

// ── Liste ──
function renderList(r) {
  const d = depot();
  if (d.kind !== 'central') return html`<section>${pageHead({ eyebrow: 'Achats', title: 'Commandes fournisseurs' })}${emptyState({ icon: 'store', title: 'Réservé à l\'entrepôt central', text: 'Les ateliers commandent à l\'entrepôt (menu Commandes).' })}</section>`;
  const t = r.params.get('tab');
  if (['buy', 'drafts', 'open', 'past'].includes(t)) PU.tab = t;
  const ov = purchaseOverview(db(), d.id);
  const sugg = can('purchase.manage') ? purchaseSuggestions(db(), d.id) : [];
  PU.tab ??= ov.open.length ? 'open' : 'buy';
  const items = [
    ...(can('purchase.manage') ? [{ value: 'buy', label: 'À commander', badge: sugg.reduce((n, g) => n + g.rows.length, 0) || '' }, { value: 'drafts', label: 'Brouillons', badge: ov.drafts.length || '' }] : []),
    { value: 'open', label: 'Attendues', badge: ov.late.length || '' },
    { value: 'past', label: 'Historique' },
  ];
  if (!items.some((i) => i.value === PU.tab)) PU.tab = 'open';
  const lateIds = new Set(ov.late.map((o) => o.id));
  const row = (o) => html`<li><button type="button" class="row order-row" data-action="pu.open" data-id="${o.id}">
    <span class="row__lead order-row__no num">${o.no || '—'}</span>
    <span class="row__body"><span class="row__title">${supplierOf(o)?.name ?? '—'}</span>
      <span class="row__meta">${plural(o.lines.length, 'ligne')} · ${fmtEur(total(o))} · ${fmtRelative(o.sentAt ?? o.createdAt)}</span>
      ${lateIds.has(o.id) ? html`<span class="row__meta text-red">${icon('clock', 'i--sm')} En retard sur le délai annoncé</span>` : ''}</span>
    <span class="row__trail">${statusPill(o)}</span></button></li>`;
  const content = {
    buy: sugg.length ? html`<div class="pad stack">${sugg.map((g) => html`<div class="card supplier-card">
        <div class="flex flex--between"><div><strong>${g.supplier?.name ?? 'Sans fournisseur'}</strong><div class="muted">${plural(g.rows.length, 'pièce')}${g.supplier ? ` · ${fmtEur(g.cost)} · délai ${g.supplier.leadDays ?? db().meta.settings.leadDaysSupplier} j` : ''}</div></div>
          ${g.supplier ? html`<button type="button" class="btn btn--primary btn--sm" data-action="pu.create" data-supplier="${g.supplier.id}">${icon('plus', 'i--sm')}Créer la commande</button>` : ''}</div>
        ${g.supplier ? '' : html`<p class="muted">Associez un fournisseur à ces pièces (fiche article → Fiche) pour les commander.</p>`}
        <ul class="suggest__list">${g.rows.slice(0, 6).map((x) => html`<li><button type="button" class="linklike grow" data-action="article.open" data-ean="${x.article.ean}">${x.article.name}</button><span class="muted num">${fmtInt(x.qty)}/${fmtInt(x.min)} → +${fmtInt(x.suggested)}</span></li>`)}</ul>
        ${g.rows.length > 6 ? html`<p class="muted">… et ${g.rows.length - 6} autre(s)</p>` : ''}</div>`)}</div>`
      : emptyState({ icon: 'check', title: 'Rien à commander', text: 'Tous les articles de l\'entrepôt sont au-dessus de leur seuil (en comptant les commandes en cours).' }),
    drafts: ov.drafts.length ? html`<ul class="list">${ov.drafts.map(row)}</ul>` : emptyState({ icon: 'file', title: 'Aucun brouillon' }),
    open: ov.open.length ? html`<ul class="list">${ov.open.map(row)}</ul>` : emptyState({ icon: 'truck', title: 'Aucune livraison attendue' }),
    past: ov.past.length ? html`<ul class="list">${ov.past.slice(0, 60).map(row)}</ul>` : emptyState({ icon: 'clock', title: 'Aucun historique' }),
  }[PU.tab];
  return html`<section>
    ${pageHead({ eyebrow: 'Achats', title: 'Commandes fournisseurs', sub: d.name, actions: can('supplier.manage') ? html`<a class="btn btn--secondary btn--sm" href="#/suppliers">${icon('store', 'i--sm')}Fournisseurs</a>` : '' })}
    <div class="pad">${segmented({ action: 'pu.tab', value: PU.tab, items, label: 'Commandes fournisseurs' })}</div>${content}</section>`;
}

export const purchasesRoute = { title: 'Commandes fournisseurs', back: true, perm: 'order.receive', render: renderList };

// ── Une commande ──
function editLine(o, l) {
  return html`<li class="row row--compact">
    <span class="row__body"><span class="row__title">${l.name}</span><span class="row__meta">Stock ${fmtInt(stockOf(db(), o.depotId, l.ean))} · ${db().articles[l.ean]?.supplierRef || l.ean}</span></span>
    <label class="po-price"><span class="sr-only">Prix unitaire</span><input class="input input--mono" inputmode="decimal" value="${String(l.price ?? 0).replace('.', ',')}" data-change="pu.price" data-ean="${l.ean}" aria-label="Prix unitaire de ${l.name}"></label>
    <span class="mini-qty"><button type="button" class="mini-qty__btn" data-action="pu.step" data-ean="${l.ean}" data-delta="-1" aria-label="Diminuer">${icon('minus', 'i--sm')}</button>
      <input class="mini-qty__input num" type="number" inputmode="numeric" min="0" value="${l.qty}" data-change="pu.qty" data-ean="${l.ean}" aria-label="Quantité de ${l.name}">
      <button type="button" class="mini-qty__btn" data-action="pu.step" data-ean="${l.ean}" data-delta="1" aria-label="Augmenter">${icon('plus', 'i--sm')}</button></span></li>`;
}

function renderOne(r) {
  const o = db().orders[r.rest[0]];
  if (!o || o.kind !== 'supplier') return html`<section>${pageHead({ eyebrow: 'Achats', title: 'Commande introuvable' })}${emptyState({ icon: 'file', title: 'Commande introuvable', action: html`<a class="btn btn--secondary btn--sm" href="#/purchases">Retour</a>` })}</section>`;
  const s = supplierOf(o);
  const draft = o.status === 'draft' && can('purchase.manage');
  const open = o.status === 'sent' || o.status === 'partial';
  return html`<section>
    ${pageHead({ eyebrow: o.no ? orderLabel(o) : 'Brouillon', title: s?.name ?? '—', sub: `${plural(o.lines.length, 'ligne')} · ${fmtEur(total(o))}${o.sentAt ? ` · envoyée le ${fmtDateTime(o.sentAt)}` : ''}` })}
    <div class="pad pad--tight">${statusPill(o)}</div>
    ${draft ? html`<div class="pad stack">${codeBar({ id: 'po-q', placeholder: 'Ajouter une pièce (scan ou nom)', submit: 'pu.find', input: 'pu.search' })}<div id="po-results"></div></div>
      <ul class="list">${o.lines.map((l) => editLine(o, l))}</ul>
      <div class="pad stack"><label class="field"><span class="field__label">Note pour le fournisseur</span><input class="input" maxlength="200" value="${o.note ?? ''}" data-change="pu.note"></label>
        <button type="button" class="btn btn--ghost btn--sm" data-action="pu.delete">${icon('trash', 'i--sm')}Supprimer le brouillon</button></div>
      <div class="sticky-action"><button type="button" class="btn btn--primary btn--block" data-action="pu.send">${icon('send')}Envoyer au fournisseur</button></div>`
      : html`<table class="lines lines--pad"><thead><tr><th>Pièce</th><th class="num">Commandé</th><th class="num">Reçu</th><th class="num">PU</th></tr></thead>
        <tbody>${o.lines.map((l) => html`<tr class="${(l.received ?? 0) < l.qty && open ? 'lines__wait' : ''}"><td>${l.name}<span class="muted lines__ean num">${l.ean}</span></td><td class="num">${fmtInt(l.qty)}</td><td class="num">${fmtInt(l.received ?? 0)}</td><td class="num">${fmtEur(l.price ?? 0, true)}</td></tr>`)}</tbody></table>
        <div class="pad stack">
          ${open ? html`<a class="btn btn--in btn--block" href="#/preceive/${o.id}">${icon('inbox')}Réceptionner une livraison</a>` : ''}
          <div class="flex flex--wrap">
            <button type="button" class="btn btn--secondary btn--sm" data-action="pu.print" data-id="${o.id}">${icon('printer', 'i--sm')}Imprimer</button>
            <button type="button" class="btn btn--secondary btn--sm" data-action="pu.csv" data-id="${o.id}">${icon('download', 'i--sm')}CSV</button>
            ${s?.email ? html`<button type="button" class="btn btn--secondary btn--sm" data-action="pu.mail" data-id="${o.id}">${icon('send', 'i--sm')}E-mail</button>` : ''}
            ${open && can('purchase.manage') ? html`<button type="button" class="btn btn--ghost btn--sm" data-action="pu.close" data-id="${o.id}">Solder…</button>` : ''}</div></div>`}
  </section>`;
}

export const purchaseRoute = {
  title: 'Commande fournisseur', back: true, perm: 'order.receive', render: renderOne,
  // Brouillon : la douchette ajoute directement la pièce scannée
  mount() { stopWedge?.(); stopWedge = current()?.status === 'draft' && can('purchase.manage') ? listenWedge((code) => addToPo(code)) : null; },
  unmount() { stopWedge?.(); stopWedge = null; },
};

// ── Fournisseurs ──
function renderSuppliers() {
  const list = Object.values(db().suppliers).sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  const count = (id) => Object.values(db().articles).filter((a) => a.supplierId === id).length;
  return html`<section>
    ${pageHead({ eyebrow: 'Achats', title: 'Fournisseurs', actions: html`<button type="button" class="btn btn--primary btn--sm" data-action="pu.supplier" data-id="">${icon('plus', 'i--sm')}Fournisseur</button>` })}
    ${list.length ? html`<ul class="list">${list.map((s) => html`<li><button type="button" class="row" data-action="pu.supplier" data-id="${s.id}"><span class="row__body"><span class="row__title">${s.name}</span>
      <span class="row__meta">${[s.email, s.phone, s.leadDays != null ? `délai ${s.leadDays} j` : ''].filter(Boolean).join(' · ') || '—'}</span></span>
      <span class="row__trail"><span class="row__sub">${plural(count(s.id), 'article')}</span></span></button></li>`)}</ul>`
      : emptyState({ icon: 'store', title: 'Aucun fournisseur', text: 'Créez vos fournisseurs puis associez-les aux pièces (fiche article).' })}</section>`;
}

export const suppliersRoute = { title: 'Fournisseurs', back: true, perm: 'supplier.manage', render: renderSuppliers };

function supplierSheet(id) {
  const s = id ? db().suppliers[id] : null;
  openSheet({
    title: s ? s.name : 'Nouveau fournisseur',
    body: html`<form class="stack" data-submit="pu.supplier.save" data-id="${id ?? ''}" novalidate>
      <label class="field"><span class="field__label">Nom</span><input class="input" name="name" maxlength="60" value="${s?.name ?? ''}" required></label>
      <label class="field"><span class="field__label">E-mail de commande</span><input class="input" name="email" type="email" maxlength="120" value="${s?.email ?? ''}" autocomplete="off"></label>
      <div class="grid2"><label class="field"><span class="field__label">Téléphone</span><input class="input" name="phone" maxlength="30" value="${s?.phone ?? ''}"></label>
        <label class="field"><span class="field__label">Délai de livraison (jours)</span><input class="input input--mono" name="leadDays" type="number" min="0" max="365" value="${s?.leadDays ?? ''}" placeholder="${db().meta.settings.leadDaysSupplier}"></label></div>
      <label class="field"><span class="field__label">Note</span><input class="input" name="note" maxlength="200" value="${s?.note ?? ''}"></label>
      <p class="field__error" data-err role="alert"></p>
      <button type="submit" class="btn btn--primary btn--block">Enregistrer</button>
      ${s ? html`<button type="button" class="btn btn--danger btn--block" data-action="pu.supplier.delete" data-id="${s.id}">${icon('trash')}Supprimer</button>` : ''}</form>`,
  });
}

// ── Envoi ──
const csvOf = (o) => stringify(o.lines, [
  { label: 'Référence fournisseur', get: (l) => db().articles[l.ean]?.supplierRef || '' }, { label: 'EAN', get: (l) => l.ean }, { label: 'Désignation', get: (l) => l.name },
  { label: 'Quantité', get: (l) => l.qty }, { label: 'Prix unitaire', get: (l) => String(l.price ?? 0).replace('.', ',') },
]);
function printPo(o) {
  const s = supplierOf(o);
  printDocument({
    title: `Bon de commande ${orderLabel(o)}`, subtitle: `${depot().name} → ${s?.name ?? '—'}`,
    meta: [s?.email, o.sentAt && `envoyée le ${fmtDateTime(o.sentAt)}`].filter(Boolean).join(' · '),
    columns: [{ label: 'Réf. fournisseur' }, { label: 'EAN' }, { label: 'Désignation' }, { label: 'Qté', num: true }, { label: 'PU', num: true }, { label: 'Total', num: true }],
    rows: o.lines.map((l) => [db().articles[l.ean]?.supplierRef || '—', l.ean, l.name, l.qty, fmtEur(l.price ?? 0, true), fmtEur(l.qty * (l.price ?? 0), true)]),
    notes: `Total : ${fmtEur(total(o), true)} HT${o.note ? ` — ${o.note}` : ''}`,
  });
}
function mailPo(o) {
  const s = supplierOf(o);
  const body = [`Bonjour,`, '', `Veuillez trouver notre commande ${orderLabel(o)} :`, '',
    ...o.lines.map((l) => `- ${l.qty} × ${l.name}${db().articles[l.ean]?.supplierRef ? ` (réf. ${db().articles[l.ean].supplierRef})` : ''}`), '',
    o.note ? `${o.note}\n` : '', `Livraison : ${depot().name}${depot().location ? `, ${depot().location}` : ''}`, '', 'Merci de nous confirmer le délai.'].join('\n');
  const href = `mailto:${encodeURIComponent(s.email)}?subject=${encodeURIComponent(`Commande ${orderLabel(o)} — ${depot().name}`)}&body=${encodeURIComponent(body)}`;
  const a = document.createElement('a');
  a.href = href;
  a.rel = 'noopener';
  document.body.append(a); a.click(); a.remove();
}

function results(o) {
  const rows = PU.q ? searchArticles(db(), o.depotId, { q: PU.q, sort: 'name' }).slice(0, 6) : [];
  return html`${rows.length ? html`<ul class="list cart-results">${rows.map((x) => html`<li><button type="button" class="row row--compact" data-action="pu.add" data-ean="${x.article.ean}"><span class="row__body"><span class="row__title">${x.article.name}</span><span class="row__meta">Stock ${fmtInt(x.qty)}</span></span>${icon('plus', 'i--sm')}</button></li>`)}</ul>` : ''}`;
}

const current = () => db().orders[location.hash.split('/')[2]?.split('?')[0]];
function saveLines(o, lines) {
  run(savePurchaseDraft, { id: o.id, supplierId: o.supplierId, lines: lines.filter((l) => l.qty > 0).map((l) => ({ ean: l.ean, qty: l.qty, price: l.price })) });
  refresh();
}
function addToPo(scanned) {
  const o = current();
  const code = resolveEan(db(), scanned);
  if (!o || !code) { feedback('error'); toast('Pièce inconnue du catalogue.', { tone: 'error' }); return; }
  feedback('scan');
  const a = db().articles[code];
  const have = o.lines.find((l) => l.ean === code);
  PU.q = '';
  saveLines(o, have ? o.lines.map((l) => (l.ean === code ? { ...l, qty: l.qty + (a.pack || 1) } : l)) : [...o.lines, { ean: code, qty: a.pack || 1, price: a.price }]);
}

export function initPurchases() {
  actions({
    'pu.tab': (el) => { PU.tab = el.dataset.value; refresh(); },
    'pu.open'(el) {
      const o = db().orders[el.dataset.id];
      navigate(`purchase/${o.id}`);
    },
    'pu.create'(el) {
      const g = purchaseSuggestions(db(), depot().id).find((x) => x.supplier?.id === el.dataset.supplier);
      if (!g) return;
      const r = run(savePurchaseDraft, { supplierId: g.supplier.id, lines: g.rows.map((x) => ({ ean: x.article.ean, qty: x.suggested })) });
      toast('Brouillon créé : vérifiez puis envoyez.', { tone: 'ok' });
      navigate(`purchase/${r.orderId}`);
    },
    'pu.search': (el) => { PU.q = el.value.trim(); const host = $('#po-results'); const o = current(); if (host && o) setHtml(host, results(o)); },
    'pu.find'(form) {
      const q = val(form, 'q');
      if (isCode(q)) return addToPo(q);
      const found = searchArticles(db(), depot().id, { q, sort: 'name' });
      if (found.length === 1) addToPo(found[0].article.ean);
      else if (!found.length) { feedback('error'); toast('Aucune pièce trouvée.', { tone: 'error' }); }
    },
    'pu.add': (el) => addToPo(el.dataset.ean),
    'pu.step'(el) {
      const o = current();
      const pack = db().articles[el.dataset.ean]?.pack || 1;
      saveLines(o, o.lines.map((l) => (l.ean === el.dataset.ean ? { ...l, qty: Math.max(0, l.qty + Number(el.dataset.delta) * pack) } : l)));
    },
    'pu.qty'(el) {
      const o = current();
      const n = Math.floor(Number(el.value));
      if (!Number.isFinite(n) || n < 0) { toast('Quantité invalide.', { tone: 'error' }); refresh(); return; }
      if (n === 0 && o.lines.length === 1) { toast('Une commande compte au moins une ligne : supprimez le brouillon plutôt.', { tone: 'error' }); refresh(); return; }
      saveLines(o, o.lines.map((l) => (l.ean === el.dataset.ean ? { ...l, qty: n } : l)));
    },
    'pu.price'(el) {
      const o = current();
      const p = Number(String(el.value).replace(',', '.'));
      if (!Number.isFinite(p) || p < 0) { toast('Prix invalide.', { tone: 'error' }); refresh(); return; }
      saveLines(o, o.lines.map((l) => (l.ean === el.dataset.ean ? { ...l, price: p } : l)));
    },
    'pu.note'(el) { const o = current(); run(savePurchaseDraft, { id: o.id, supplierId: o.supplierId, lines: o.lines, note: el.value }); },
    async 'pu.delete'() {
      const o = current();
      if (!(await confirmDialog({ title: 'Supprimer ce brouillon ?', confirmLabel: 'Supprimer', danger: true }))) return;
      run(deletePurchaseDraft, { id: o.id });
      navigate('purchases');
    },
    async 'pu.send'() {
      const o = current();
      const s = supplierOf(o);
      if (!(await confirmDialog({ title: `Envoyer à ${s?.name} ?`, message: `${plural(o.lines.length, 'ligne')}, ${plural(orderUnits(o), 'pièce')}, ${fmtEur(total(o))}. Vous pourrez ensuite l'imprimer, l'exporter ou l'envoyer par e-mail.`, confirmLabel: 'Envoyer' }))) return;
      const r = run(sendPurchase, { id: o.id });
      toast(`Commande ${orderLabel({ kind: 'supplier', no: r.no })} enregistrée comme envoyée.`, { tone: 'ok' });
      refresh();
      if (s?.email && await confirmDialog({ title: 'Préparer l\'e-mail au fournisseur ?', message: `Un e-mail à ${s.email} sera prérempli dans votre messagerie.`, confirmLabel: 'Ouvrir la messagerie', cancelLabel: 'Plus tard' })) mailPo(db().orders[o.id]);
    },
    'pu.print': (el) => printPo(db().orders[el.dataset.id]),
    'pu.csv'(el) { const o = db().orders[el.dataset.id]; download(`commande-${orderLabel(o).replace(' ', '-')}.csv`, csvOf(o), 'text/csv'); },
    'pu.mail': (el) => mailPo(db().orders[el.dataset.id]),
    async 'pu.close'(el) {
      const o = db().orders[el.dataset.id];
      const any = o.lines.some((l) => (l.received ?? 0) > 0);
      if (!(await confirmDialog({ title: any ? 'Solder la commande ?' : 'Annuler la commande ?', message: any ? 'Le reste ne sera plus attendu (il redeviendra « à commander » si besoin).' : 'Rien n\'a été reçu : la commande sera annulée.', confirmLabel: any ? 'Solder' : 'Annuler la commande', danger: !any }))) return;
      run(closePurchase, { id: o.id });
      refresh();
    },
    'pu.supplier': (el) => supplierSheet(el.dataset.id || null),
    async 'pu.supplier.save'(form) {
      try {
        run(saveSupplier, { id: form.dataset.id || undefined, name: val(form, 'name'), email: val(form, 'email'), phone: val(form, 'phone'), leadDays: val(form, 'leadDays'), note: val(form, 'note') });
        await closeSheet(); toast('Fournisseur enregistré.', { tone: 'ok' }); refresh();
      } catch (e) { if (!e.isOpError) throw e; form.querySelector('[data-err]').textContent = e.message; }
    },
    async 'pu.supplier.delete'(el) {
      if (!(await confirmDialog({ title: 'Supprimer ce fournisseur ?', message: 'Les pièces associées n\'auront plus de fournisseur.', confirmLabel: 'Supprimer', danger: true }))) return;
      run(deleteSupplier, { id: el.dataset.id });
      await closeSheet(); refresh();
    },
  });
}
