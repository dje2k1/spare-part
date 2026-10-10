// Inventaire guidé : comptage à l'aveugle, article par article dans l'ordre des emplacements, récapitulatif
// des écarts, signature + PIN d'un responsable. Le brouillon survit à un rechargement de la page.
import { html, fmtInt, toInt } from '../../lib/text.js';
import { icon, actions, $, setHtml } from '../dom.js';
import { db, depot, can, run, state, storage, lockout } from '../state.js';
import { searchArticles, locCode } from '../../core/queries.js';
import { commitInventory } from '../../core/ops.js';
import { verifyPin } from '../../core/auth.js';
import { KEYS, ROLES } from '../../core/config.js';
import { pageHead, thumb, locBadge } from '../components.js';
import { pinDialog, confirmDialog } from '../dialogs.js';
import { navigate, refresh } from '../router.js';
import { feedback } from '../feedback.js';
import { toast } from '../toast.js';

const I = { phase: 'setup', depotId: null, scope: 'all', blind: true, items: [], idx: 0, done: null };
let sig = { drawing: false, has: false, ctx: null, last: null };

const saveDraft = () => { try { storage.setItem(KEYS.session, JSON.stringify({ depotId: I.depotId, scope: I.scope, blind: I.blind, items: I.items, idx: I.idx, userId: state.session.user.id })); } catch { /* quota */ } };
const clearDraft = () => { try { storage.removeItem(KEYS.session); } catch { /* ignoré */ } };
function readDraft() {
  try {
    const d = JSON.parse(storage.getItem(KEYS.session));
    if (d && d.userId === state.session.user.id && db().depots[d.depotId] && Array.isArray(d.items) && d.items.length) return d;
  } catch { /* brouillon illisible */ }
  return null;
}

const racks = (depotId) => [...new Set(Object.values(db().locations).filter((l) => l.depotId === depotId).map((l) => l.rack).filter(Boolean))].sort();

function setupView() {
  const draft = readDraft();
  const depots = can('depot.any') ? Object.values(db().depots) : [depot()];
  return html`
    ${draft ? html`<div class="card card--gold stack"><strong>Inventaire en cours</strong><p class="muted">${draft.items.filter((i) => i.real !== null).length} / ${draft.items.length} articles comptés — ${db().depots[draft.depotId].name}.</p>
      <div class="flex"><button type="button" class="btn btn--primary btn--sm grow" data-action="inv.resume">Reprendre</button><button type="button" class="btn btn--ghost btn--sm" data-action="inv.discard">Abandonner</button></div></div>` : ''}
    <form class="stack" data-submit="inv.start" novalidate>
      <p class="muted">Les articles sont présentés un par un dans l'ordre de leurs emplacements. Saisissez la quantité réellement comptée.</p>
      <label class="field"><span class="field__label">Dépôt à inventorier</span><select class="select" name="depot" data-change="inv.depot">${depots.map((d) => html`<option value="${d.id}" ${d.id === (I.depotId || depot().id) ? 'selected' : ''}>${d.name}</option>`)}</select></label>
      <label class="field"><span class="field__label">Périmètre</span><select class="select" name="scope">
        <option value="all">Tous les articles</option><option value="alert">Articles en alerte uniquement</option>
        ${racks(I.depotId || depot().id).map((r) => html`<option value="rack:${r}">Rack ${r}</option>`)}</select></label>
      <label class="check"><input type="checkbox" name="blind" ${I.blind ? 'checked' : ''}><span>Comptage à l'aveugle <span class="muted">(masquer le stock théorique)</span></span></label>
      <button type="submit" class="btn btn--primary btn--block">Démarrer l'inventaire</button>
    </form>`;
}

