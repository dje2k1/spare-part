// Codes-barres : validation GS1, codes internes EAN-13, encodage SVG et décodage de repli.
// Fonctions pures (aucun accès au DOM) → testées en Node.
import { raw } from './text.js';

/** Un code article valide : 8 à 14 chiffres (EAN-8, UPC-A, EAN-13, ITF-14, codes internes). */
export const isCode = (s) => /^\d{8,14}$/.test(String(s ?? ''));

/**
 * Autres écritures d'un même code GTIN, zéros de tête ajoutés ou retirés (le chiffre de contrôle GS1 ne change
 * pas) : un lecteur transmet souvent un UPC-A sur 12 chiffres alors que la pièce est enregistrée en EAN-13
 * (« 0 » + UPC-A), ou un GTIN-14 complété de zéros. Le code lui-même n'est pas repris.
 */
export function codeVariants(code) {
  const s = String(code ?? '');
  if (!isCode(s)) return [];
  const core = s.replace(/^0+/, '');
  const out = [];
  for (const n of [13, 12, 14, 8]) {
    if (core.length > n) continue;
    const v = core.padStart(n, '0');
    if (v !== s && !out.includes(v)) out.push(v);
  }
  return out;
}

/** Chiffre de contrôle GS1 : poids 3,1,3,1… en partant de la droite du corps du code. */
export function checkDigit(body) {
  let sum = 0, w = 3;
  for (let i = body.length - 1; i >= 0; i--, w = w === 3 ? 1 : 3) sum += Number(body[i]) * w;
  return (10 - (sum % 10)) % 10;
}

/** true/false pour EAN-8/UPC-A/EAN-13/GTIN-14 ; null si la longueur n'a pas de clé GS1. */
export function hasValidCheck(code) {
  const s = String(code ?? '');
  if (!/^\d+$/.test(s) || ![8, 12, 13, 14].includes(s.length)) return null;
  return checkDigit(s.slice(0, -1)) === Number(s.at(-1));
}

// ── Codes internes (préfixe GS1 « 200 » = circulation restreinte, usage interne) ──
export const INTERNAL_PREFIX = '200';

export function internalEan(seq) {
  const body = INTERNAL_PREFIX + String(seq).padStart(9, '0');
  return body + checkDigit(body);
}

/** Prochain code interne libre, d'après les codes existants. */
export function nextInternalEan(existing) {
  let max = 0;
  for (const c of existing) {
    if (/^200\d{10}$/.test(c) && hasValidCheck(c)) max = Math.max(max, Number(c.slice(3, 12)));
  }
  return internalEan(max + 1);
}

// ── Tables EAN-13 (modules : 1 = barre) ──
const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111'];
const R = ['1110010', '1100110', '1101100', '1000010', '1011100', '1001110', '1010000', '1000100', '1001000', '1110100'];
const PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];

/** 95 modules d'un EAN-13 (garde, 6 chiffres gauche, garde centrale, 6 chiffres droite, garde). */
export function ean13Modules(code) {
  if (!/^\d{13}$/.test(String(code))) throw new Error('EAN-13 : 13 chiffres requis');
  const d = [...code].map(Number);
  let bits = '101';
  for (let i = 0; i < 6; i++) bits += (PARITY[d[0]][i] === 'L' ? L : G)[d[1 + i]];
  bits += '01010';
  for (let i = 0; i < 6; i++) bits += R[d[7 + i]];
  return bits + '101';
}

/** SVG d'un EAN-13 (barres seules ; le texte lisible est ajouté par le gabarit d'étiquette). */
export function ean13Svg(code, { module = 2, height = 48, quiet = 9 } = {}) {
  const bits = ean13Modules(code);
  const w = (bits.length + quiet * 2) * module;
  let path = '';
  for (let i = 0; i < bits.length;) {
    if (bits[i] === '1') {
      let j = i;
      while (j < bits.length && bits[j] === '1') j++;
      path += `M${(i + quiet) * module} 0h${(j - i) * module}v${height}h-${(j - i) * module}z`;
      i = j;
    } else i++;
  }
  return raw(`<svg class="barcode" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${height}" role="img" aria-label="Code-barres ${code}"><path d="${path}"/></svg>`);
}

// ── Décodage de repli (photo fixe) : binarisation d'une ligne puis lecture EAN-13 ──

/**
 * Binarise une ligne RGBA → Uint8Array de 0/1 (1 = sombre).
 * Seuil au milieu du contraste local (min+max)/2 : symétrique pour les bords flous, donc sans
 * rognage des barres. Là où le contraste local est faible (barre large, marge), repli sur le
 * milieu du contraste global de la ligne.
 */
