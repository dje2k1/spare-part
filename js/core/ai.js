// Analyse photo par l'API Claude : appel direct depuis le navigateur avec la clé de l'utilisateur.
//
// SÉCURITÉ : la clé est conservée sur l'appareil (localStorage) — c'est inévitable sans serveur. Mesures :
// CSP stricte (aucun script tiers ne peut la lire), utilisation limitée à api.anthropic.com, effacement sur
// 401, avertissement explicite dans l'interface. Pour un déploiement multi-utilisateurs, passer par un proxy.
//
// Le JSON renvoyé par le modèle est une donnée NON FIABLE : il est validé et assaini champ par champ.
import { KEYS, LIMITS } from './config.js';
import { intIn } from '../lib/text.js';

export const AI = {
  url: 'https://api.anthropic.com/v1/messages',
  version: '2023-06-01',
  /** Gamme Sonnet (choix d'origine du projet), génération actuelle. Modifiable ici uniquement. */
  model: 'claude-sonnet-5-5',
  maxTokens: 4000,
  maxParts: 12,
};

export class AiError extends Error {
  constructor(message, { code = 'ai', clearKey = false } = {}) { super(message); this.name = 'AiError'; this.code = code; this.clearKey = clearKey; }
}

// ── Clé API (stockage) ──
export const isValidKeyFormat = (k) => /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(String(k ?? '').trim());

/** Lit la clé (et migre silencieusement l'ancien nom de clé de la première refonte). */
export function readApiKey(storage) {
  try {
    let k = storage.getItem(KEYS.apiKey);
    if (!k) {
      for (const old of KEYS.legacyApiKeys) {
        const v = storage.getItem(old);
        if (v) { storage.setItem(KEYS.apiKey, v); storage.removeItem(old); k = v; break; }
      }
    }
    return k || '';
  } catch { return ''; }
}
export function saveApiKey(storage, key) {
  if (!isValidKeyFormat(key)) throw new AiError('Format de clé invalide : elle commence par « sk-ant- ».', { code: 'key' });
  storage.setItem(KEYS.apiKey, key.trim());
}
export const clearApiKey = (storage) => { try { storage.removeItem(KEYS.apiKey); for (const o of KEYS.legacyApiKeys) storage.removeItem(o); } catch { /* ignoré */ } };

// ── Requête ──
const PROMPT = `Tu es un expert en maroquinerie, sellerie et articles de mode. Analyse la photo de ce produit.

Réponds UNIQUEMENT par un objet JSON valide, sans texte avant ou après, sans balises de code, de cette forme :
{
  "product_name": "Nom court du produit (ex. : Sac à main en cuir, Ceinture, Portefeuille)",
  "product_description": "Description concise en une phrase",
  "product_category": "Maroquinerie | Chaussures | Accessoires | Vêtement | Bijou | Autre",
  "confidence": "high | medium | low",
  "spare_parts": [
    {
      "name": "Nom de la pièce en français",
      "family": "Fermetures | Bandoulières & Anses | Fermoirs & Boucles | Boutons & Pressions | Doublure & Tissu | Renforts & Structures | Accessoires métalliques | Couture & Finition",
      "description": "Description courte de la pièce",
      "typical_threshold": 5,
      "priority": "high | medium | low"
    }
  ]
}

Identifie entre 6 et 12 pièces détachées RÉALISTES et SPÉCIFIQUES à ce type de produit.
Priorité "high" = pièces qui s'usent ou se remplacent le plus souvent.
Si le produit n'est pas clairement identifiable, mets "confidence": "low" et propose des pièces génériques.
N'invente aucun code-barres.`;

export function buildRequest({ base64, mime = 'image/jpeg' }) {
  return {
    model: AI.model,
    max_tokens: AI.maxTokens,
    output_config: { effort: 'low' }, // identification simple : réflexion minimale (rapide et économique)
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: mime, data: base64 } },
      { type: 'text', text: PROMPT },
    ] }],
  };
}

