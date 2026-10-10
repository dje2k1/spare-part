// Impression sans fenêtre surgissante : le contenu est injecté dans #print-root puis window.print().
// (Les popups sont bloquées sur mobile ; print.css masque tout le reste de la page à l'impression.)
import { html } from '../lib/text.js';
import { ean13Svg, hasValidCheck } from '../lib/ean.js';
import { qrSvg, locationPayload } from '../lib/qr.js';
import { $, setHtml } from './dom.js';
import { locCode } from '../core/queries.js';

function printNow(content) {
  const root = $('#print-root');
  setHtml(root, content);
  const clear = () => { setHtml(root, html``); window.removeEventListener('afterprint', clear); };
  window.addEventListener('afterprint', clear);
  // Laisse le navigateur peindre le contenu avant d'ouvrir la boîte d'impression
  requestAnimationFrame(() => setTimeout(() => window.print(), 50));
}

/** Étiquette d'un article : code-barres EAN-13 (codes valides) sinon QR de l'EAN. */
function articleLabel(a, loc) {
  const bars = a.ean.length === 13 && hasValidCheck(a.ean) !== false ? ean13Svg(a.ean) : qrSvg(a.ean, { label: a.ean });
  return html`<div class="label"><div class="label__name">${a.name}</div>${bars}<div class="label__code">${a.ean}</div>${loc ? html`<div class="label__meta">${loc}</div>` : ''}</div>`;
}

function locationLabel(l, depot) {
  const code = locCode(l);
  return html`<div class="label label--loc">${qrSvg(locationPayload(code, l.depotId), { label: `Emplacement ${code}` })}<div class="label__code">${code}</div><div class="label__meta">${l.desc || ''}${l.desc && depot ? ' · ' : ''}${depot?.name ?? ''}</div></div>`;
}

/** @param {{kind:'article', article:object, loc?:string}[]|{kind:'location', loc:object, depot?:object}[]} items */
export function printLabels(items, { copies = 1 } = {}) {
  const cells = items.flatMap((it) => Array.from({ length: copies }, () => (it.kind === 'article' ? articleLabel(it.article, it.loc) : locationLabel(it.loc, it.depot))));
  printNow(html`<div class="labels">${cells}</div>`);
}

/** État de stock imprimable. rows : [{loc, family, name, ean, threshold, qty, alert}] */
export function printStockReport({ title, subtitle, rows, now = new Date() }) {
  printNow(html`
    <h1 class="print-title">MODE</h1><p class="print-sub">${title}</p>
    <p class="print-meta">${subtitle} · ${now.toLocaleString('fr-FR')} · ${rows.length} référence${rows.length > 1 ? 's' : ''}</p>
    <table class="report"><thead><tr><th>Emplacement</th><th>Famille</th><th>Désignation</th><th>EAN</th><th class="num">Seuil</th><th class="num">Stock</th></tr></thead>
    <tbody>${rows.map((r) => html`<tr><td>${r.loc || '—'}</td><td>${r.family || '—'}</td><td>${r.name}</td><td>${r.ean}</td><td class="num">${r.threshold || '—'}</td><td class="num ${r.alert ? 'alert' : ''}">${r.qty}</td></tr>`)}</tbody></table>
    <div class="print-foot"><span>MODE — Confidentiel</span><span>${subtitle}</span></div>`);
}
