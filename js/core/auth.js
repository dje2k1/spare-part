// Authentification locale : hachage PBKDF2 des PIN, politique, verrouillage progressif, permissions.
//
// LIMITE ASSUMÉE : sans serveur, un PIN de 4-8 chiffres reste devinable hors-ligne par quiconque
// copie le stockage de l'appareil. Le hachage évite l'exposition en clair (et la réutilisation du PIN
// ailleurs) ; le verrouillage protège contre l'essai manuel ; une garantie forte exige un serveur.
import { PERMISSIONS } from './config.js';
import { randomB64, b64ToBytes, bytesToB64 } from '../lib/id.js';

export const PBKDF2_ITERATIONS = 150_000;

const enc = new TextEncoder();

/** @returns {Promise<{alg:string,salt:string,iter:number,hash:string,len:number}>} */
export async function hashPin(pin, { salt = randomB64(16), iter = PBKDF2_ITERATIONS } = {}) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('Le chiffrement du navigateur est indisponible (ouvrez l\'application en HTTPS).');
  const key = await subtle.importKey('raw', enc.encode(String(pin)), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: b64ToBytes(salt), iterations: iter }, key, 256);
  return { alg: 'PBKDF2-SHA256', salt, iter, hash: bytesToB64(new Uint8Array(bits)), len: String(pin).length };
}

function sameString(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export async function verifyPin(record, pin) {
  if (!record || !/^\d{4,8}$/.test(String(pin))) return false;
  const r = await hashPin(pin, { salt: record.salt, iter: record.iter });
  return sameString(r.hash, record.hash);
}

/** Empreinte de PIN bien formée (contrôle des données venant d'un autre appareil ou d'une sauvegarde). */
export function isPinRecord(p) {
  return Boolean(p) && typeof p === 'object' && p.alg === 'PBKDF2-SHA256'
    && typeof p.salt === 'string' && /^[A-Za-z0-9+/=]{8,200}$/.test(p.salt)
    && typeof p.hash === 'string' && /^[A-Za-z0-9+/=]{20,200}$/.test(p.hash)
    && Number.isInteger(p.iter) && p.iter >= 10_000 && p.iter <= 10_000_000
    && (p.len === undefined || (Number.isInteger(p.len) && p.len >= 0 && p.len <= 8));
}

/** Hache les PIN encore en clair (migration depuis dior_v4). @returns nombre de PIN migrés */
export async function upgradeLegacyPins(db) {
  let n = 0;
  for (const u of Object.values(db.users)) {
    if (u.pinLegacy && !u.pin) {
      u.pin = await hashPin(u.pinLegacy);
      n++;
    }
    delete u.pinLegacy;
  }
  return n;
}

/** Politique de PIN : 4 à 8 chiffres, ni répétés, ni suite évidente. */
export function pinPolicy(pin) {
  const p = String(pin ?? '');
  if (!/^\d{4,8}$/.test(p)) return { ok: false, reason: 'Le PIN doit comporter 4 à 8 chiffres.' };
  if (/^(\d)\1+$/.test(p)) return { ok: false, reason: 'Évitez un PIN composé d\'un seul chiffre répété.' };
  const d = [...p].map(Number);
  const step = d[1] - d[0];
  if ((step === 1 || step === -1) && d.every((v, i) => i === 0 || v - d[i - 1] === step)) {
    return { ok: false, reason: 'Évitez une suite évidente (1234, 4321…).' };
  }
  return { ok: true };
}

export const can = (role, permission) => PERMISSIONS[role]?.has(permission) === true;

// ── Verrouillage progressif après échecs ──
/** Durée de blocage (ms) après `failures` échecs consécutifs. */
export function lockDelay(failures) {
  if (failures < 5) return 0;
  const steps = [30_000, 60_000, 120_000, 300_000, 900_000];
  return steps[Math.min(failures - 5, steps.length - 1)];
}

export function createLockout({ storage, key, now = () => Date.now() }) {
  const read = () => { try { return JSON.parse(storage.getItem(key)) || {}; } catch { return {}; } };
  const write = (v) => { try { storage.setItem(key, JSON.stringify(v)); } catch { /* ignore */ } };
  return {
    status(userId) {
      const r = read()[userId];
      const remaining = r && r.until > now() ? r.until - now() : 0;
      return { locked: remaining > 0, remainingMs: remaining, failures: r?.n || 0 };
    },
    fail(userId) {
      const all = read();
      const n = (all[userId]?.n || 0) + 1;
      all[userId] = { n, until: now() + lockDelay(n) };
      write(all);
      return { failures: n, remainingMs: lockDelay(n) };
    },
    success(userId) {
      const all = read();
      if (all[userId]) { delete all[userId]; write(all); }
    },
  };
}

/** Session inactive depuis plus de `limitMs` ? (limitMs = 0 → jamais) */
export const isIdle = (lastActivityMs, nowMs, limitMs) => limitMs > 0 && nowMs - lastActivityMs >= limitMs;