function countView() {
  const it = I.items[I.idx];
  const a = db().articles[it.ean];
  const done = I.items.filter((i) => i.real !== null).length;
  const value = it.real ?? (I.blind ? 0 : it.sys);
  const loc = a ? (db().articles[it.ean].locations[I.depotId] ?? []).map((id) => db().locations[id]).filter(Boolean)[0] : null;
  return html`
    <div class="inv-progress"><progress max="${I.items.length}" value="${done}" aria-label="Progression du comptage"></progress><span class="num">${I.idx + 1} / ${I.items.length} · ${done} comptés</span></div>
    <article class="card scan-card">
      <header class="scan-card__head">${a ? thumb(a, 'thumb--lg') : ''}
        <div class="grow"><p class="eyebrow">Article ${I.idx + 1} sur ${I.items.length}</p><h3 class="scan-card__name">${it.name}</h3>
          <p class="inv-loc">${loc ? locBadge(locCode(loc)) : html`<span class="muted">Sans emplacement</span>`}</p></div></header>
      ${!I.blind ? html`<p class="muted">Stock théorique : <strong class="num">${fmtInt(it.sys)}</strong></p>` : ''}
      <div class="field"><span class="field__label">Quantité comptée</span>
        <div class="qty"><button type="button" class="qty__btn" data-action="inv.qty" data-delta="-1" aria-label="Moins un">${icon('minus')}</button>
          <input class="qty__input" id="inv-qty" type="number" inputmode="numeric" min="0" step="1" value="${it.real === null && I.blind ? '' : value}" placeholder="0" aria-label="Quantité comptée" data-input="inv.input">
          <button type="button" class="qty__btn" data-action="inv.qty" data-delta="1" aria-label="Plus un">${icon('plus')}</button></div>
        <div class="presets">${[5, 10, 50].map((n) => html`<button type="button" class="chip" data-action="inv.qty" data-delta="${n}">+${n}</button>`)}</div></div>
      ${it.real !== null && !I.blind && it.real !== it.sys ? html`<p class="${it.real < it.sys ? 'text-red' : 'text-green'}">Écart : ${it.real > it.sys ? '+' : ''}${fmtInt(it.real - it.sys)} unité(s)</p>` : ''}
    </article>
    <div class="inv-nav">
      <button type="button" class="btn btn--secondary" data-action="inv.prev" ${I.idx === 0 ? 'disabled' : ''}>${icon('back', 'i--sm')}Précédent</button>
      <button type="button" class="btn btn--ghost" data-action="inv.skip">Passer</button>
      <button type="button" class="btn btn--primary grow" data-action="inv.next">${I.idx === I.items.length - 1 ? 'Terminer' : 'Suivant'}</button>
    </div>`;
}

const diffs = () => I.items.filter((i) => i.real !== null && i.real !== i.sys);

function summaryView() {
  const counted = I.items.filter((i) => i.real !== null);
  const ecarts = diffs();
  const skipped = I.items.length - counted.length;
  return html`
    <div class="kpis kpis--3">
      <div class="kpi"><span class="kpi__value num">${counted.length}</span><span class="kpi__label">Comptés</span></div>
      <div class="kpi"><span class="kpi__value num ${ecarts.length ? 'kpi__value--red' : 'kpi__value--green'}">${ecarts.length}</span><span class="kpi__label">Écarts</span></div>
      <div class="kpi"><span class="kpi__value num">${skipped}</span><span class="kpi__label">Non comptés</span></div></div>
    ${ecarts.length ? html`<h3 class="eyebrow section-title">Écarts constatés</h3><ul class="list">${ecarts.map((i) => html`<li class="row"><span class="row__body"><span class="row__title">${i.name}</span><span class="row__meta">Théorique ${fmtInt(i.sys)} → compté ${fmtInt(i.real)}</span></span>
      <span class="row__trail"><span class="row__qty ${i.real < i.sys ? 'row__qty--out' : 'row__qty--in'}">${i.real > i.sys ? '+' : ''}${fmtInt(i.real - i.sys)}</span></span></li>`)}</ul>`
      : html`<p class="banner banner--ok">${icon('check', 'i--sm')}<span class="banner__text">Aucun écart : le stock théorique est confirmé.</span></p>`}
    ${skipped ? html`<p class="muted pad">${skipped} article(s) non comptés ne seront pas modifiés.</p>` : ''}
    <div class="pad stack">
      <h3 class="eyebrow">Signature du responsable</h3>
      <div class="sig"><canvas id="sig" class="sig__pad" width="600" height="200" aria-label="Zone de signature"></canvas><span class="sig__hint" id="sig-hint">Signez ici</span></div>
      <div class="flex"><button type="button" class="btn btn--ghost btn--sm" data-action="inv.sig.clear">Effacer</button><span class="grow"></span>
        <button type="button" class="btn btn--secondary btn--sm" data-action="inv.back">Revenir au comptage</button></div>
      <button type="button" class="btn btn--primary btn--block" data-action="inv.validate">${icon('shield')}Valider avec le PIN d'un responsable</button>
    </div>`;
}

