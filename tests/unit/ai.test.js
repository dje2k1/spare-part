import test from 'node:test';
import assert from 'node:assert/strict';
import { AI, AiError, isValidKeyFormat, readApiKey, saveApiKey, clearApiKey, buildRequest, extractJson, parseResponse, analyzePhoto } from '../../js/core/ai.js';
import { KEYS } from '../../js/core/config.js';
import { memoryStorage } from './helpers.js';

const KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';
const reply = (obj, extra = {}) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj) }], stop_reason: 'end_turn', ...extra });
const okFetch = (data) => async () => ({ ok: true, status: 200, json: async () => data });
const errFetch = (status, body = {}) => async () => ({ ok: false, status, json: async () => body });

test('format de clé', () => {
  assert.ok(isValidKeyFormat(KEY));
  for (const bad of ['', 'sk-ant-', 'sk-ant-court', 'AIza123', null, undefined, `${KEY}\n<script>`]) assert.ok(!isValidKeyFormat(bad), String(bad));
});

test('stockage de la clé : lecture, migration de l\'ancien nom, effacement', () => {
  const s = memoryStorage();
  assert.equal(readApiKey(s), '');
  saveApiKey(s, ` ${KEY} `);
  assert.equal(readApiKey(s), KEY);
  assert.throws(() => saveApiKey(s, 'pas-une-cle'), AiError);
  clearApiKey(s);
  assert.equal(readApiKey(s), '');
  s.setItem(KEYS.legacyApiKeys[0], KEY);
  assert.equal(readApiKey(s), KEY, 'migration depuis mode_anthropic_key');
  assert.equal(s.getItem(KEYS.legacyApiKeys[0]), null);
  assert.equal(s.getItem(KEYS.apiKey), KEY);
  assert.equal(readApiKey({ getItem() { throw new Error('bloqué'); } }), '', 'stockage inaccessible');
});

test('requête : modèle de la gamme Sonnet actuelle, image, effort bas, aucune option interdite', () => {
  const r = buildRequest({ base64: 'QUJD', mime: 'image/png' });
  assert.equal(r.model, 'claude-sonnet-5-5');
  assert.equal(r.model, AI.model);
  assert.deepEqual(r.output_config, { effort: 'low' });
  assert.deepEqual(r.messages[0].content[0], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } });
  assert.match(r.messages[0].content[1].text, /JSON/);
  // Sonnet 5.5 : ces champs renvoient une erreur 400 — ils ne doivent jamais être envoyés
  for (const k of ['temperature', 'top_p', 'top_k', 'tool_choice']) assert.ok(!(k in r), k);
  assert.ok(!('thinking' in r) || r.thinking.type !== 'disabled');
  assert.ok(!r.messages.some((m) => m.role === 'assistant'), 'pas de préremplissage');
});

test('extractJson : balises de code, texte autour, accolades dans les chaînes', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Voici : {"a":"x } y","b":{"c":2}} merci'), { a: 'x } y', b: { c: 2 } });
  assert.deepEqual(extractJson('{"a":"guillemet \\" échappé"}'), { a: 'guillemet " échappé' });
  for (const bad of ['', 'aucun json', '{"a":1', '{a:1}']) assert.throws(() => extractJson(bad), AiError);
});

