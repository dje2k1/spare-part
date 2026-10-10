// Impression sans fenêtre surgissante : le contenu est injecté dans #print-root puis window.print().
// (Les popups sont bloquées sur mobile ; print.css masque tout le reste de la page à l'impression.)
// La taille de page est fixée au moment d'imprimer (planche A4, ou étiquette de rouleau au millimètre).
import { html } from '../lib/text.js';
import { ean13Svg, hasValidCheck } from '../lib/ean.js';
import { qrSvg, locationPayload } from '../lib/qr.js';
import { LABEL_FORMATS, sheetPages, expandCopies, normalizePrinter } from '../lib/labels.js';
import { $, setHtml, cssVars } from './dom.js';
import { locCode } from '../core/queries.js';
import { prefs } from './state.js';

function setPageRule(css) {
  let el = document.getElementById('print-page-rule');
  if (!el) { el = document.createElement('style'); el.id = 'print-page-rule'; document.head.append(el); }
  el.textContent = css;
}

function printNow(content, pageRule = '') {
  const root = $('#print-root');
  setHtml(root, content);
  setPageRule(pageRule);
  const clear = () => { setHtml(root, html``); setPageRule(''); window.removeEventListener('afterprint', clear); };
  window.addEventListener('afterprint', clear);
  // Laisse le navigateur peindre le contenu avant d'ouvrir la boîte d'impression
  requestAnimationFrame(() => setTimeout(() => window.print(), 50));
}

// ── Étiquettes ──
export const printerProfile = () => normalizePrinter(prefs.get('printer', null));

/** Contenu d'étiquette depuis le modèle de données. */
export const articleItem = (a, loc = '') => ({ kind: 'article', ean: a.ean, name: a.name, ref: a.ref, loc, family: a.family });
export const locationItem = (l, depot) => ({ kind: 'location', code: locCode(l), desc: l.desc || '', depot: depot?.name ?? '', payload: locationPayload(locCode(l), l.depotId) });

function labelHtml(item, small) {
  if (item.kind === 'location') {
    return html`<div class="lbl__in lbl__in--loc">${qrSvg(item.payload, { label: `Emplacement ${item.code}` })}<div class="lbl__text"><div class="lbl__code lbl__code--big">${item.code}</div><div class="lbl__meta">${item.desc}${item.desc && item.depot ? ' · ' : ''}${item.depot}</div></div></div>`;
  }
  const bars = item.ean.length === 13 && hasValidCheck(item.ean) !== false ? ean13Svg(item.ean) : qrSvg(item.ean, { label: item.ean });
  const meta = [item.loc, item.ref].filter(Boolean).join(' · ');
  return html`<div class="lbl__in"><div class="lbl__name">${item.name}</div>${bars}<div class="lbl__code">${item.ean}</div>${meta && !small ? html`<div class="lbl__meta">${meta}</div>` : ''}</div>`;
}

/**
 * Imprime des étiquettes selon le profil de l'appareil. `list` : [{item, copies}]. `skip` : cases déjà
 * utilisées sur une planche A4 entamée.
 */
export function printLabelJob(list, { profile = printerProfile(), skip = 0 } = {}) {
  const f = LABEL_FORMATS[profile.format];
  const items = expandCopies(list);
  if (!items.length) return 0;
  if (f.kind === 'sheet') {
    const pages = sheetPages(items, profile.format, { skip, offsetX: profile.offsetX, offsetY: profile.offsetY });
    printNow(html`${pages.map((p) => html`<div class="lbl-page">${p.cells.map((c) => html`<div class="lbl lbl--sheet ${f.cut ? 'lbl--cut' : ''}" style="${cssVars({ x: c.x, y: c.y, w: f.w, h: f.h }, 'mm')}">${labelHtml(c.item, false)}</div>`)}</div>`)}`,
      '@page { size: A4 portrait; margin: 0; }');
  } else {
    const small = f.h < 30;
    printNow(html`${items.map((it) => html`<div class="lbl lbl--roll ${small ? 'lbl--small' : ''}" style="${cssVars({ w: f.w, h: f.h, ox: profile.offsetX, oy: profile.offsetY }, 'mm')}">${labelHtml(it, small)}</div>`)}`,
      `@page { size: ${f.w}mm ${f.h}mm; margin: 0; }`);
  }
  return items.length;
}

/** Compatibilité : étiquettes simples (fiche article, emplacements). */
export function printLabels(items, { copies = 1 } = {}) {
  return printLabelJob(items.map((it) => ({ item: it.kind === 'article' ? articleItem(it.article, it.loc) : locationItem(it.loc, it.depot), copies })));
}

// ── Documents (état de stock, bon de livraison, bon de commande, rapport) ──
/**
 * Document tabulaire générique. columns : [{label, num?}] ; rows : tableaux de valeurs ; `alert` : index
 * de lignes à mettre en évidence.
 */
export function printDocument({ title, subtitle = '', meta = '', columns, rows, alert = new Set(), notes = '', signatures = false, now = new Date() }) {
  printNow(html`
    <h1 class="print-title">MODE</h1><p class="print-sub">${title}</p>
    <p class="print-meta">${subtitle}${subtitle ? ' · ' : ''}${now.toLocaleString('fr-FR')}${meta ? html` · ${meta}` : ''}</p>
    <table class="report"><thead><tr>${columns.map((c) => html`<th class="${c.num ? 'num' : ''}">${c.label}</th>`)}</tr></thead>
    <tbody>${rows.map((r, i) => html`<tr class="${alert.has(i) ? 'alert' : ''}">${r.map((v, j) => html`<td class="${columns[j]?.num ? 'num' : ''}">${v ?? '—'}</td>`)}</tr>`)}</tbody></table>
    ${notes ? html`<p class="print-notes">${notes}</p>` : ''}
    ${signatures ? html`<div class="print-sign"><div>Préparé par</div><div>Reçu par</div></div>` : ''}
    <div class="print-foot"><span>MODE — Confidentiel</span><span>${subtitle}</span></div>`, '@page { size: A4 portrait; margin: 10mm; }');
}

/** État de stock imprimable. rows : [{loc, family, name, ean, threshold, qty, alert}] */
export function printStockReport({ title, subtitle, rows, now = new Date() }) {
  printDocument({
    title, subtitle, now, meta: `${rows.length} référence${rows.length > 1 ? 's' : ''}`,
    columns: [{ label: 'Emplacement' }, { label: 'Famille' }, { label: 'Désignation' }, { label: 'EAN' }, { label: 'Seuil', num: true }, { label: 'Stock', num: true }],
    rows: rows.map((r) => [r.loc || '—', r.family || '—', r.name, r.ean, r.threshold || '—', r.qty]),
    alert: new Set(rows.map((r, i) => (r.alert ? i : -1)).filter((i) => i >= 0)),
  });
}
