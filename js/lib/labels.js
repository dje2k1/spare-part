// Étiquettes : formats (planches A4 pour imprimante de bureau, rouleaux pour imprimante thermique type
// Intermec / Honeywell), mise en page et génération ZPL. Pur : aucun accès au DOM.
//
// Deux chemins d'impression :
//   - « Impression système » : la page est mise à la taille exacte de l'étiquette (ou de la planche) et
//     imprimée via le pilote de l'imprimante (PC, Mac, ou mobile si l'imprimante y est reconnue) ;
//   - « Fichier ZPL » : langage des imprimantes thermiques, accepté par les Intermec/Honeywell récentes
//     via leur émulation ZPL (ZSim, selon le modèle) ; à envoyer par l'outil de l'imprimante.

/** Dimensions en millimètres. */
export const LABEL_FORMATS = {
  'a4-3x8': { kind: 'sheet', name: 'A4 · 24 étiquettes 70 × 37 mm', cols: 3, rows: 8, w: 70, h: 37.125, top: 0, left: 0, gapX: 0, gapY: 0 },
  'a4-3x7': { kind: 'sheet', name: 'A4 · 21 étiquettes 63,5 × 38,1 mm (type L7160)', cols: 3, rows: 7, w: 63.5, h: 38.1, top: 15.15, left: 7.25, gapX: 2.5, gapY: 0 },
  'a4-2x7': { kind: 'sheet', name: 'A4 · 14 étiquettes 99,1 × 38,1 mm (type L7163)', cols: 2, rows: 7, w: 99.1, h: 38.1, top: 15.15, left: 4.65, gapX: 2.5, gapY: 0 },
  'a4-plain': { kind: 'sheet', name: 'A4 · papier ordinaire, 3 × 8 à découper', cols: 3, rows: 8, w: 70, h: 37.125, top: 0, left: 0, gapX: 0, gapY: 0, cut: true },
  'roll-50x25': { kind: 'roll', name: 'Rouleau 50 × 25 mm', w: 50, h: 25 },
  'roll-60x40': { kind: 'roll', name: 'Rouleau 60 × 40 mm', w: 60, h: 40 },
  'roll-100x50': { kind: 'roll', name: 'Rouleau 100 × 50 mm', w: 100, h: 50 },
};

export const PRINTER_TYPES = {
  office: { label: 'Imprimante de bureau (planches A4)', formats: ['a4-3x8', 'a4-3x7', 'a4-2x7', 'a4-plain'] },
  thermal: { label: 'Imprimante thermique (rouleau)', formats: ['roll-50x25', 'roll-60x40', 'roll-100x50'] },
};

export const DEFAULT_PRINTER = { type: 'office', format: 'a4-3x8', dpi: 203, output: 'print', offsetX: 0, offsetY: 0 };

/** Profil d'impression valide (préférence d'appareil potentiellement ancienne ou altérée). */
export function normalizePrinter(p) {
  const type = PRINTER_TYPES[p?.type] ? p.type : DEFAULT_PRINTER.type;
  const format = PRINTER_TYPES[type].formats.includes(p?.format) ? p.format : PRINTER_TYPES[type].formats[0];
  const num = (v, min, max, d) => (Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Number(v))) : d);
  return {
    type, format,
    dpi: [203, 300, 406].includes(Number(p?.dpi)) ? Number(p.dpi) : 203,
    output: type === 'thermal' && p?.output === 'zpl' ? 'zpl' : 'print',
    offsetX: num(p?.offsetX, -10, 10, 0), offsetY: num(p?.offsetY, -10, 10, 0),
  };
}

/**
 * Pages d'une planche A4 : positions (mm) de chaque étiquette. `skip` : cases déjà utilisées sur la
 * première planche (réutiliser une planche entamée).
 * @returns {{cells:{x:number,y:number,item:object}[]}[]}
 */
export function sheetPages(items, format, { skip = 0, offsetX = 0, offsetY = 0 } = {}) {
  const f = LABEL_FORMATS[format];
  if (!f || f.kind !== 'sheet') throw new Error(`Format de planche inconnu : ${format}`);
  const perPage = f.cols * f.rows;
  const pages = [];
  let slot = Math.max(0, Math.min(perPage - 1, Math.floor(skip) || 0));
  for (const item of items) {
    if (!pages.length || (slot === 0 && pages.at(-1).cells.length)) pages.push({ cells: [] });
    const i = slot;
    const col = i % f.cols, row = Math.floor(i / f.cols);
    pages.at(-1).cells.push({ x: f.left + col * (f.w + f.gapX) + offsetX, y: f.top + row * (f.h + f.gapY) + offsetY, item });
    slot = (slot + 1) % perPage;
  }
  return pages;
}

