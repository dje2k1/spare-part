// Scan continu : entrée / sortie / transfert sans quitter l'écran.
// Flux : caméra (ou saisie, ou douchette) → fiche de la pièce → quantité → Valider → l'écran se réarme
// pour la pièce suivante. Chaque opération offre « Annuler » pendant quelques secondes.
import { html, fmtInt, toInt } from '../../lib/text.js';
import { isCode, hasValidCheck, nextInternalEan } from '../../lib/ean.js';
import { parseLocationPayload } from '../../lib/qr.js';
import { icon, actions, $, setHtml, val } from '../dom.js';
import { db, depot, can, run, prefs } from '../state.js';
import { moveStock, createTransfer, undoMovement, cancelTransfer } from '../../core/ops.js';
import { searchArticles, stockOf, articleLocations, locCode, families, depotLocationCodes, levelOf, stockStatus } from '../../core/queries.js';
import { REASONS } from '../../core/config.js';
import { thumb, statusPill, segmented, articleRow } from '../components.js';
import { createScanner, scannerAvailable, cameraErrorMessage, decodePhoto } from '../scanner.js';
import { feedback } from '../feedback.js';
import { toast } from '../toast.js';
import { touch } from '../session.js';
import { replaceHash, navigate } from '../router.js';
import { openArticle } from './article-sheet.js';
import { setAccent, SCAN_FAMILY } from '../look.js';

// « find » : consultation (la fiche de la pièce s'ouvre), depuis la barre de recherche de l'accueil.
const MODES = { in: 'Entrée de stock', out: 'Sortie de stock', transfer: 'Transfert', find: 'Rechercher une pièce' };
const VERBS = { in: 'Valider l\'entrée', out: 'Valider la sortie', transfer: 'Créer le transfert' };
const PRESETS = [5, 10, 25];

const goLabel = (known = true) => (known ? `${VERBS[S.mode]} (${S.mode === 'in' ? '+' : '−'}${fmtInt(S.qty)})` : `Créer et recevoir (+${fmtInt(S.qty)})`);

const S = { mode: 'in', ean: null, qty: 1, reason: '', toDepotId: '', loc: '', draft: { name: '', family: '', threshold: '' }, recap: { count: 0, in: 0, out: 0 }, suggest: [], query: '', cam: 'idle', camError: '', torch: false };
let scanner = null;
let keyBuf = { text: '', at: 0 };
let keyHandler = null;
let searchTimer = null;

const otherDepots = () => Object.values(db().depots).filter((d) => d.id !== depot().id);
const article = () => (S.ean ? db().articles[S.ean] : null);

// ── Rendu : l'ossature est rendue une fois ; les zones sont ensuite mises à jour séparément
//    pour ne jamais détruire la vidéo en cours. ──
function render(r) {
  const mode = r.rest[0];
  if (MODES[mode]) S.mode = mode; else S.mode = prefs.get('scanMode', 'out');
  if (S.mode === 'transfer' && !otherDepots().length) S.mode = 'in';
  return html`
    <section class="scan" data-mode="${S.mode}">
      <div class="scan__mode" id="scan-mode"></div>
      <div class="scanner" id="scanner" data-state="idle">
        <div id="scanner-video" class="scanner__video"></div>
        <div class="reticle" aria-hidden="true"><i class="reticle__c reticle__c--tl"></i><i class="reticle__c reticle__c--tr"></i><i class="reticle__c reticle__c--bl"></i><i class="reticle__c reticle__c--br"></i><i class="reticle__line"></i></div>
        <button type="button" class="scanner__start" id="scanner-start" data-action="scan.camera"></button>
        <div class="scanner__bar"><button type="button" class="scanner__btn" id="torch-btn" data-action="scan.torch" aria-label="Lampe torche" hidden>${icon('flash')}</button><button type="button" class="scanner__btn" id="stop-btn" data-action="scan.camera.stop" aria-label="Arrêter la caméra" hidden>${icon('x')}</button></div>
      </div>
      <div class="scan__find">
        <form class="input-group" data-submit="scan.find" role="search">
          <input class="input input--mono" name="q" id="scan-q" type="text" inputmode="search" enterkeyhint="search" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Code-barres ou nom de la pièce" aria-label="Code-barres ou nom de la pièce" data-input="scan.search">
          <button type="submit" class="btn btn--primary btn--icon" aria-label="Rechercher">${icon('search')}</button>
        </form>
        <label class="btn btn--ghost btn--sm scan__photo" for="scan-photo">${icon('camera', 'i--sm')}Lire un code sur une photo</label>
        <input type="file" id="scan-photo" class="sr-only" accept="image/*" capture="environment" data-change="scan.photo">
        <div id="scan-suggest" aria-live="polite"></div>
      </div>
      <div id="scan-card"></div>
      <div id="scan-recap"></div>
    </section>`;
}

