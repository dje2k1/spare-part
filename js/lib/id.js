// Identifiants uniques non devinables (caractères sûrs pour attributs HTML et sélecteurs : [0-9a-z]).

/** `uid()` → 8 car. temporels (tri chronologique) + 12 car. aléatoires cryptographiques. */
export function uid(now = Date.now()) {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  const rand = Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 12);
  return now.toString(36).padStart(8, '0').slice(-8) + rand;
}

export const isUid = (s) => typeof s === 'string' && /^[0-9a-z]{8,40}$/.test(s);

/** Octets aléatoires encodés en base64 (sels). */
export function randomB64(n = 16) {
  const bytes = new Uint8Array(n);
  globalThis.crypto.getRandomValues(bytes);
  return bytesToB64(bytes);
}
export const bytesToB64 = (bytes) => btoa(String.fromCharCode(...bytes));
export const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