/** Développe [{item, copies}] en une liste plate (limitée pour éviter une impression accidentelle massive). */
export function expandCopies(list, max = 2000) {
  const out = [];
  for (const { item, copies } of list) {
    const n = Math.max(0, Math.min(500, Math.floor(Number(copies)) || 0));
    for (let i = 0; i < n && out.length < max; i++) out.push(item);
  }
  return out;
}

// ── ZPL ──
const dots = (mm, dpi) => Math.round((mm * dpi) / 25.4);
/** Texte sûr pour un champ ZPL : sans caractères de commande (^ ~), sans retour ligne, longueur bornée. */
export const zplText = (s, max = 60) => String(s ?? '').replace(/[\^~\\]/g, ' ').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

function barcodeZpl(code, x, y, h, moduleDots) {
  if (/^\d{13}$/.test(code)) return `^FO${x},${y}^BY${moduleDots}^BEN,${h},Y,N^FD${code.slice(0, 12)}^FS`; // EAN-13 : clé recalculée par l'imprimante
  if (/^\d{8}$/.test(code)) return `^FO${x},${y}^BY${moduleDots}^B8N,${h},Y,N^FD${code.slice(0, 7)}^FS`;
  return `^FO${x},${y}^BY${moduleDots}^BCN,${h},Y,N,N^FD${zplText(code, 40)}^FS`;
}

/**
 * Étiquettes au format ZPL (une étiquette = un bloc ^XA…^XZ, quantité via ^PQ).
 * Article : désignation (2 lignes), code-barres, emplacement et référence. Emplacement : QR + code en grand.
 */
export function toZpl(list, { format = 'roll-50x25', dpi = 203 } = {}) {
  const f = LABEL_FORMATS[format];
  if (!f || f.kind !== 'roll') throw new Error(`Format de rouleau inconnu : ${format}`);
  const W = dots(f.w, dpi), H = dots(f.h, dpi), m = dots(2, dpi);
  const scale = dpi / 203;
  const font = (pt) => Math.round(pt * scale);
  const blocks = [];
  for (const { item, copies } of list) {
    const n = Math.max(0, Math.min(500, Math.floor(Number(copies)) || 0));
    if (!n) continue;
    const lines = ['^XA', '^CI28', `^PW${W}`, `^LL${H}`, '^LH0,0'];
    if (item.kind === 'location') {
      const qrMag = Math.max(2, Math.min(10, Math.floor((H - 2 * m) / (dpi === 203 ? 30 : 45))));
      lines.push(`^FO${m},${m}^BQN,2,${qrMag}^FDMA,${zplText(item.payload, 120)}^FS`);
      const x = Math.round(W * 0.48);
      lines.push(`^FO${x},${m}^A0N,${font(34)},${font(30)}^FB${W - x - m},2,0,L^FD${zplText(item.code, 24)}^FS`);
      lines.push(`^FO${x},${H - m - font(40)}^A0N,${font(18)},${font(16)}^FB${W - x - m},2,0,L^FD${zplText(item.desc || item.depot, 40)}^FS`);
    } else {
      const nameH = font(f.h >= 40 ? 24 : 18);
      lines.push(`^FO${m},${m}^A0N,${nameH},${nameH}^FB${W - 2 * m},2,0,L^FD${zplText(item.name, 60)}^FS`);
      const barH = Math.max(dots(8, dpi), H - 2 * m - 2 * nameH - font(22) - font(18));
      const module = Math.max(1, Math.min(4, Math.floor((W - 2 * m) / 115)));
      lines.push(barcodeZpl(item.ean, m, m + 2 * nameH + 4, barH, module));
      const meta = [item.loc, item.ref].filter(Boolean).join(' · ');
      if (meta) lines.push(`^FO${m},${H - m - font(18)}^A0N,${font(18)},${font(16)}^FD${zplText(meta, 40)}^FS`);
    }
    lines.push(`^PQ${n},0,1,Y`, '^XZ');
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n');
}
