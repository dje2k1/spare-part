// Point d'entrée du serveur : configuration par variables d'environnement (voir .env.example).
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createApp } from './app.js';
import { buildDemoDb, buildFreshDb } from '../js/core/seed.js';
import { pinPolicy } from '../js/core/auth.js';

const env = process.env;
const here = dirname(fileURLToPath(import.meta.url));
const stamp = () => new Date().toISOString();
const log = {
  info: (...a) => console.log(stamp(), ...a),
  warn: (...a) => console.warn(stamp(), 'ATTENTION', ...a),
  error: (...a) => console.error(stamp(), 'ERREUR', ...a),
};

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

const demo = env.DEMO === '1';
const orgCode = env.ORG_CODE || (demo ? 'DEMO' : '');
if (!orgCode) fail('ORG_CODE est obligatoire : c\'est le code d\'accès que chaque appareil saisira une fois (8 caractères ou plus conseillés).');

async function bootstrap() {
  if (demo) {
    log.info('Première installation : données de démonstration');
    return buildDemoDb(new Date());
  }
  const name = env.BOOTSTRAP_ADMIN_NAME?.trim();
  const pin = env.BOOTSTRAP_ADMIN_PIN?.trim();
  if (!name || !pin) fail('Première installation : définissez BOOTSTRAP_ADMIN_NAME et BOOTSTRAP_ADMIN_PIN (ou DEMO=1 pour essayer).');
  const policy = pinPolicy(pin);
  if (!policy.ok) fail(`BOOTSTRAP_ADMIN_PIN : ${policy.reason}`);
  log.info(`Première installation : administrateur « ${name} », entrepôt central « ${env.BOOTSTRAP_DEPOT_NAME || 'Entrepôt central'} »`);
  return buildFreshDb(new Date(), { adminName: name, pin, depotName: env.BOOTSTRAP_DEPOT_NAME || 'Entrepôt central', depotCode: env.BOOTSTRAP_DEPOT_CODE || 'CEN', depotKind: 'central' });
}

const app = await createApp({
  dataDir: resolve(env.DATA_DIR || resolve(here, 'data')),
  staticDir: resolve(env.STATIC_DIR || resolve(here, '..')),
  orgCode,
  bootstrap,
  ai: { apiKey: env.ANTHROPIC_API_KEY, baseURL: env.ANTHROPIC_BASE_URL, dailyLimit: Number(env.AI_DAILY_LIMIT) || 40 },
  trustProxy: env.TRUST_PROXY === '1',
  sessionHours: Number(env.SESSION_HOURS) || 12,
  log,
}).catch((e) => fail(e.message));

const port = Number(env.PORT) || 8080;
const host = env.HOST || '0.0.0.0';
app.server.listen(port, host, () => {
  log.info(`MODE Stock — serveur prêt sur http://${host}:${port} (données : ${env.DATA_DIR || 'server/data'}, version ${app.store.version})`);
  log.info(`Analyse photo : ${app.ai ? `activée (${app.ai.model}, ${app.ai.dailyLimit} analyses/jour/compte)` : 'désactivée (ANTHROPIC_API_KEY absente)'}`);
  if (demo) log.warn('MODE DÉMONSTRATION : comptes et PIN d\'essai visibles à la connexion. Ne pas utiliser en production.');
  if (orgCode.length < 8 && !demo) log.warn('ORG_CODE court : 8 caractères ou plus conseillés.');
});

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  log.info(`${signal} reçu : arrêt propre…`);
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  try { await app.close(); } catch (e) { log.error('arrêt', e); }
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
