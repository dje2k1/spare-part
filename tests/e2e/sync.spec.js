// Mode serveur, de bout en bout : VRAI serveur de synchronisation (un par test, données isolées) et vrais
// navigateurs. Appareil neuf (code d'accès), temps réel entre deux appareils, saisie hors ligne puis envoi,
// conflit entre deux sites, analyse photo relayée par le serveur (API Anthropic simulée).
import http from 'node:http';
import AxeBuilder from '@axe-core/playwright';
import { test as base, expect, go, toastText, stockedArticle } from './helpers.js';
import { startApp, ORG, depotByCode } from '../server/helpers.js';

const test = base.extend({
  srvOptions: [{}, { option: true }],
  srv: async ({ srvOptions }, use) => {
    const s = await startApp(srvOptions);
    await use(s);
    await s.stop();
  },
});
test.describe.configure({ mode: 'parallel' });

const SOPHIE = { name: 'Sophie Martin', pin: '2345', depot: 'Paris' };
const JULIE = { name: 'Julie Laurent', pin: '4567', depot: 'Paris' };
const KARIM = { name: 'Karim Benali', pin: '2468', depot: 'Entrepôt' };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

/** Connexion en mode serveur sur un appareil neuf : code d'accès (une fois), dépôt, profil, PIN. */
async function connect(page, srv, { name, pin, depot }) {
  await page.goto(`${srv.base}/`);
  const org = page.locator('[data-submit="login.org"]');
  const choice = page.locator('[data-action="login.depot"], [data-action="login.user"]').first();
  await expect(org.or(choice)).toBeVisible();
  if (await org.isVisible()) {
    await org.locator('[name=org]').fill(ORG);
    await org.getByRole('button', { name: 'Continuer' }).click();
  }
  await page.locator('[data-action="login.depot"]', { hasText: depot }).click();
  await page.locator('[data-action="login.user"]', { hasText: name }).click();
  for (const d of pin) await page.locator(`.keypad [data-key="${d}"]`).click();
  await expect(page.locator('#app')).toBeVisible();
  const sheet = page.locator('#sheet[open]');
  await page.waitForTimeout(300);
  if (await sheet.count() && /Votre journée/.test(await sheet.locator('.sheet__title').innerText())) {
    await sheet.getByRole('button', { name: 'C\'est parti' }).click();
  }
  await expect(page.locator('#sync-btn')).toBeVisible();
}

async function scanOut(page, ean, qty) {
  await go(page, '#/scan/out');
  await page.locator('#scan-q').fill(ean);
  await page.locator('#scan-q').press('Enter');
  await page.locator('[name=qty]').fill(String(qty));
  await page.locator('.scan-card__go').click();
}

async function shownStock(page, ean) {
  await go(page, '#/articles');
  await page.locator('#articles-q').fill(ean);
  await expect(page.locator('#articles-list .row')).toHaveCount(1);
  return Number((await page.locator('#articles-list .row__qty').innerText()).replace(/\D/g, ''));
}

/** Les animations d'arrivée (opacité, glissement) doivent être terminées : axe mesure les contrastes réels. */
const settled = (page) => page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || !(a.effect?.getComputedTiming().endTime < 3000)), null, { timeout: 5000 });

async function audit(page, label) {
  await settled(page);
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(violations.map((v) => `${label} — ${v.id} : ${v.help} (${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')})`)).toEqual([]);
}

const serverStock = (srv, code, ean) => srv.app.store.db.stocks[depotByCode(srv.app.store.db, code).id][ean] ?? 0;

/**
 * Coupure réseau RÉELLE : le serveur cesse d'écouter et ferme ses connexions. Avec un service worker actif,
 * l'émulation hors ligne du navigateur (context.setOffline) laisse parfois passer une requête ; la réponse se
 * perd au rechargement et le serveur paraît « déjà à jour ». Couper le serveur rend le test déterministe.
 */
const cutServer = (srv) => new Promise((resolve) => { srv.app.server.close(() => resolve()); srv.app.server.closeAllConnections(); });
const restoreServer = (srv) => new Promise((resolve) => srv.app.server.listen(Number(new URL(srv.base).port), '127.0.0.1', resolve));
const articleNamed = (srv, prefix) => Object.values(srv.app.store.db.articles).find((a) => a.name.startsWith(prefix));

