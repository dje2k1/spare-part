// Caméra : lecture continue EAN/QR via html5-qrcode (vendor/), repli « photo » via BarcodeDetector,
// html5-qrcode (fichier) puis décodeur EAN-13 maison. Toute la partie navigateur du scan est ici.
import { binarizeRow, decodeEan13Any } from '../lib/ean.js';

const FORMATS = () => {
  const F = globalThis.Html5QrcodeSupportedFormats;
  return F ? [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128, F.QR_CODE] : undefined;
};

export const scannerAvailable = () => typeof globalThis.Html5Qrcode === 'function';

/** Message lisible pour une erreur de caméra. */
export function cameraErrorMessage(err) {
  const name = err?.name || '';
  const text = String(err?.message || err || '');
  if (!window.isSecureContext) return 'La caméra exige une connexion sécurisée (HTTPS). Ouvrez l\'application via son adresse https://.';
  if (name === 'NotAllowedError' || /permission|denied/i.test(text)) return 'Accès à la caméra refusé. Autorisez-la dans les réglages du navigateur, ou saisissez le code à la main.';
  if (name === 'NotFoundError' || /not ?found|no camera/i.test(text)) return 'Aucune caméra détectée sur cet appareil. Saisissez le code à la main.';
  if (name === 'NotReadableError') return 'La caméra est utilisée par une autre application. Fermez-la puis réessayez.';
  return 'Impossible de démarrer la caméra. Saisissez le code à la main.';
}

/**
 * @param {{containerId:string, onCode:(code:string)=>void}} opt
 */
export function createScanner({ containerId, onCode }) {
  let qr = null;
  let running = false;
  let paused = false;
  let lastCode = '';
  let lastAt = 0;

  return {
    get running() { return running; },
    get paused() { return paused; },

    async start() {
      if (running) return;
      if (!scannerAvailable()) throw new Error('Bibliothèque de scan indisponible');
      qr = new globalThis.Html5Qrcode(containerId, { formatsToSupport: FORMATS(), verbose: false, experimentalFeatures: { useBarCodeDetectorIfSupported: true } });
      await qr.start(
        { facingMode: 'environment' },
        { fps: 12, qrbox: (w, h) => ({ width: Math.floor(w * 0.86), height: Math.floor(Math.min(h * 0.55, w * 0.42)) }), disableFlip: false },
        (text) => {
          const now = Date.now();
          if (paused || !text) return;
          if (text === lastCode && now - lastAt < 2500) return; // anti-doublon (même code en rafale)
          lastCode = text; lastAt = now;
          onCode(text.trim());
        },
        () => {},
      );
      running = true; paused = false;
    },

    /** Fige l'image (code capté) sans couper la caméra. */
    pause() { if (running && !paused) { try { qr.pause(true); } catch { /* déjà en pause */ } paused = true; } },
    resume() { if (running && paused) { try { qr.resume(); } catch { /* ignoré */ } paused = false; lastCode = ''; } },

    async stop() {
      if (!qr) return;
      try { if (running) await qr.stop(); } catch { /* déjà arrêtée */ }
      try { qr.clear(); } catch { /* ignoré */ }
      qr = null; running = false; paused = false;
    },

    /** Lampe torche si l'appareil la propose. @returns {Promise<boolean|null>} nouvel état, null si indisponible */
    async toggleTorch() {
      try {
        const cap = qr?.getRunningTrackCameraCapabilities?.().torchFeature?.();
        if (!cap?.isSupported()) return null;
        const next = !cap.value();
        await cap.apply(next);
        return next;
      } catch { return null; }
    },
    hasTorch() {
      try { return Boolean(qr?.getRunningTrackCameraCapabilities?.().torchFeature?.().isSupported()); } catch { return false; }
    },
  };
}

// ── Repli : photo d'un code-barres ──
async function rows(img) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const strategies = [{ scale: 1 }, { scale: 1, crop: [0.05, 0.1, 0.9, 0.8] }, { scale: 1.5 }, { scale: 1, rotate: true }, { scale: 1, crop: [0.1, 0.25, 0.8, 0.5] }];
  for (const s of strategies) {
    let [sx, sy, sw, sh] = [0, 0, img.width, img.height];
    if (s.crop) [sx, sy, sw, sh] = [sw * s.crop[0], sh * s.crop[1], sw * s.crop[2], sh * s.crop[3]];
    const k = Math.min(1, 1400 / Math.max(sw, sh)) * s.scale;
    const dw = Math.round(sw * k), dh = Math.round(sh * k);
    canvas.width = s.rotate ? dh : dw; canvas.height = s.rotate ? dw : dh;
    ctx.save();
    if (s.rotate) { ctx.translate(dh, 0); ctx.rotate(Math.PI / 2); }
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, dw, dh);
    ctx.restore();
    for (const off of [0, -0.1, 0.1, -0.2, 0.2, -0.3, 0.3]) {
      const y = Math.round(canvas.height * (0.5 + off));
      if (y < 0 || y >= canvas.height) continue;
      const code = decodeEan13Any(binarizeRow(ctx.getImageData(0, y, canvas.width, 1).data, canvas.width));
      if (code) return code;
    }
  }
  return null;
}

/** Décode un code depuis une photo. @returns {Promise<string|null>} */
export async function decodePhoto(file) {
  if (scannerAvailable()) {
    let host = document.getElementById('scan-file-host');
    if (!host) { host = document.createElement('div'); host.id = 'scan-file-host'; host.hidden = true; document.body.append(host); }
    try {
      const reader = new globalThis.Html5Qrcode('scan-file-host', { verbose: false });
      const text = await reader.scanFile(file, false);
      reader.clear();
      if (text) return text.trim();
    } catch { /* on tente les autres méthodes */ }
  }
  const bmp = await createImageBitmap(file).catch(() => null);
  if (!bmp) return null;
  if ('BarcodeDetector' in window) {
    try {
      const found = await new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'qr_code', 'code_128', 'upc_a', 'upc_e'] }).detect(bmp);
      if (found[0]?.rawValue) return found[0].rawValue.trim();
    } catch { /* suite */ }
  }
  return rows(bmp);
}
