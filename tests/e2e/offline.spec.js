// Hors ligne : le service worker met toute l'application en cache ; après un premier chargement, plus besoin de réseau.
import { test, expect, seedDemo, login } from './helpers.js';

test.use({ serviceWorkers: 'allow' });

test('rechargement hors ligne : l\'application démarre et reste utilisable', async ({ page, context }) => {
  await seedDemo(page);
  await page.goto('./');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)), { timeout: 15_000 }).toBe(true).catch(async () => {
    await page.reload(); // le contrôle n'est acquis qu'au rechargement suivant la première installation
  });
  await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);

  await context.setOffline(true);
  await login(page); // page.goto('./') : servi par le cache, sans réseau
  await expect(page.locator('#view')).toBeVisible();
  await page.evaluate(() => { location.hash = '#/plan'; });
  await expect(page.locator('#view')).toContainText('Emplacements');
  await expect(page.locator('#net-dot')).toBeVisible(); // pastille « hors ligne »
  await context.setOffline(false);
});

test('le manifeste et les icônes sont servis, scope et start_url sous le sous-chemin', async ({ page, request }) => {
  await page.goto('./');
  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  const res = await request.get(new URL(href, page.url()).href);
  const m = await res.json();
  expect(m.display).toBe('standalone');
  expect(m.start_url).toMatch(/^\.\/?/);
  expect(m.icons.some((i) => i.purpose?.includes('maskable'))).toBe(true);
  for (const i of m.icons) expect((await request.get(new URL(i.src, new URL(href, page.url())).href)).status(), i.src).toBe(200);
});

test('mise à jour : bandeau proposé (jamais imposé), puis rechargement sur la nouvelle version', async ({ page, context }) => {
  await seedDemo(page);
  await page.goto('./');
  await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.active?.state), { timeout: 15_000 }).toBe('activated');
  await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  await login(page);

  // Le serveur publie « 9.9.9 » (cookie lu par tests/serve.js) : le service worker change, une nouvelle version s'installe.
  await context.addCookies([{ name: 'swv', value: '9.9.9', url: page.url() }]);
  await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r.update()));
  await expect(page.locator('.banner', { hasText: 'nouvelle version' })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#view')).toBeVisible(); // pas de rechargement imposé : la session est intacte
  await page.getByRole('button', { name: 'Mettre à jour' }).click();
  // l'ancien cache est supprimé à l'activation ; la page se recharge seule (le contexte peut disparaître pendant le sondage)
  await expect.poll(() => page.evaluate(async () => (await caches.keys()).sort().join(',')).catch(() => ''), { timeout: 15_000 }).toBe('mode-stock-9.9.9');
  await expect(page.locator('#login, #app').first()).toBeVisible();
});
