// Images : redimensionnement/compression (photos d'articles, envoi à l'IA) et validation des data-URL.
// Utilise le DOM (canvas) → testé en E2E, pas en Node.

const DATA_URL = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

/** true si la chaîne est une data-URL d'image sûre à placer dans un attribut `src`. */
export const isImageDataUrl = (s) => typeof s === 'string' && s.length < 400_000 && DATA_URL.test(s);

async function decode(file) {
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { /* repli ci-dessous */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally { URL.revokeObjectURL(url); }
}

/**
 * Redimensionne `file` pour que son plus grand côté ≤ `max`, ré-encode en JPEG.
 * @returns {Promise<{dataUrl:string, base64:string, width:number, height:number}>}
 */
export async function shrink(file, { max = 480, quality = 0.72 } = {}) {
  const src = await decode(file);
  const w0 = src.width, h0 = src.height;
  if (!w0 || !h0) throw new Error('Image illisible');
  const k = Math.min(1, max / Math.max(w0, h0));
  const width = Math.max(1, Math.round(w0 * k)), height = Math.max(1, Math.round(h0 * k));
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height); // évite le fond noir des PNG transparents
  ctx.drawImage(src, 0, 0, width, height);
  if (typeof src.close === 'function') src.close();
  const dataUrl = canvas.toDataURL('image/jpeg', quality);
  return { dataUrl, base64: dataUrl.slice(dataUrl.indexOf(',') + 1), width, height };
}