function paintMode() {
  if (S.mode === 'find') {
    setHtml($('#scan-mode'), html`<p class="muted scan__find-hint">${icon('info', 'i--sm')} Scannez ou saisissez une pièce : sa fiche s'ouvre (stock, emplacements, historique).</p>`);
    document.querySelector('.scan')?.setAttribute('data-mode', 'find');
    $('#topbar-title').textContent = MODES.find;
    setAccent(SCAN_FAMILY.find);
    return;
  }
  const items = [
    { value: 'in', label: 'Entrée', tone: 'in', icon: 'in' },
    { value: 'out', label: 'Sortie', tone: 'out', icon: 'out' },
    ...(otherDepots().length ? [{ value: 'transfer', label: 'Transfert', tone: 'transfer', icon: 'swap' }] : []),
  ];
  setHtml($('#scan-mode'), segmented({ action: 'scan.mode', value: S.mode, items, label: 'Type d\'opération' }));
  document.querySelector('.scan')?.setAttribute('data-mode', S.mode);
  $('#topbar-title').textContent = MODES[S.mode];
  setAccent(SCAN_FAMILY[S.mode]); // barre du haut, caméra et bouton : vert (entrée), rouge (sortie), bleu (transfert)
}

function paintCamera() {
  const box = $('#scanner');
  if (!box) return;
  box.dataset.state = S.cam;
  const start = $('#scanner-start');
  const msg = {
    idle: html`${icon('scan', 'i--xl')}<span class="scanner__title">Appuyer pour scanner</span><span class="scanner__hint">Code-barres EAN ou QR d'emplacement</span>`,
    starting: html`<span class="spinner" role="status"></span><span class="scanner__hint">Démarrage de la caméra…</span>`,
    live: '', paused: '',
    error: html`${icon('camera', 'i--xl')}<span class="scanner__title">Caméra indisponible</span><span class="scanner__hint">${S.camError}</span><span class="scanner__retry">Réessayer</span>`,
  }[S.cam];
  setHtml(start, msg || html``);
  start.hidden = S.cam === 'live' || S.cam === 'paused';
  $('#stop-btn').hidden = !(S.cam === 'live' || S.cam === 'paused');
  $('#torch-btn').hidden = !(S.cam === 'live' && scanner?.hasTorch());
}

function paintSuggest() {
  const host = $('#scan-suggest');
  if (!host) return;
  if (!S.query) { setHtml(host, html``); return; }
  const q = S.query;
  const rows = S.suggest;
  const digits = /^\d+$/.test(q);
  const canCreate = can('article.create') && S.mode === 'in' && !digits && q.length >= 2;
  setHtml(host, html`<div class="list scan__suggest">
    ${digits && isCode(q) && !db().articles[q] ? html`<button type="button" class="row" data-action="scan.pick" data-ean="${q}"><span class="row__lead thumb">${icon('barcode')}</span><span class="row__body"><span class="row__title">Utiliser le code ${q}</span><span class="row__meta">Code inconnu${S.mode === 'in' ? ' — vous pourrez créer la pièce' : ''}</span></span></button>` : ''}
    ${rows.map((x) => articleRow(x, { action: 'scan.pick' }))}
    ${canCreate ? html`<button type="button" class="row" data-action="scan.newcode"><span class="row__lead thumb">${icon('plus')}</span><span class="row__body"><span class="row__title">Créer « ${q} » sans code-barres</span><span class="row__meta">Un code interne EAN-13 sera généré (étiquette imprimable)</span></span></button>` : ''}
    ${!rows.length && !digits && !canCreate ? html`<p class="muted pad">Aucune pièce ne correspond.</p>` : ''}
  </div>`);
}