const doneView = () => html`<div class="empty">${icon('check', 'i--xl')}<p class="empty__title">Inventaire validé</p>
  <p>${I.done.corrections} correction(s) enregistrée(s) · validé par ${I.done.by}.${I.done.conflicts ? ` ${I.done.conflicts} article(s) avaient bougé pendant le comptage.` : ''}</p>
  <button type="button" class="btn btn--primary" data-action="inv.home">Retour à l'accueil</button></div>`;

function paint() {
  const host = $('#inv-body');
  if (!host) return;
  setHtml(host, { setup: setupView, count: countView, summary: summaryView, done: doneView }[I.phase]());
  if (I.phase === 'summary') initSig();
  const input = $('#inv-qty');
  if (input && I.phase === 'count') { input.focus({ preventScroll: true }); input.select?.(); }
}

const render = () => html`<section>${pageHead({ eyebrow: 'Comptage physique', title: 'Inventaire guidé', sub: depot().name })}<div id="inv-body" class="pad--x"></div></section>`;

// ── Signature ──
function initSig() {
  const c = $('#sig');
  if (!c) return;
  sig = { drawing: false, has: false, ctx: c.getContext('2d'), last: null };
  const ctx = sig.ctx;
  ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#111';
  const pos = (e) => { const r = c.getBoundingClientRect(); return [(e.clientX - r.left) * (c.width / r.width), (e.clientY - r.top) * (c.height / r.height)]; };
  c.addEventListener('pointerdown', (e) => { e.preventDefault(); c.setPointerCapture?.(e.pointerId); sig.drawing = true; sig.last = pos(e); $('#sig-hint').hidden = true; });
  c.addEventListener('pointermove', (e) => {
    if (!sig.drawing) return;
    const p = pos(e);
    ctx.beginPath(); ctx.moveTo(...sig.last); ctx.lineTo(...p); ctx.stroke();
    sig.last = p; sig.has = true;
  });
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) c.addEventListener(ev, () => { sig.drawing = false; });
}
const signatureData = () => {
  // Image réduite (≈ 300×100) : quelques ko seulement dans le journal d'audit
  const c = $('#sig'), small = document.createElement('canvas');
  small.width = 300; small.height = 100;
  const x = small.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 300, 100); x.drawImage(c, 0, 0, 300, 100);
  return small.toDataURL('image/png');
};

export const inventoryRoute = { title: 'Inventaire', back: true, perm: 'inventory', refresh: 'none', render, mount: () => { I.phase = 'setup'; I.depotId = null; paint(); } };

function begin(depotId, scope, blind) {
  const rows = searchArticles(db(), depotId, { sort: 'loc' }).filter((r) => {
    if (scope === 'alert') return r.status !== 'ok';
    if (scope.startsWith('rack:')) return r.locs.some((l) => l.rack === scope.slice(5));
    return true;
  });
  if (!rows.length) throw Object.assign(new Error('Aucun article à inventorier dans ce périmètre.'), { isOpError: true });
  Object.assign(I, { phase: 'count', depotId, scope, blind, idx: 0, items: rows.map((r) => ({ ean: r.article.ean, name: r.article.name, sys: r.qty, real: null })) });
  saveDraft(); paint();
}

