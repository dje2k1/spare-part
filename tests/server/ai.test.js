// Relais IA : la clé reste sur le serveur ; requête construite par le code de l'application ; quota ; erreurs.
// L'API Anthropic est simulée par un serveur local (ANTHROPIC_BASE_URL) : aucun appel réel, aucune clé réelle.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startApp } from './helpers.js';
import { parseResponse, AI } from '../../js/core/ai.js';

const KEY = 'sk-ant-test-0000000000000000000000000000';
const IMG = Buffer.from('fake-jpeg-bytes').toString('base64');
const ANSWER = { product_name: 'Sac à main', product_description: 'Sac en cuir', product_category: 'Maroquinerie', confidence: 'high',
  spare_parts: [{ name: 'Zip métal', family: 'Fermetures', description: 'Fermeture principale', typical_threshold: 5, priority: 'high' }] };

let mock, mockUrl, srv;
const calls = [];
let reply = () => ({ status: 200, body: { id: 'msg_1', type: 'message', role: 'assistant', model: AI.model, content: [{ type: 'text', text: JSON.stringify(ANSWER) }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 20 } } });

before(async () => {
  mock = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    calls.push({ url: req.url, headers: req.headers, body: JSON.parse(body || '{}') });
    const r = reply();
    res.writeHead(r.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(r.body));
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  mockUrl = `http://127.0.0.1:${mock.address().port}`;
  srv = await startApp({ ai: { apiKey: KEY, baseURL: mockUrl, dailyLimit: 3 } });
});
after(async () => { await srv?.stop(); mock?.close(); });

test('analyse relayée : clé du serveur, modèle et consigne de l\'application, réponse exploitable par l\'appareil', async () => {
  const c = srv.client();
  assert.equal((await c.get('/api/config')).json.ai, true);
  await c.login('Sophie Martin', '2345');
  const r = await c.post('/api/ai/analyze', { base64: IMG, mime: 'image/jpeg' });
  assert.equal(r.status, 200, r.text);
  const call = calls.at(-1);
  assert.equal(call.url, '/v1/messages');
  assert.equal(call.headers['x-api-key'], KEY);
  assert.equal(call.body.model, AI.model);
  assert.equal(call.body.messages[0].content[0].source.data, IMG);
  assert.doesNotMatch(r.text, /sk-ant-/, 'la clé ne revient jamais vers l\'appareil');
  const parsed = parseResponse(r.json.message);
  assert.equal(parsed.product.name, 'Sac à main');
  assert.equal(parsed.parts[0].name, 'Zip métal');
});

test('contrôles : rôle, format d\'image, données illisibles', async () => {
  const op = srv.client();
  await op.login('Julie Laurent', '4567');
  assert.equal((await op.post('/api/ai/analyze', { base64: IMG, mime: 'image/jpeg' })).status, 403, 'opérateur : analyse réservée aux responsables');
  const c = srv.client();
  await c.login('Marc Dubois', '3456');
  assert.equal((await c.post('/api/ai/analyze', { base64: IMG, mime: 'application/pdf' })).status, 400);
  assert.equal((await c.post('/api/ai/analyze', { base64: '<script>', mime: 'image/png' })).status, 413);
  assert.equal((await c.post('/api/ai/analyze', { mime: 'image/png' })).status, 413);
});

test('erreurs de l\'API traduites ; un échec ne consomme pas le quota ; quota quotidien par compte', async () => {
  const c = srv.client();
  await c.login('Karim Benali', '2468');
  reply = () => ({ status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } });
  const denied = await c.post('/api/ai/analyze', { base64: IMG, mime: 'image/jpeg' });
  assert.equal(denied.status, 502);
  assert.match(denied.json.error, /clé API du serveur est refusée/);
  reply = () => ({ status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'image trop grande' } } });
  assert.equal((await c.post('/api/ai/analyze', { base64: IMG, mime: 'image/jpeg' })).status, 400);
  reply = () => ({ status: 200, body: { id: 'm', type: 'message', role: 'assistant', model: AI.model, content: [{ type: 'text', text: '{}' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } });
  for (let i = 0; i < 3; i++) assert.equal((await c.post('/api/ai/analyze', { base64: IMG, mime: 'image/jpeg' })).status, 200, `analyse ${i + 1}/3`);
  const over = await c.post('/api/ai/analyze', { base64: IMG, mime: 'image/jpeg' });
  assert.equal(over.status, 429);
  assert.match(over.json.error, /Limite de 3 analyses/);
});

test('sans clé configurée : analyse indisponible (404), annoncé dans la configuration', async () => {
  const plain = await startApp();
  const c = plain.client();
  assert.equal((await c.get('/api/config')).json.ai, false);
  await c.login('Sophie Martin', '2345');
  assert.equal((await c.post('/api/ai/analyze', { base64: IMG, mime: 'image/jpeg' })).status, 404);
  await plain.stop();
});