test.describe('mode serveur', () => {
  test.use({ expectedHttpErrors: [/\/api\/(directory|login)$/] }); // code d'accès et PIN faux : refus volontaires

  test('appareil neuf : code d\'accès, PIN vérifié par le serveur, saisie enregistrée sur le serveur', async ({ page, srv }) => {
    await page.goto(`${srv.base}/`);
    const org = page.locator('[data-submit="login.org"]');
    await org.locator('[name=org]').fill('MAUVAIS-CODE');
    await org.getByRole('button', { name: 'Continuer' }).click();
    await expect(org.locator('[data-err]')).toContainText('incorrect');
    await org.locator('[name=org]').fill(ORG.toLowerCase());
    await org.getByRole('button', { name: 'Continuer' }).click();
    await page.locator('[data-action="login.depot"]', { hasText: 'Paris' }).click();
    await page.locator('[data-action="login.user"]', { hasText: 'Sophie Martin' }).click();
    for (const d of '9999') await page.locator(`.keypad [data-key="${d}"]`).click();
    await expect(page.locator('[data-pin] [data-err]')).toContainText('PIN incorrect');
    for (const d of '2345') await page.locator(`.keypad [data-key="${d}"]`).click();
    await expect(page.locator('#app')).toBeVisible();
    await expect(page.locator('#sync-btn')).toHaveAttribute('data-state', 'ok');
    expect(srv.app.store.db.audit.some((a) => a.action === 'Connexion de Sophie Martin')).toBe(true);
    // la session est un cookie HttpOnly : invisible du JavaScript de la page
    expect(await page.evaluate(() => document.cookie)).toBe('');
    // aucune empreinte de PIN d'un autre compte sur l'appareil
    const stored = await page.evaluate(() => JSON.stringify(localStorage));
    expect(stored.match(/PBKDF2/g)?.length ?? 0).toBe(1); // la sienne seulement (déverrouillage hors ligne)
    const art = stockedArticle(srv.app.store.db, 'Paris', 2);
    const was = serverStock(srv, 'DEP-01', art.ean);
    await page.locator('.sheet__close, [data-action="sheet.close"]').first().click({ timeout: 1000 }).catch(() => {});
    await scanOut(page, art.ean, 2);
    await expect(toastText(page)).toContainText(`−2 × ${art.name}`);
    await expect.poll(() => serverStock(srv, 'DEP-01', art.ean)).toBe(was - 2);
    await expect(page.locator('#sync-btn')).toHaveAttribute('data-state', 'ok');
    expect(srv.app.store.db.history[0]).toMatchObject({ ean: art.ean, type: 'out', operator: 'Sophie Martin' });
  });

  test('temps réel : la commande d\'un atelier apparaît à l\'entrepôt sans recharger', async ({ browser, srv }) => {
    const central = await browser.newPage();
    const atelier = await browser.newPage();
    await connect(central, srv, KARIM);
    const badge = central.locator('#orders-count');
    const before = Number(await badge.isVisible() ? await badge.innerText() : 0);
    await connect(atelier, srv, SOPHIE);
    const nacre = articleNamed(srv, 'Bouton nacre');
    await atelier.getByTestId('tile-order').click();
    await atelier.locator('#cart-q').fill(nacre.ean);
    await atelier.locator('#cart-q').press('Enter');
    await expect(atelier.locator('.cart-line')).toHaveCount(1);
    await atelier.getByTestId('cart-submit').click();
    await atelier.locator('#modal [data-r="yes"]').click();
    await expect(toastText(atelier)).toContainText(/Commande CMD \d+ envoyée/);
    await expect(badge).toHaveText(String(before + 1), { timeout: 8000 });
    const order = Object.values(srv.app.store.db.orders).filter((o) => o.status === 'submitted').sort((a, b) => b.no - a.no)[0];
    expect(order.submittedBy).toBe('Sophie Martin');
    await go(central, '#/orders');
    await expect(central.locator(`[data-action="orders.open"][data-id="${order.id}"]`)).toBeVisible();
    await central.close();
    await atelier.close();
  });

  test('hors ligne : la saisie est conservée, signalée, puis envoyée au retour du réseau', async ({ page, context, srv }) => {
    await connect(page, srv, JULIE);
    const zip = stockedArticle(srv.app.store.db, 'Paris', 2);
    const was = serverStock(srv, 'DEP-01', zip.ean);
    await context.setOffline(true);
    await expect(page.locator('#sync-btn')).toHaveAttribute('data-state', 'offline', { timeout: 8000 });
    await scanOut(page, zip.ean, 1);
    await expect(toastText(page)).toContainText(`−1 × ${zip.name}`);
    await expect(page.locator('#sync-count')).toHaveText('1');
    expect(serverStock(srv, 'DEP-01', zip.ean)).toBe(was);
    await page.locator('#sync-btn').click();
    await expect(page.locator('#sheet')).toContainText('En attente d\'envoi (1)');
    await expect(page.locator('#sheet')).toContainText(`Sortie · 1 × ${zip.name}`);
    await page.locator('#sheet [data-action="sheet.close"]').first().click();
    await context.setOffline(false);
    await expect.poll(() => serverStock(srv, 'DEP-01', zip.ean), { timeout: 15_000 }).toBe(was - 1);
    await expect(page.locator('#sync-btn')).toHaveAttribute('data-state', 'ok', { timeout: 15_000 });
    await expect(page.locator('#sync-count')).toBeHidden();
  });

  test('conflit entre deux appareils hors ligne : le second est refusé, le motif est montré, le stock corrigé', async ({ browser, srv }) => {
    const nacre = articleNamed(srv, 'Bouton nacre');
    const admin = Object.values(srv.app.store.db.users).find((u) => u.role === 'admin');
    const paris = depotByCode(srv.app.store.db, 'DEP-01').id;
    srv.app.store.apply({ opId: `setup${Date.now().toString(36)}`, name: 'adjustStock', params: { ean: nacre.ean, qty: 4, reason: 'Inventaire' }, depotId: paris, at: new Date().toISOString() }, admin);
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();
    await connect(a, srv, SOPHIE);
    await connect(b, srv, JULIE);
    await ctxA.setOffline(true);
    await ctxB.setOffline(true);
    await scanOut(a, nacre.ean, 3);
    await expect(toastText(a)).toContainText('−3 ×');
    await scanOut(b, nacre.ean, 3);
    await expect(toastText(b)).toContainText('−3 ×');
    await ctxA.setOffline(false);
    await expect.poll(() => serverStock(srv, 'DEP-01', nacre.ean), { timeout: 15_000 }).toBe(1);
    await ctxB.setOffline(false);
    await expect(b.locator('.toast__text', { hasText: 'Refusé par le serveur' })).toContainText('Stock insuffisant', { timeout: 15_000 });
    await expect(b.locator('#sync-btn')).toHaveAttribute('data-state', 'error');
    await b.locator('#sync-btn').click();
    await expect(b.locator('#sheet')).toContainText('Refusées par le serveur');
    await expect(b.locator('#sheet')).toContainText(`Sortie · 3 × ${nacre.name}`);
    await b.getByRole('button', { name: 'J\'ai pris connaissance' }).click();
    await expect(b.locator('#sync-btn')).toHaveAttribute('data-state', 'ok');
    expect(await shownStock(b, nacre.ean)).toBe(1);
    expect(serverStock(srv, 'DEP-01', nacre.ean)).toBe(1);
    await ctxA.close();
    await ctxB.close();
  });

  test('compte supprimé par l\'administrateur : déconnecté de son appareil', async ({ browser, srv }) => {
    const p = await browser.newPage();
    await connect(p, srv, JULIE);
    const admin = Object.values(srv.app.store.db.users).find((u) => u.role === 'admin');
    const julie = Object.values(srv.app.store.db.users).find((u) => u.name === 'Julie Laurent');
    srv.app.store.apply({ opId: `del${Date.now().toString(36)}`, name: 'deleteUser', params: { id: julie.id }, depotId: admin.depotId, at: new Date().toISOString() }, admin);
    await expect(p.locator('#login')).toBeVisible({ timeout: 8000 });
    await expect(p.locator('#login')).toContainText('n\'existe plus');
    await p.close();
  });
});