// ── Réponse ──
const str = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** Extrait le premier objet JSON équilibré d'un texte (tolère balises ``` et texte parasite). */
export function extractJson(text) {
  const s = String(text ?? '').replace(/```(?:json)?/gi, '');
  const start = s.indexOf('{');
  if (start < 0) throw new AiError('Réponse illisible : aucun JSON trouvé.', { code: 'parse' });
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try { return JSON.parse(s.slice(start, i + 1)); } catch { throw new AiError('Réponse illisible : JSON invalide.', { code: 'parse' }); }
    }
  }
  throw new AiError('Réponse tronquée : réessayez avec une photo plus nette.', { code: 'parse' });
}

/** Réponse de l'API (objet) → { product, parts } assaini. Les EAN proposés par le modèle sont ignorés. */
export function parseResponse(data) {
  if (data?.stop_reason === 'refusal') throw new AiError('L\'analyse a été refusée pour cette image.', { code: 'refusal' });
  const text = (data?.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('');
  if (!text.trim()) throw new AiError(data?.stop_reason === 'max_tokens' ? 'Réponse trop longue : réessayez.' : 'Réponse vide du modèle.', { code: 'parse' });
  const raw = extractJson(text);
  const priorities = ['high', 'medium', 'low'];
  const parts = (Array.isArray(raw.spare_parts) ? raw.spare_parts : []).flatMap((p) => {
    const name = str(p?.name, LIMITS.name);
    if (!name) return [];
    return [{
      name, family: str(p.family, LIMITS.short), description: str(p.description, 160),
      typical_threshold: intIn(p.typical_threshold, 0, 100000, 5),
      priority: priorities.includes(p.priority) ? p.priority : 'medium',
    }];
  }).slice(0, AI.maxParts).map((p, i) => ({ ...p, id: `p${i}` })); // on écarte les entrées vides AVANT de plafonner
  return {
    product: {
      name: str(raw.product_name, LIMITS.name) || 'Produit non identifié',
      description: str(raw.product_description, 240),
      category: str(raw.product_category, LIMITS.short),
      confidence: ['high', 'medium', 'low'].includes(raw.confidence) ? raw.confidence : 'low',
    },
    parts,
  };
}

const HTTP_MESSAGES = {
  400: 'Requête refusée par l\'API (image trop volumineuse ou format non pris en charge).',
  403: 'Accès refusé : cette clé n\'a pas le droit d\'utiliser l\'API.',
  404: 'Modèle introuvable : contactez l\'administrateur de l\'application.',
  413: 'Image trop volumineuse.',
  429: 'Trop de requêtes : patientez une minute puis réessayez.',
  500: 'Erreur du service Anthropic. Réessayez dans un instant.',
  529: 'Service surchargé. Réessayez dans un instant.',
};

/** Appel complet. `fetchImpl` est injectable (tests). */
export async function analyzePhoto({ apiKey, base64, mime, fetchImpl = globalThis.fetch.bind(globalThis), signal }) {
  if (!isValidKeyFormat(apiKey)) throw new AiError('Clé API absente ou invalide.', { code: 'key', clearKey: true });
  let res;
  try {
    res = await fetchImpl(AI.url, {
      method: 'POST', signal,
      headers: {
        'content-type': 'application/json', 'anthropic-version': AI.version, 'x-api-key': apiKey.trim(),
        'anthropic-dangerous-direct-browser-access': 'true', // requis pour un appel direct depuis un navigateur
      },
      body: JSON.stringify(buildRequest({ base64, mime })),
    });
  } catch (e) {
    if (e?.name === 'AbortError') throw new AiError('Analyse annulée.', { code: 'abort' });
    throw new AiError('Connexion impossible à l\'API Anthropic. Vérifiez votre connexion internet.', { code: 'network' }); // la clé n'est PAS effacée
  }
  if (!res.ok) {
    if (res.status === 401) throw new AiError('Clé API invalide ou révoquée. Saisissez-en une nouvelle.', { code: 'auth', clearKey: true });
    let detail = '';
    try { detail = str((await res.json())?.error?.message, 160); } catch { /* corps non JSON */ }
    const base = HTTP_MESSAGES[res.status] ?? (res.status >= 500 ? HTTP_MESSAGES[500] : `Erreur API (${res.status}).`);
    throw new AiError(detail && res.status === 400 ? `${base} (${detail})` : base, { code: `http${res.status}` });
  }
  let data;
  try { data = await res.json(); } catch { throw new AiError('Réponse illisible de l\'API.', { code: 'parse' }); }
  return parseResponse(data);
}