test('parseResponse : assainissement complet (XSS, EAN halluciné, types, plafonds)', () => {
  const r = parseResponse(reply({
    product_name: '  Sac <b>cuir</b>  ', product_description: 'Un sac', product_category: 'Maroquinerie', confidence: 'high',
    spare_parts: [
      { id: 'x\'); alert(1);//', name: '<img src=x onerror=alert(1)>Fermoir', family: 'Fermoirs', description: 'd', typical_ean: '3700089690011', typical_threshold: '7', priority: 'high' },
      { name: 'Anse', typical_threshold: -3, priority: 'ultra' },
      { name: '   ' }, null, { },
      ...Array.from({ length: 30 }, (_, i) => ({ name: `Pièce ${i}` })),
    ],
  }));
  assert.equal(r.product.name, 'Sac <b>cuir</b>', 'texte conservé tel quel (échappé à l\'affichage), espaces rognés');
  assert.equal(r.parts.length, AI.maxParts);
  assert.deepEqual(r.parts.map((p) => p.id), Array.from({ length: AI.maxParts }, (_, i) => `p${i}`), 'identifiants séquentiels attribués par le code');
  assert.equal(r.parts[0].typical_threshold, 7);
  assert.equal(r.parts[1].typical_threshold, 5, 'seuil négatif → valeur par défaut');
  assert.equal(r.parts[1].priority, 'medium');
  assert.ok(r.parts.every((p) => !('typical_ean' in p)), 'aucun EAN du modèle conservé');
});

test('parseResponse : refus, vide, tronqué, confiance inconnue', () => {
  assert.throws(() => parseResponse({ content: [], stop_reason: 'refusal' }), /refusée/);
  assert.throws(() => parseResponse({ content: [], stop_reason: 'max_tokens' }), /trop longue/);
  assert.throws(() => parseResponse({ content: [{ type: 'text', text: '{"product_name":"x","spare_parts":[{"name":"a"' }] }), /tronquée/);
  assert.throws(() => parseResponse(null), AiError);
  assert.equal(parseResponse(reply({ product_name: 'x', confidence: 'certain' })).product.confidence, 'low');
  assert.deepEqual(parseResponse(reply({})).parts, []);
  assert.equal(parseResponse({ content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '{"product_name":"ok"}' }] }).product.name, 'ok');
});

test('appel : en-têtes requis, succès', async () => {
  let seen;
  const out = await analyzePhoto({
    apiKey: KEY, base64: 'QUJD',
    fetchImpl: async (url, init) => { seen = { url, init }; return { ok: true, status: 200, json: async () => reply({ product_name: 'Sac', spare_parts: [{ name: 'Anse' }] }) }; },
  });
  assert.equal(seen.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(seen.init.headers['x-api-key'], KEY);
  assert.equal(seen.init.headers['anthropic-version'], '2023-06-01');
  assert.equal(seen.init.headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.equal(JSON.parse(seen.init.body).model, 'claude-sonnet-5-5');
  assert.equal(out.parts[0].name, 'Anse');
});

test('appel : erreurs HTTP expliquées ; seule une 401 demande d\'effacer la clé', async () => {
  const run = (f) => analyzePhoto({ apiKey: KEY, base64: 'x', fetchImpl: f }).then(() => null, (e) => e);
  const e401 = await run(errFetch(401));
  assert.ok(e401 instanceof AiError && e401.clearKey && /invalide ou révoquée/.test(e401.message));
  for (const [status, re] of [[429, /Trop de requêtes/], [529, /surchargé/], [503, /Erreur du service/], [413, /trop volumineuse/], [403, /Accès refusé/]]) {
    const e = await run(errFetch(status));
    assert.ok(e && !e.clearKey && re.test(e.message), `${status} : ${e?.message}`);
  }
  const e400 = await run(errFetch(400, { error: { message: 'image: too large' } }));
  assert.match(e400.message, /image trop volumineuse.*too large/s);
  const eNet = await run(async () => { throw new TypeError('Failed to fetch'); });
  assert.ok(!eNet.clearKey, 'une panne réseau ne doit PAS effacer la clé (contrairement à index2.html)');
  assert.match(eNet.message, /Connexion impossible/);
  const eAbort = await run(async () => { throw Object.assign(new Error('x'), { name: 'AbortError' }); });
  assert.equal(eAbort.code, 'abort');
  const eJson = await run(async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad'); } }));
  assert.equal(eJson.code, 'parse');
  const eKey = await analyzePhoto({ apiKey: 'nope', base64: 'x', fetchImpl: okFetch({}) }).catch((e) => e);
  assert.equal(eKey.code, 'key');
});