function paintRecap() {
  const host = $('#scan-recap');
  if (!host) return;
  const r = S.recap;
  if (!r.count) { setHtml(host, html``); return; }
  setHtml(host, html`<div class="recap"><span>${icon('check', 'i--sm')} <strong>${r.count}</strong> opération${r.count > 1 ? 's' : ''} · <span class="recap__in">+${fmtInt(r.in)}</span> / <span class="recap__out">−${fmtInt(r.out)}</span></span>
    <button type="button" class="btn btn--text" data-action="scan.done">Terminer</button></div>`);
}

function paintCard() {
  const host = $('#scan-card');
  if (!host) return;
  if (!S.ean) { setHtml(host, tips()); return; }
  const a = article();
  setHtml(host, a ? knownCard(a) : unknownCard());
}

const tips = () => html`<div class="scan__tips">
  <p>${icon('info', 'i--sm')} Visez un code-barres ou un QR : la fiche s'ouvre et la caméra se fige.</p>
  <p>${icon('search', 'i--sm')} Pas de code lisible ? Tapez le nom de la pièce ci-dessus.</p></div>`;

function qtyBlock() {
  return html`<div class="field"><span class="field__label">Quantité</span>
    <div class="qty"><button type="button" class="qty__btn" data-action="scan.qty" data-delta="-1" aria-label="Moins un">${icon('minus')}</button>
      <input class="qty__input" name="qty" type="number" inputmode="numeric" min="1" step="1" value="${S.qty}" aria-label="Quantité" data-input="scan.qty.input">
      <button type="button" class="qty__btn" data-action="scan.qty" data-delta="1" aria-label="Plus un">${icon('plus')}</button></div>
    <div class="presets">${PRESETS.map((n) => html`<button type="button" class="chip" data-action="scan.qty" data-delta="${n}">+${n}</button>`)}</div></div>`;
}

function reasonChips() {
  const list = REASONS[S.mode];
  if (!list) return '';
  return html`<div class="field"><span class="field__label">Motif (facultatif)</span><div class="chips chips--wrap" role="group" aria-label="Motif">${list.map((r) => html`<button type="button" class="chip" data-action="scan.reason" data-value="${r}" aria-pressed="${String(S.reason === r)}">${r}</button>`)}</div></div>`;
}

function knownCard(a) {
  const d = depot();
  const qty = stockOf(db(), d.id, a.ean);
  const status = stockStatus(levelOf(db(), d.id, a).min, qty);
  const locs = articleLocations(db(), a.ean, d.id);
  const others = Object.values(db().depots).filter((x) => x.id !== d.id).map((x) => ({ name: x.code || x.name, qty: stockOf(db(), x.id, a.ean) })).filter((x) => x.qty > 0);
  const weak = a.ean.length === 13 && hasValidCheck(a.ean) === false;
  const def = locs[0] ? locCode(locs[0]) : '';
  return html`
    <article class="card scan-card">
      <header class="scan-card__head">
        ${thumb(a, 'thumb--lg')}
        <div class="grow"><p class="eyebrow">${a.family || 'Sans famille'}</p><h3 class="scan-card__name">${a.name}</h3><p class="muted num">${a.ean}${a.ref ? ` · ${a.ref}` : ''}</p></div>
        <button type="button" class="icon-btn" data-action="scan.clear" aria-label="Changer de pièce">${icon('x')}</button>
      </header>
      ${weak ? html`<p class="banner banner--info scan-card__warn">${icon('alert', 'i--sm')}<span class="banner__text">Clé de contrôle EAN inhabituelle — vérifiez le code.</span></p>` : ''}
      <div class="scan-card__stock"><span>En stock ici</span><strong class="num ${status === 'zero' ? 'text-red' : status === 'low' ? 'text-amber' : ''}">${fmtInt(qty)}</strong>${statusPill(status)}
        ${others.length ? html`<span class="muted scan-card__others">${others.map((o) => `${o.name} : ${fmtInt(o.qty)}`).join(' · ')}</span>` : ''}</div>
      ${S.mode === 'out' || S.mode === 'transfer' ? (locs.length ? html`<p class="scan-card__loc">${icon('pin', 'i--sm')} Prélever en <strong>${locCode(locs[0])}</strong>${locs.length > 1 ? html` <span class="muted">· aussi ${locs.slice(1).map(locCode).join(', ')}</span>` : ''}</p>` : '') : html`
        <div class="field"><label class="field__label" for="scan-loc">Rangement${def ? ' (par défaut ' + def + ')' : ''}</label>
          <input class="input input--mono" id="scan-loc" name="loc" list="scan-locs" autocomplete="off" autocapitalize="characters" placeholder="R1-A2-E1" value="${S.loc || def}" data-input="scan.loc">
          <datalist id="scan-locs">${depotLocationCodes(db(), d.id).map((c) => html`<option value="${c}"></option>`)}</datalist>
          ${locs.length > 1 ? html`<div class="chips chips--wrap">${locs.map((l) => html`<button type="button" class="chip" data-action="scan.useloc" data-value="${locCode(l)}">${locCode(l)}</button>`)}</div>` : ''}</div>`}
      ${qtyBlock()}
      ${S.mode === 'transfer' ? html`<label class="field"><span class="field__label">Dépôt destinataire</span>
        <select class="select" name="to" data-change="scan.to">${otherDepots().map((x) => html`<option value="${x.id}" ${x.id === (S.toDepotId || otherDepots()[0]?.id) ? 'selected' : ''}>${x.name}</option>`)}</select></label>` : reasonChips()}
      <button type="button" class="btn btn--${S.mode} btn--block scan-card__go" data-action="scan.confirm">${goLabel()}</button>
    </article>`;
}

