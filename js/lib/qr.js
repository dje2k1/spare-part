// QR codes en SVG (vectoriel : net à l'écran comme à l'impression) via `qrcode-generator`
// (vendor/qrcode.js, MIT) exposé en global `qrcode`.
import { raw } from './text.js';

/** Matrice de modules (true = sombre) ou null si la bibliothèque n'est pas chargée. */
export function qrMatrix(text, ecc = 'M') {
  const factory = globalThis.qrcode;
  if (typeof factory !== 'function') return null;
  const qr = factory(0, ecc); // version automatique
  qr.addData(String(text));
  qr.make();
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => qr.isDark(r, c)));
}

/** SVG d'un QR code (zone de silence de 4 modules incluse, imposée par la norme). */
export function qrSvg(text, { quiet = 4, label = 'QR code' } = {}) {
  const m = qrMatrix(text);
  if (!m) {
    return raw('<svg class="qr qr--missing" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" role="img" aria-label="QR code indisponible"><rect width="100" height="100" fill="none" stroke="currentColor" stroke-dasharray="4"/><text x="50" y="54" text-anchor="middle" font-size="9" fill="currentColor">QR indisponible</text></svg>');
  }
  const n = m.length, size = n + quiet * 2;
  let d = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n;) {
      if (!m[r][c]) { c++; continue; }
      let k = c;
      while (k < n && m[r][k]) k++;
      d += `M${c + quiet} ${r + quiet}h${k - c}v1h-${k - c}z`;
      c = k;
    }
  }
  const aria = String(label).replace(/[^\p{L}\p{N} :._-]/gu, '');
  return raw(`<svg class="qr" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="${aria}"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`);
}

// ── Contenus encodés (formats historiques conservés : les étiquettes déjà imprimées restent valides) ──
export const locationPayload = (code, depotId) => `LOC:${code}:${depotId}`;

/** `LOC:R1-A2-E1-C1:depotId` → { code, depotId } ; null si ce n'est pas un QR d'emplacement. */
export function parseLocationPayload(text) {
  const m = /^LOC:([A-Za-z0-9-]{1,24})(?::([0-9a-z]{4,40}))?$/.exec(String(text ?? '').trim());
  return m ? { code: m[1].toUpperCase(), depotId: m[2] || null } : null;
}