for (const scheme of ['light', 'dark']) {
  test(`accessibilité du mode serveur (${scheme}) : code d'accès, synchronisation, données`, async ({ page, srv }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(`${srv.base}/`);
    await expect(page.locator('[data-submit="login.org"]')).toBeVisible();
    await audit(page, 'code d\'accès');
    await connect(page, srv, { name: 'Administrateur', pin: '1234', depot: 'Paris' });
    await page.locator('#sync-btn').click();
    await expect(page.locator('#sheet')).toContainText('Aucune saisie en attente');
    await audit(page, 'synchronisation');
    await page.locator('#sheet [data-action="sheet.close"]').first().click();
    await go(page, '#/admin?s=data');
    await expect(page.locator('#view')).toContainText('Sauvegarde du serveur');
    await audit(page, 'données (serveur)');
  });
}

test.describe('application rouverte sans réseau', () => {
  test.use({ serviceWorkers: 'allow' });

  test('déverrouillage sur l\'appareil, saisie conservée après rechargement, envoyée au retour du réseau', async ({ page, context, srv }) => {
    await connect(page, srv, JULIE);
    await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.active?.state), { timeout: 15_000 }).toBe('activated');
    await page.reload();
    await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
    const zip = stockedArticle(srv.app.store.db, 'Paris', 2);
    const was = serverStock(srv, 'DEP-01', zip.ean);

    await context.setOffline(true);
    await cutServer(srv);
    await connect(page, srv, JULIE); // page servie par le cache ; PIN vérifié sur l'appareil
    await expect(toastText(page)).toContainText('Hors ligne');
    await expect(page.locator('#sync-btn')).toHaveAttribute('data-state', 'offline');
    await scanOut(page, zip.ean, 1);
    await expect(page.locator('#sync-count')).toHaveText('1');

    await page.reload(); // application fermée puis rouverte, toujours sans réseau
    await connect(page, srv, JULIE);
    await expect(page.locator('#sync-count')).toHaveText('1');
    expect(await shownStock(page, zip.ean)).toBe(was - 1); // la saisie en attente reste visible
    expect(serverStock(srv, 'DEP-01', zip.ean)).toBe(was);

    await restoreServer(srv);
    await context.setOffline(false);
    await expect.poll(() => serverStock(srv, 'DEP-01', zip.ean), { timeout: 15_000 }).toBe(was - 1);
    await expect(page.locator('#sync-btn')).toHaveAttribute('data-state', 'ok', { timeout: 15_000 });
  });
});