function unknownCard() {
  const canMake = can('article.create');
  return html`
    <article class="card scan-card">
      <header class="scan-card__head">
        <span class="thumb thumb--lg">${icon('plus')}</span>
        <div class="grow"><p class="eyebrow">Code inconnu</p><h3 class="scan-card__name num">${S.ean}</h3></div>
        <button type="button" class="icon-btn" data-action="scan.clear" aria-label="Changer de code">${icon('x')}</button>
      </header>
      ${S.mode !== 'in' ? html`<p class="muted">Cette pièce n'est pas encore au catalogue : il n'y a rien à ${{ out: 'sortir', find: 'consulter' }[S.mode] ?? 'transférer'}.</p>
        ${canMake ? html`<button type="button" class="btn btn--in btn--block" data-action="scan.mode" data-value="in">Créer la pièce (entrée)</button>` : ''}`
        : canMake ? html`
        <p class="muted">Nouvelle pièce : complétez la fiche, elle sera créée avec l'entrée.</p>
        <label class="field"><span class="field__label">Désignation</span><input class="input" name="name" maxlength="120" autocomplete="off" placeholder="Pièce ${S.ean}" value="${S.draft.name}" data-input="scan.draft" data-autofocus></label>
        <div class="grid2"><label class="field"><span class="field__label">Famille</span><input class="input" name="family" list="scan-fams" maxlength="60" autocomplete="off" value="${S.draft.family}" data-input="scan.draft"><datalist id="scan-fams">${families(db()).map((f) => html`<option value="${f}"></option>`)}</datalist></label>
          <label class="field"><span class="field__label">Seuil d'alerte</span><input class="input" name="threshold" type="number" inputmode="numeric" min="0" placeholder="0" value="${S.draft.threshold}" data-input="scan.draft"></label></div>
        <div class="field"><label class="field__label" for="scan-loc">Rangement</label><input class="input input--mono" id="scan-loc" name="loc" list="scan-locs" autocomplete="off" autocapitalize="characters" placeholder="R1-A2-E1" value="${S.loc}" data-input="scan.loc">
          <datalist id="scan-locs">${depotLocationCodes(db(), depot().id).map((c) => html`<option value="${c}"></option>`)}</datalist></div>
        ${qtyBlock()}${reasonChips()}
        <button type="button" class="btn btn--in btn--block scan-card__go" data-action="scan.confirm">${goLabel(false)}</button>`
        : html`<p class="muted">Votre rôle ne permet pas de créer une pièce. Demandez à un responsable.</p>`}
    </article>`;
}

// ── Logique ──
function setMode(mode) {
  if (!MODES[mode] || mode === 'find' || (mode === 'transfer' && !otherDepots().length)) return;
  S.mode = mode; S.reason = '';
  prefs.set('scanMode', mode);
  replaceHash(`scan/${mode}`);
  paintMode(); paintCard();
}

