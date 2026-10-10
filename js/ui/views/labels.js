// Étiquettes (fonction avancée) : choisir des pièces ou des emplacements, le nombre d'exemplaires, puis
// imprimer sur l'imprimante de CET appareil (bureau : planches A4 ; thermique : rouleau, impression
// système ou fichier ZPL). Le profil d'imprimante est une préférence d'appareil.
import { html, fmtInt, plural, localDay } from '../../lib/text.js';
import { LABEL_FORMATS, PRINTER_TYPES, normalizePrinter, toZpl } from '../../lib/labels.js';
import { isCode } from '../../lib/ean.js';
import { icon, actions, $, setHtml, val, download } from '../dom.js';
import { db, depot, prefs } from '../state.js';
import { searchArticles, articleLocations, locCode, reorderList, resolveEan } from '../../core/queries.js';
import { pageHead, segmented, emptyState } from '../components.js';
import { openSheet, closeSheet } from '../dialogs.js';
import { printLabelJob, printerProfile, articleItem, locationItem } from '../print.js';
import { navigate } from '../router.js';
import { toast } from '../toast.js';
import { feedback } from '../feedback.js';
import { codeBar, listenWedge, openCamera } from '../codebar.js';

const L = { tab: 'articles', picks: new Map(), q: '', rack: '', skip: 0 };
let stopWedge = null;

export const printerLabel = () => {
  const p = printerProfile();
  return `${p.type === 'thermal' ? 'thermique' : 'bureau'} · ${LABEL_FORMATS[p.format].name.split(' · ').pop()}`;
};

/** Pré-remplit l'écran (ex. après une réception : une étiquette par pièce reçue). `picks` : [{ean, copies}] */
export function presetLabels(picks) {
  L.tab = 'articles';
  L.picks = new Map(picks.filter((p) => p.copies > 0).map((p) => [p.ean, p.copies]));
  navigate('labels');
}