test.describe('analyse photo relayée par le serveur', () => {
  let mock;
  const calls = [];
  test.beforeAll(async () => {
    mock = http.createServer(async (req, res) => {
      let body = '';
      for await (const c of req) body += c;
      calls.push({ headers: req.headers, body: JSON.parse(body) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
        content: [{ type: 'text', text: JSON.stringify({ product_name: 'Sac cabas', product_description: 'Grand sac', product_category: 'Maroquinerie', confidence: 'high',
          spare_parts: [{ name: 'Anse cuir 60cm', family: 'Anses', description: 'Anse', typical_threshold: 6, priority: 'high' }] }) }] }));
    });
    await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  });
  test.afterAll(() => mock?.close());
  test.use({ srvOptions: async ({}, use) => use({ ai: { apiKey: 'sk-ant-serveur-0000000000000000000000', baseURL: `http://127.0.0.1:${mock.address().port}`, dailyLimit: 5 } }) });

  test('aucune clé sur l\'appareil ; analyse et import enregistrés sur le serveur', async ({ page, srv }) => {
    await connect(page, srv, SOPHIE);
    await go(page, '#/photo');
    await expect(page.locator('#photo-body')).toContainText('Analyse assurée par le serveur');
    await expect(page.locator('[name=key]')).toHaveCount(0);
    await page.locator('#photo-file').setInputFiles({ name: 'sac.png', mimeType: 'image/png', buffer: PNG });
    await page.getByRole('button', { name: 'Analyser le produit' }).click();
    await expect(page.locator('#photo-body')).toContainText('Sac cabas');
    expect(calls.at(-1).headers['x-api-key']).toBe('sk-ant-serveur-0000000000000000000000');
    expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('sk-ant-');
    await page.getByRole('button', { name: /Importer 1 pièce/ }).click();
    await expect(toastText(page)).toContainText('1 pièce(s) ajoutée(s)');
    await expect.poll(() => Object.values(srv.app.store.db.articles).some((x) => x.name === 'Anse cuir 60cm')).toBe(true);
  });
});