function pick(ean) {
  ean = String(ean ?? '').trim();
  if (!isCode(ean)) { toast('Code non reconnu.', { tone: 'error' }); feedback('error'); return; }
  S.ean = ean; S.qty = 1; S.reason = ''; S.loc = ''; S.draft = { name: '', family: '', threshold: '' };
  S.query = ''; S.suggest = [];
  const input = $('#scan-q'); if (input) input.value = '';
  paintSuggest();
  if (S.mode === 'find' && db().articles[ean]) { feedback('scan'); S.ean = null; openArticle(ean); return; }
  scanner?.pause();
  if (scanner) { S.cam = scanner.running ? 'paused' : S.cam; paintCamera(); }
  paintCard();
  $('#scan-card')?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
  $('#scan-card [data-autofocus]')?.focus({ preventScroll: true });
}

function reset({ resume = true } = {}) {
  S.ean = null; S.qty = 1; S.reason = ''; S.loc = ''; S.draft = { name: '', family: '', threshold: '' };
  paintCard();
  if (resume && scanner?.running) { scanner.resume(); S.cam = 'live'; paintCamera(); }
  else $('#scan-q')?.focus({ preventScroll: true });
}

function onCode(text) {
  touch();
  const loc = parseLocationPayload(text);
  if (loc) {
    feedback('scan');
    S.loc = loc.code;
    const input = $('#scan-loc'); if (input) input.value = loc.code;
    toast(`Emplacement ${loc.code}`);
    return;
  }
  if (!isCode(text)) { feedback('error'); toast('Code illisible ou non pris en charge.', { tone: 'error' }); return; }
  feedback('scan');
  pick(text);
}

async function startCamera() {
  if (!scannerAvailable()) { S.cam = 'error'; S.camError = 'Le module de scan n\'a pas pu être chargé. Saisissez le code à la main.'; paintCamera(); return; }
  scanner ??= createScanner({ containerId: 'scanner-video', onCode });
  S.cam = 'starting'; paintCamera();
  try {
    await scanner.start();
    S.cam = S.ean ? 'paused' : 'live';
    if (S.ean) scanner.pause();
  } catch (e) {
    await scanner.stop();
    S.cam = 'error'; S.camError = cameraErrorMessage(e);
  }
  paintCamera();
}

function readCard() {
  const card = $('#scan-card');
  return {
    qty: toInt($('#scan-card [name=qty]')?.value ?? S.qty),
    loc: val(card, 'loc'),
    to: card.querySelector('[name=to]')?.value || S.toDepotId || otherDepots()[0]?.id,
    draft: { name: val(card, 'name'), family: val(card, 'family'), threshold: val(card, 'threshold') },
  };
}

function afterSuccess({ label, units, sign, undo }) {
  feedback('ok');
  S.recap.count++;
  if (sign > 0) S.recap.in += units; else S.recap.out += units;
  paintRecap();
  toast(label, { tone: 'ok', action: { label: 'Annuler', run: () => { try { undo(); toast('Opération annulée.'); } catch (e) { toast(e.message, { tone: 'error' }); } } } });
  reset();
}

export const scanRoute = {
  title: (r) => MODES[r.rest[0]] ?? MODES[S.mode] ?? 'Scanner',
  nav: 'scan',
  refresh: 'none',
  render,
  mount(root, r) {
    paintMode(); paintCamera(); paintSuggest(); paintCard(); paintRecap();
    const pre = r.params.get('ean');
    if (pre && isCode(pre)) pick(pre);
    // Douchette (clavier) : une rafale de chiffres terminée par Entrée = un code lu
    keyHandler = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '')) return;
      const now = performance.now();
      if (now - keyBuf.at > 80) keyBuf.text = '';
      keyBuf.at = now;
      if (/^[0-9A-Za-z:-]$/.test(e.key)) keyBuf.text += e.key;
      else if (e.key === 'Enter' && keyBuf.text.length >= 8) { const t = keyBuf.text; keyBuf.text = ''; onCode(t); }
    };
    document.addEventListener('keydown', keyHandler);
    // Caméra : démarrage automatique seulement si l'autorisation a déjà été accordée (pas de demande surprise)
    navigator.permissions?.query?.({ name: 'camera' }).then((p) => { if (p.state === 'granted' && S.cam === 'idle' && $('#scanner')) startCamera(); }).catch(() => {});
  },
  unmount() {
    if (keyHandler) document.removeEventListener('keydown', keyHandler);
    keyHandler = null;
    clearTimeout(searchTimer);
    scanner?.stop();
    scanner = null;
    S.cam = 'idle'; S.ean = null; S.query = ''; S.suggest = [];
  },
};

