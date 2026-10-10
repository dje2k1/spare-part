// Relais d'analyse photo (B3) : la clé API Anthropic reste sur le serveur (variable d'environnement),
// les appareils n'en voient jamais. Quota quotidien par utilisateur, image et requête contrôlées.
// La requête est construite par le MÊME code que sur l'appareil (js/core/ai.js : modèle, consigne, format) ;
// l'appareil assainit ensuite la réponse (parseResponse).
import Anthropic from '@anthropic-ai/sdk';
import { buildRequest, AI } from '../js/core/ai.js';

const MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const MAX_B64 = 7_000_000; // ≈ 5 Mo d'image : limite de l'API

export function createAiProxy({ apiKey, baseURL, dailyLimit = 40, now = () => new Date(), log = console }) {
  if (!apiKey) return null;
  const client = new Anthropic({ apiKey, baseURL: baseURL || undefined, maxRetries: 2, timeout: 90_000 });
  const usage = new Map(); // « utilisateur:jour » → nombre d'analyses

  return {
    model: AI.model,
    dailyLimit,
    /** @returns {Promise<{status:number, message?:object, error?:string}>} */
    async analyze(body, user, signal) {
      const base64 = typeof body?.base64 === 'string' ? body.base64 : '';
      const mime = MIMES.has(body?.mime) ? body.mime : null;
      if (!mime) return { status: 400, error: 'Format d\'image non pris en charge (JPEG, PNG, WebP).' };
      if (!base64 || base64.length > MAX_B64 || !/^[A-Za-z0-9+/]+=*$/.test(base64)) return { status: 413, error: 'Image absente, illisible ou trop volumineuse.' };
      const key = `${user.id}:${now().toISOString().slice(0, 10)}`;
      const n = usage.get(key) ?? 0;
      if (n >= dailyLimit) return { status: 429, error: `Limite de ${dailyLimit} analyses par jour atteinte pour votre compte.` };
      usage.set(key, n + 1);
      if (usage.size > 5000) usage.delete(usage.keys().next().value);
      try {
        const msg = await client.messages.create(buildRequest({ base64, mime }), { signal });
        return { status: 200, message: { content: msg.content, stop_reason: msg.stop_reason, model: msg.model } };
      } catch (e) {
        usage.set(key, n); // un échec ne consomme pas le quota
        if (e instanceof Anthropic.APIUserAbortError) return { status: 499, error: 'Analyse annulée.' };
        if (e instanceof Anthropic.AuthenticationError) { log.error?.('IA : clé API du serveur refusée'); return { status: 502, error: 'La clé API du serveur est refusée : prévenez l\'administrateur.' }; }
        if (e instanceof Anthropic.RateLimitError) return { status: 429, error: 'Service d\'analyse saturé : réessayez dans une minute.' };
        if (e instanceof Anthropic.BadRequestError) return { status: 400, error: `Requête refusée par le service d'analyse : ${e.message}` };
        if (e instanceof Anthropic.APIConnectionError) return { status: 503, error: 'Service d\'analyse injoignable depuis le serveur.' };
        if (e instanceof Anthropic.APIError) return { status: 502, error: `Erreur du service d'analyse (${e.status ?? 'inconnue'}).` };
        throw e;
      }
    },
  };
}