// ── Profil d'imprimante (préférence d'appareil) ──
export function printerSheet() {
  const p = printerProfile();
  openSheet({
    title: 'Imprimante d\'étiquettes',
    body: html`<form class="stack" data-submit="labels.printer.save" novalidate>
      <p class="muted">Réglage propre à cet appareil. Une imprimante thermique (Intermec, Honeywell…) s'utilise via son pilote (impression système) ou en fichier ZPL si son émulation ZPL est activée.</p>
      <div class="field"><span class="field__label">Type</span>
        ${segmented({ action: 'labels.printer.type', value: p.type, label: 'Type d\'imprimante', items: Object.entries(PRINTER_TYPES).map(([value, t]) => ({ value, label: value === 'office' ? 'Bureau (A4)' : 'Thermique' })) })}</div>
      <label class="field"><span class="field__label">Format</span><select class="select" name="format">${PRINTER_TYPES[p.type].formats.map((f) => html`<option value="${f}" ${f === p.format ? 'selected' : ''}>${LABEL_FORMATS[f].name}</option>`)}</select></label>
      ${p.type === 'thermal' ? html`
        <label class="field"><span class="field__label">Résolution</span><select class="select" name="dpi">${[203, 300, 406].map((d) => html`<option value="${d}" ${d === p.dpi ? 'selected' : ''}>${d} dpi</option>`)}</select></label>
        <label class="field"><span class="field__label">Envoi</span><select class="select" name="output">
          <option value="print" ${p.output === 'print' ? 'selected' : ''}>Impression système (pilote installé)</option>
          <option value="zpl" ${p.output === 'zpl' ? 'selected' : ''}>Fichier ZPL à transmettre à l'imprimante</option></select></label>` : ''}
      <div class="grid2">
        <label class="field"><span class="field__label">Décalage horizontal (mm)</span><input class="input input--mono" name="offsetX" type="number" step="0.5" min="-10" max="10" value="${p.offsetX}"></label>
        <label class="field"><span class="field__label">Décalage vertical (mm)</span><input class="input input--mono" name="offsetY" type="number" step="0.5" min="-10" max="10" value="${p.offsetY}"></label></div>
      <p class="field__hint">Le décalage corrige une impression légèrement à côté des étiquettes (calibrage).</p>
      <button type="submit" class="btn btn--primary btn--block">Enregistrer</button>
      <button type="button" class="btn btn--secondary btn--block" data-action="labels.test">${icon('printer')}Imprimer une étiquette de test</button></form>`,
  });
}

function readPrinterForm(form) {
  return normalizePrinter({ ...printerProfile(), format: val(form, 'format'), dpi: val(form, 'dpi') || printerProfile().dpi, output: val(form, 'output') || 'print', offsetX: val(form, 'offsetX'), offsetY: val(form, 'offsetY') });
}

// ── Écran ──
function picked() {
  return [...L.picks.entries()].map(([ean, copies]) => ({ a: db().articles[ean], copies })).filter((x) => x.a);
}

function results() {
  const rows = L.q ? searchArticles(db(), depot().id, { q: L.q, sort: 'name' }).slice(0, 8) : [];
  return rows.length ? html`<ul class="list labels__results">${rows.map((r) => html`<li><button type="button" class="row" data-action="labels.add" data-ean="${r.article.ean}"><span class="row__body"><span class="row__title">${r.article.name}</span><span class="row__meta num">${r.article.ean}</span></span>${icon('plus', 'i--sm')}</button></li>`)}</ul>` : '';
}

function articlesTab() {
  const list = picked();
  return html`
    ${codeBar({ id: 'labels-q', placeholder: 'Scanner ou rechercher une pièce', submit: 'labels.find', input: 'labels.search', camera: 'labels.camera' })}
    <div class="chips chips--wrap labels__quick">
      <button type="button" class="chip" data-action="labels.alerts">${icon('alert', 'i--sm')}Pièces sous le seuil</button>
      ${list.length ? html`<button type="button" class="chip" data-action="labels.clear">${icon('x', 'i--sm')}Vider la liste</button>` : ''}</div>
    <div id="labels-results" aria-live="polite">${results()}</div>
    ${list.length ? html`<h3 class="eyebrow section-title">${plural(list.length, 'pièce')} · ${plural(list.reduce((n, x) => n + x.copies, 0), 'étiquette')}</h3>
      <ul class="list">${list.map(({ a, copies }) => html`<li class="row row--compact"><span class="row__body"><span class="row__title">${a.name}</span><span class="row__meta num">${a.ean}</span></span>
        <span class="mini-qty"><button type="button" class="mini-qty__btn" data-action="labels.copies" data-ean="${a.ean}" data-delta="-1" aria-label="Une étiquette de moins">${icon('minus', 'i--sm')}</button><span class="mini-qty__val num">${copies}<span class="sr-only"> exemplaire(s)</span></span><button type="button" class="mini-qty__btn" data-action="labels.copies" data-ean="${a.ean}" data-delta="1" aria-label="Une étiquette de plus">${icon('plus', 'i--sm')}</button></span></li>`)}</ul>`
      : emptyState({ icon: 'tag', title: 'Aucune pièce choisie', text: 'Scannez ou recherchez les pièces à étiqueter.' })}`;
}

function locationsTab() {
  const d = depot();
  const locs = Object.values(db().locations).filter((l) => l.depotId === d.id).sort((a, b) => locCode(a).localeCompare(locCode(b), 'fr', { numeric: true }));
  const racks = [...new Set(locs.map((l) => l.rack).filter(Boolean))];
  const shown = L.rack ? locs.filter((l) => l.rack === L.rack) : locs;
  return html`${racks.length > 1 ? html`<div class="chips chips--wrap">${['', ...racks].map((r) => html`<button type="button" class="chip" data-action="labels.rack" data-value="${r}" aria-pressed="${String(L.rack === r)}">${r || 'Tous les racks'}</button>`)}</div>` : ''}
    ${shown.length ? html`<p class="muted pad">${plural(shown.length, 'emplacement')} · une étiquette QR chacun.</p>` : emptyState({ icon: 'pin', title: 'Aucun emplacement', text: 'Créez les emplacements dans Administration.' })}`;
}

function jobList() {
  if (L.tab === 'locations') {
    const d = depot();
    return Object.values(db().locations).filter((l) => l.depotId === d.id && (!L.rack || l.rack === L.rack))
      .sort((a, b) => locCode(a).localeCompare(locCode(b), 'fr', { numeric: true })).map((l) => ({ item: locationItem(l, d), copies: 1 }));
  }
  return picked().map(({ a, copies }) => ({ item: articleItem(a, locCode(articleLocations(db(), a.ean, depot().id)[0])), copies }));
}

function paint() {
  const host = $('#labels-body');
  if (!host) return;
  const p = printerProfile();
  const total = jobList().reduce((n, x) => n + x.copies, 0);
  const f = LABEL_FORMATS[p.format];
  setHtml(host, html`
    <div class="card printer-card"><span class="printer-card__icon">${icon('printer')}</span><span class="grow"><strong>${p.type === 'thermal' ? 'Imprimante thermique' : 'Imprimante de bureau'}</strong><span class="muted printer-card__fmt">${f.name}${p.type === 'thermal' ? ` · ${p.dpi} dpi · ${p.output === 'zpl' ? 'fichier ZPL' : 'impression système'}` : ''}</span></span>
      <button type="button" class="btn btn--text" data-action="labels.printer">Modifier</button></div>
    ${segmented({ action: 'labels.tab', value: L.tab, label: 'Type d\'étiquettes', items: [{ value: 'articles', label: 'Pièces', icon: 'tag' }, { value: 'locations', label: 'Emplacements', icon: 'qr' }] })}
    <div class="labels__panel">${L.tab === 'articles' ? articlesTab() : locationsTab()}</div>
    ${f.kind === 'sheet' ? html`<label class="field"><span class="field__label">Planche entamée : cases déjà utilisées</span><input class="input input--mono" type="number" min="0" max="${f.cols * f.rows - 1}" value="${L.skip}" data-input="labels.skip"></label>` : ''}
    <div class="sticky-action"><button type="button" class="btn btn--primary btn--block" data-action="labels.print" ${total ? '' : 'disabled'}>${icon(p.output === 'zpl' ? 'download' : 'printer')}${p.output === 'zpl' ? 'Télécharger' : 'Imprimer'} ${plural(total, 'étiquette')}</button></div>`);
}

function addEan(scanned) {
  const code = resolveEan(db(), scanned);
  if (!code) { feedback('error'); toast(`Code ${scanned} inconnu du catalogue.`, { tone: 'error' }); return false; }
  feedback('scan');
  L.picks.set(code, (L.picks.get(code) ?? 0) + 1);
  L.q = '';
  paint();
  return true;
}

export const labelsRoute = {
  title: 'Étiquettes', back: true, perm: 'labels', refresh: 'none',
  render: () => html`<section>${pageHead({ eyebrow: 'Impression', title: 'Étiquettes', sub: depot().name })}<div id="labels-body" class="pad stack"></div></section>`,
  mount() { paint(); stopWedge?.(); stopWedge = listenWedge((code) => { L.tab = 'articles'; addEan(code); }); },
  unmount() { stopWedge?.(); stopWedge = null; },
};

export function initLabels() {
  actions({
    'labels.tab': (el) => { L.tab = el.dataset.value; paint(); },
    'labels.search': (el) => { L.q = el.value.trim(); const host = $('#labels-results'); if (host) setHtml(host, html`${results()}`); },
    'labels.find'(form) {
      const q = val(form, 'q');
      if (isCode(q)) { addEan(q); return; }
      const found = searchArticles(db(), depot().id, { q, sort: 'name' });
      if (found.length === 1) addEan(found[0].article.ean);
      else if (!found.length) { feedback('error'); toast('Aucune pièce trouvée.', { tone: 'error' }); }
    },
    'labels.camera': () => openCamera({ title: 'Scanner des pièces', onCode: (code) => { addEan(code); return true; } }),
    'labels.add': (el) => addEan(el.dataset.ean),
    'labels.copies': (el) => {
      const n = (L.picks.get(el.dataset.ean) ?? 0) + Number(el.dataset.delta);
      if (n <= 0) L.picks.delete(el.dataset.ean); else L.picks.set(el.dataset.ean, Math.min(500, n));
      paint();
    },
    'labels.alerts': () => { for (const r of reorderList(db(), depot().id)) if (!L.picks.has(r.article.ean)) L.picks.set(r.article.ean, 1); paint(); },
    'labels.clear': () => { L.picks.clear(); paint(); },
    'labels.rack': (el) => { L.rack = el.dataset.value; paint(); },
    'labels.skip': (el) => { L.skip = Math.max(0, Math.floor(Number(el.value)) || 0); },
    'labels.print'() {
      const job = jobList();
      const p = printerProfile();
      if (p.output === 'zpl') {
        download(`etiquettes-${localDay()}.zpl`, toZpl(job, { format: p.format, dpi: p.dpi }), 'text/plain');
        toast('Fichier ZPL téléchargé : envoyez-le à l\'imprimante (outil du fabricant, partage réseau ou USB).', { tone: 'ok', ms: 7000 });
        return;
      }
      const n = printLabelJob(job, { profile: p, skip: L.skip });
      toast(`${fmtInt(n)} étiquette(s) envoyée(s) à l'impression.`, { tone: 'ok' });
    },
    'labels.printer': () => printerSheet(),
    'labels.printer.type'(el) {
      prefs.set('printer', normalizePrinter({ ...printerProfile(), type: el.dataset.value, format: '' }));
      printerSheet();
    },
    async 'labels.printer.save'(form) {
      prefs.set('printer', readPrinterForm(form));
      await closeSheet();
      toast('Imprimante enregistrée pour cet appareil.', { tone: 'ok' });
      paint();
    },
    'labels.test'(el) {
      const p = readPrinterForm(el.closest('form'));
      const sample = { item: { kind: 'article', ean: '3700089690011', name: 'Étiquette de test — MODE', ref: 'TEST', loc: 'R1-A1-E1' }, copies: 1 };
      if (p.output === 'zpl') download('etiquette-test.zpl', toZpl([sample], { format: p.format, dpi: p.dpi }), 'text/plain');
      else printLabelJob([sample], { profile: p });
    },
  });
}