export function initScan() {
  actions({
    'scan.mode': (el) => setMode(el.dataset.value),
    'scan.camera': () => startCamera(),
    async 'scan.camera.stop'() { await scanner?.stop(); scanner = null; S.cam = 'idle'; paintCamera(); },
    async 'scan.torch'(el) { const on = await scanner?.toggleTorch(); if (on === null) toast('Lampe torche indisponible.'); el.setAttribute('aria-pressed', String(Boolean(on))); },
    'scan.search'(el) {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        S.query = el.value.trim();
        S.suggest = S.query ? searchArticles(db(), depot().id, { q: S.query, sort: 'name' }).slice(0, 6) : [];
        paintSuggest();
      }, 120);
    },
    'scan.find'(form) {
      const q = val(form, 'q');
      if (isCode(q)) return pick(q);
      const found = searchArticles(db(), depot().id, { q, sort: 'name' });
      if (found.length === 1) return pick(found[0].article.ean);
      if (!q) return toast('Saisissez un code ou un nom.');
      S.query = q; S.suggest = found.slice(0, 6); paintSuggest();
      if (!found.length) toast('Aucune pièce trouvée.', { tone: 'error' });
    },
    'scan.pick': (el) => pick(el.dataset.ean),
    'scan.newcode': () => {
      const name = S.query;
      pick(nextInternalEan(Object.keys(db().articles)));
      S.draft.name = name; paintCard();
    },
    async 'scan.photo'(input) {
      const file = input.files?.[0];
      if (!file) return;
      const code = await decodePhoto(file);
      input.value = '';
      if (!code) { feedback('error'); toast('Aucun code lisible sur la photo. Rapprochez-vous et réessayez.', { tone: 'error' }); return; }
      onCode(code);
    },
    'scan.clear': () => reset(),
    'scan.qty': (el) => { S.qty = Math.max(1, (toInt($('#scan-card [name=qty]')?.value) || S.qty) + Number(el.dataset.delta)); paintCard(); },
    'scan.qty.input': (el) => {
      const n = toInt(el.value);
      if (Number.isNaN(n) || n < 1) return;
      S.qty = n;
      const go = $('#scan-card .scan-card__go');
      if (go) go.textContent = goLabel(Boolean(article()));
    },
    'scan.reason': (el) => { S.reason = S.reason === el.dataset.value ? '' : el.dataset.value; paintCard(); },
    'scan.loc': (el) => { S.loc = el.value; },
    'scan.useloc': (el) => { S.loc = el.dataset.value; const i = $('#scan-loc'); if (i) i.value = S.loc; },
    'scan.draft': (el) => { S.draft[el.name] = el.value; },
    'scan.to': (el) => { S.toDepotId = el.value; },
    'scan.done': () => { S.recap = { count: 0, in: 0, out: 0 }; navigate('home'); },
    'scan.confirm'(el) {
      const f = readCard();
      if (Number.isNaN(f.qty) || f.qty < 1) { toast('Quantité invalide : entier ≥ 1.', { tone: 'error' }); return; }
      el.disabled = true;
      try {
        const a = db().articles[S.ean];
        if (S.mode === 'transfer') {
          const r = run(createTransfer, { ean: S.ean, qty: f.qty, toDepotId: f.to });
          const to = db().depots[f.to];
          afterSuccess({ label: `${f.qty} × ${a.name} → ${to.name}`, units: f.qty, sign: -1, undo: () => run(cancelTransfer, { id: r.transferId }) });
        } else {
          const r = run(moveStock, { type: S.mode, ean: S.ean, qty: f.qty, reason: S.reason, locCode: f.loc || undefined, article: !a ? f.draft : undefined });
          const name = db().articles[S.ean].name;
          afterSuccess({
            label: `${S.mode === 'in' ? '+' : '−'}${fmtInt(f.qty)} × ${name} · stock ${fmtInt(r.stock)}${r.alert ? ' ⚠' : ''}`,
            units: f.qty, sign: S.mode === 'in' ? 1 : -1, undo: () => run(undoMovement, { historyId: r.historyId }),
          });
        }
      } catch (e) { el.disabled = false; feedback('error'); throw e; }
    },
  });
}