function readQty() {
  const n = toInt($('#inv-qty')?.value);
  return Number.isNaN(n) || n < 0 ? null : n;
}

export function initInventory() {
  actions({
    'inv.depot': (el) => { I.depotId = el.value; paint(); },
    'inv.start'(form) { begin(form.elements.depot.value, form.elements.scope.value, form.elements.blind.checked); },
    'inv.resume': () => { const d = readDraft(); Object.assign(I, { phase: 'count', depotId: d.depotId, scope: d.scope, blind: d.blind, items: d.items, idx: Math.min(d.idx, d.items.length - 1) }); paint(); },
    async 'inv.discard'() { if (await confirmDialog({ title: 'Abandonner l\'inventaire en cours ?', message: 'Les quantités déjà comptées seront perdues.', confirmLabel: 'Abandonner', danger: true })) { clearDraft(); paint(); } },
    'inv.qty': (el) => { const cur = readQty() ?? (I.items[I.idx].real ?? 0); I.items[I.idx].real = Math.max(0, cur + Number(el.dataset.delta)); saveDraft(); paint(); },
    'inv.input': () => { const n = readQty(); I.items[I.idx].real = n; saveDraft(); },
    'inv.prev': () => { commit(); I.idx = Math.max(0, I.idx - 1); saveDraft(); paint(); },
    'inv.skip': () => { I.items[I.idx].real = null; I.idx = Math.min(I.items.length - 1, I.idx + 1); saveDraft(); paint(); },
    'inv.next'() {
      commit();
      if (I.items[I.idx].real === null) { toast('Saisissez la quantité comptée (0 si la case est vide), ou touchez « Passer ».', { tone: 'error' }); feedback('error'); return; }
      if (I.idx === I.items.length - 1) { I.phase = 'summary'; saveDraft(); paint(); return; }
      I.idx++; saveDraft(); paint();
    },
    'inv.back': () => { I.phase = 'count'; paint(); },
    'inv.sig.clear': () => { const c = $('#sig'); sig.ctx?.clearRect(0, 0, c.width, c.height); sig.has = false; $('#sig-hint').hidden = false; },
    async 'inv.validate'() {
      if (!sig.has) { toast('La signature du responsable est requise.', { tone: 'error' }); return; }
      const lockKey = `inv:${state.session.user.id}`;
      const eligible = Object.values(db().users).filter((u) => can_(u) && (u.role === 'admin' || u.depotId === I.depotId));
      const validator = await pinDialog({
        title: 'Validation par un responsable', message: 'Saisissez le PIN d\'un responsable de ce dépôt (ou d\'un administrateur).',
        async verify(pin) {
          const st = lockout.status(lockKey);
          if (st.locked) return { error: `Trop d'essais. Réessayez dans ${Math.ceil(st.remainingMs / 1000)} s.` };
          for (const u of eligible) if (await verifyPin(u.pin, pin)) { lockout.success(lockKey); return u; }
          lockout.fail(lockKey);
          return false;
        },
      });
      if (!validator) return;
      const lines = I.items.filter((i) => i.real !== null).map((i) => ({ ean: i.ean, real: i.real, sys: i.sys }));
      const r = run(commitInventory, { depotId: I.depotId, lines, validator: { name: validator.name }, signature: signatureData() });
      I.done = { ...r, by: validator.name };
      clearDraft(); I.phase = 'done'; feedback('ok'); paint();
    },
    'inv.home': () => navigate('home'),
  });
}

const can_ = (u) => ROLES[u.role] && (u.role === 'manager' || u.role === 'admin') && Boolean(u.pin);
function commit() { const n = readQty(); if (n !== null) I.items[I.idx].real = n; }
