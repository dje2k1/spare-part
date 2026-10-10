// Texte, échappement HTML, formats et conversions numériques. Aucune dépendance au DOM.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };

/** Échappe une valeur pour l'insérer dans du HTML (contenu ou attribut entre guillemets). */
export const esc = (v) => String(v ?? '').replace(/[&<>"'`]/g, (c) => ESC[c]);

/** Fragment HTML déjà sûr : seul type accepté par `setHtml()`. */
export class SafeHtml {
  constructor(value) { this.value = value; }
  toString() { return this.value; }
}

/** Marque une chaîne comme sûre. À réserver à du contenu construit par le code (jamais saisi). */
export const raw = (s) => new SafeHtml(String(s));

const render = (v) => {
  if (v == null || v === false || v === true) return '';
  if (v instanceof SafeHtml) return v.value;
  if (Array.isArray(v)) return v.map(render).join('');
  return esc(v);
};

/**
 * Gabarit HTML auto-échappant : toute valeur interpolée est échappée, sauf `SafeHtml`
 * (autre `html\`\``, `raw()`), tableaux (concaténés) et false/null/undefined (ignorés).
 * Règle d'équipe : attributs TOUJOURS entre guillemets (`class="${x}"`).
 */
export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return new SafeHtml(out);
}

/** Normalise pour la recherche : minuscules, sans accents, œ→oe, æ→ae. */
export const fold = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/œ/g, 'oe')
    .replace(/æ/g, 'ae')
    .trim();

/** Tous les mots de la requête doivent apparaître (insensible casse/accents). */
export function matches(query, ...fields) {
  const tokens = fold(query).split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;
  const hay = fold(fields.join(' '));
  return tokens.every((t) => hay.includes(t));
}

/** Entier strict : `"3"`, `3`, `" 12 "` → nombre ; `"3.5"`, `"1e3"`, `""`, `NaN` → NaN. */
export function toInt(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? v : NaN;
  const s = String(v ?? '').trim();
  return /^[+-]?\d+$/.test(s) ? Number(s) : NaN;
}

/** Entier borné, avec valeur de repli si invalide. */
export function intIn(v, min, max, fallback = NaN) {
  const n = toInt(v);
  return Number.isNaN(n) || n < min || n > max ? fallback : n;
}

/** Décimal tolérant la virgule française (`"2,5"`) ; NaN si invalide ou négatif. */
export function toMoney(v) {
  const s = String(v ?? '').trim().replace(/\s/g, '').replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(s)) return NaN;
  return Math.round(Number(s) * 100) / 100;
}

export const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

// ── Formats (locale fr-FR) ──
const nf = new Intl.NumberFormat('fr-FR');
const eur0 = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const eur2 = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2 });
// Espace fine insécable (U+202F) → insécable ordinaire : absente de nombreuses polices, elle disparaît visuellement (« 1056 »).
const readable = (s) => s.replace(/\u202f/g, '\u00a0');
export const fmtInt = (n) => readable(nf.format(Number(n) || 0));
export const fmtEur = (n, decimals = false) => readable((decimals ? eur2 : eur0).format(Number(n) || 0));

const dFmt = new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: '2-digit', year: '2-digit' });
const tFmt = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' });
const longDate = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });

const asDate = (v) => (v instanceof Date ? v : new Date(v));
export const fmtDate = (v) => (Number.isNaN(asDate(v).getTime()) ? '—' : dFmt.format(asDate(v)));
export const fmtDateTime = (v) => (Number.isNaN(asDate(v).getTime()) ? '—' : `${dFmt.format(asDate(v))} ${tFmt.format(asDate(v))}`);
export const fmtLongDate = (v) => longDate.format(asDate(v));

/** « à l'instant », « il y a 5 min », « il y a 3 h », « il y a 2 j », sinon date courte. */
export function fmtRelative(v, now = new Date()) {
  const d = asDate(v);
  if (Number.isNaN(d.getTime())) return '—';
  const s = (asDate(now) - d) / 1000;
  if (s < 45) return "à l'instant";
  if (s < 3600) return `il y a ${Math.max(1, Math.round(s / 60))} min`;
  if (s < 86400) return `il y a ${Math.floor(s / 3600)} h`;
  if (s < 86400 * 7) return `il y a ${Math.floor(s / 86400)} j`;
  return dFmt.format(d);
}

/** Initiales pour un avatar : « Sophie Martin » → « SM ». */
export const initials = (name) =>
  String(name ?? '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';

/** Pluriel simple français : plural(2,'article') → « 2 articles ». */
export const plural = (n, one, many = `${one}s`) => `${fmtInt(n)} ${Math.abs(n) > 1 ? many : one}`;