export function binarizeRow(rgba, width) {
  const luma = new Float32Array(width);
  let gMin = 255, gMax = 0;
  for (let x = 0; x < width; x++) {
    const i = x * 4;
    const v = (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) / 256;
    luma[x] = v;
    if (v < gMin) gMin = v;
    if (v > gMax) gMax = v;
  }
  const out = new Uint8Array(width);
  const gContrast = gMax - gMin;
  if (gContrast < 30) return out; // ligne uniforme : pas de code
  const gMid = (gMin + gMax) / 2;
  const radius = Math.max(12, Math.floor(width / 30));
  for (let x = 0; x < width; x++) {
    const a = Math.max(0, x - radius), b = Math.min(width - 1, x + radius);
    let lo = 255, hi = 0;
    for (let i = a; i <= b; i++) { if (luma[i] < lo) lo = luma[i]; if (luma[i] > hi) hi = luma[i]; }
    const threshold = hi - lo >= gContrast * 0.4 ? (lo + hi) / 2 : gMid;
    out[x] = luma[x] < threshold ? 1 : 0;
  }
  return out;
}

/** Longueurs des plages consécutives de valeurs identiques. */
export function runLengths(bits) {
  const runs = [];
  if (!bits.length) return runs;
  let v = bits[0], n = 1;
  for (let i = 1; i < bits.length; i++) {
    if (bits[i] === v) n++;
    else { runs.push(n); v = bits[i]; n = 1; }
  }
  runs.push(n);
  return runs;
}

const patternRuns = (p) => runLengths([...p].map(Number));
const L_RUNS = L.map(patternRuns), G_RUNS = G.map(patternRuns), R_RUNS = R.map(patternRuns);

/**
 * Meilleur appariement d'un chiffre (4 plages ≈ 7 modules) parmi les tables données.
 * Erreur par plage exprimée en modules : max ≤ 0,75 et moyenne ≤ 0,40 (cf. critères de ZXing).
 */
function readDigit(runs, pos, tables) {
  const bars = runs.slice(pos, pos + 4);
  if (bars.length < 4) return null;
  const unit = (bars[0] + bars[1] + bars[2] + bars[3]) / 7;
  if (unit < 0.5) return null;
  let best = null;
  for (const [table, tag] of tables) {
    for (let n = 0; n < 10; n++) {
      let max = 0, sum = 0;
      for (let i = 0; i < 4; i++) {
        const e = Math.abs(bars[i] - table[n][i] * unit) / unit;
        if (e > max) max = e;
        sum += e;
      }
      if (max <= 0.75 && sum / 4 <= 0.4 && (!best || sum < best.sum)) best = { n, tag, sum, unit };
    }
  }
  return best;
}

/** Les `count` plages à partir de `pos` valent chacune ≈ 1 module (garde). */
const isGuard = (runs, pos, count, unit) =>
  pos + count <= runs.length && runs.slice(pos, pos + count).every((r) => Math.abs(r - unit) <= unit * 0.75);

/** Essaie le sens normal puis le sens inversé (code présenté à l'envers). */
export const decodeEan13Any = (bits) => decodeEan13(bits) ?? decodeEan13([...bits].reverse());

/**
 * Décode un EAN-13 depuis un tableau de bits (0/1) ; null si absent ou clé invalide.
 * Un candidat doit présenter : zone de silence, garde de début / centrale / de fin,
 * 12 chiffres dont l'unité reste cohérente avec la largeur totale (95 modules), clé GS1 valide.
 * Ces contrôles évitent les faux positifs sur du bruit ou du texte (vérifié par les tests).
 */
export function decodeEan13(bits) {
  const runs = runLengths(bits);
  if (runs.length < 59) return null;
  const firstIsBar = bits[0] === 1;
  for (let s = 1; s + 59 <= runs.length; s++) {
    if ((s % 2 === 0) !== firstIsBar) continue; // la plage de départ doit être une barre
    const unit0 = (runs[s] + runs[s + 1] + runs[s + 2]) / 3;
    if (unit0 < 0.8 || !isGuard(runs, s, 3, unit0)) continue;
    if (runs[s - 1] < unit0 * 4) continue; // zone de silence avant le code

    const total = runs.slice(s, s + 59).reduce((a, b) => a + b, 0);
    const unit = total / 95;
    if (unit0 < unit * 0.6 || unit0 > unit * 1.6) continue;

    let pos = s + 3, ok = true;
    const left = [], parity = [], right = [];
    const withinUnit = (u) => u >= unit * 0.6 && u <= unit * 1.6;
    for (let d = 0; d < 6 && ok; d++, pos += 4) {
      const r = readDigit(runs, pos, [[L_RUNS, 'L'], [G_RUNS, 'G']]);
      if (!r || !withinUnit(r.unit)) ok = false; else { left.push(r.n); parity.push(r.tag); }
    }
    if (!ok || !isGuard(runs, pos, 5, unit)) continue; // garde centrale 01010
    pos += 5;
    for (let d = 0; d < 6 && ok; d++, pos += 4) {
      const r = readDigit(runs, pos, [[R_RUNS, 'R']]);
      if (!r || !withinUnit(r.unit)) ok = false; else right.push(r.n);
    }
    if (!ok || !isGuard(runs, pos, 3, unit)) continue; // garde de fin 101
    const after = runs[pos + 3];
    if (after !== undefined && after < unit * 4) continue; // silence après le code (ou fin de ligne)

    const first = PARITY.indexOf(parity.join(''));
    if (first === -1) continue;
    const code = [first, ...left, ...right].join('');
    if (hasValidCheck(code)) return code;
  }
  return null;
}
