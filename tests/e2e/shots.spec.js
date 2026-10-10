// Captures d'écran pour la revue visuelle : SHOTS_DIR=/chemin npx playwright test shots
// (ignoré sinon). Couvre la connexion, les deux accueils et chaque écran, en clair et en sombre.
import { test, seedDemo, loginDemo, go } from './helpers.js';

const DIR = process.env.SHOTS_DIR;
const SOPHIE = { name: 'Sophie Martin', pin: '2345', depot: 'Paris' };
const KARIM = { name: 'Karim Benali', pin: '2468', depot: 'Entrepôt' };

for (const scheme of ['light', 'dark']) {
  test.describe(`captures ${scheme}`, () => {
    test.skip(!DIR, 'captures désactivées');
    test.use({ colorScheme: scheme, reducedMotion: 'no-preference' }); // l'application telle qu'elle s'anime

    test('installation', async ({ page }) => {
      await page.goto('./');
      await page.waitForTimeout(700);
      await page.screenshot({ path: `${DIR}/${scheme}-00-welcome.png` });
    });

    test('connexion', async ({ page }) => {
      await seedDemo(page);
      await page.goto('./');
      await page.waitForTimeout(700);
      await page.screenshot({ path: `${DIR}/${scheme}-01-login-depot.png` });
      await page.locator('[data-action="login.depot"]', { hasText: 'Paris' }).click();
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${DIR}/${scheme}-02-login-user.png` });
      await page.locator('[data-action="login.user"]', { hasText: 'Sophie' }).click();
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${DIR}/${scheme}-03-login-pin.png` });
    });

    test('atelier', async ({ page }) => {
      await loginDemo(page, SOPHIE);
      await page.waitForTimeout(900);
      const shot = (n) => page.screenshot({ path: `${DIR}/${scheme}-${n}.png` });
      await shot('10-home-atelier');
      await page.screenshot({ path: `${DIR}/${scheme}-11-home-atelier-full.png`, fullPage: true });
      for (const [name, hash] of [
        ['12-articles', '#/articles'], ['13-orders', '#/orders'], ['14-cart', '#/order'], ['15-scan-out', '#/scan/out'],
        ['16-dashboard', '#/dashboard'], ['17-journal', '#/journal'], ['18-plan', '#/plan'], ['19-transfers', '#/transfers'],
        ['20-levels', '#/levels'], ['21-labels', '#/labels'], ['22-reports', '#/reports'], ['23-inventory', '#/inventory'],
        ['24-admin', '#/admin'], ['25-photo', '#/photo'], ['26-reorder', '#/reorder'],
      ]) {
        await go(page, hash);
        await page.waitForTimeout(450);
        await shot(name);
      }
      await go(page, '#/articles');
      await page.locator('#articles-list .row').first().click();
      await page.waitForTimeout(500);
      await shot('27-article-sheet');
      await page.locator('#sheet [data-action="sheet.close"]').first().click();
      await page.waitForTimeout(300);
      await page.locator('[data-action="menu.open"]').first().click();
      await page.waitForTimeout(500);
      await shot('28-menu');
    });

    test('entrepôt central', async ({ page }) => {
      await loginDemo(page, KARIM);
      await page.waitForTimeout(900);
      const shot = (n) => page.screenshot({ path: `${DIR}/${scheme}-${n}.png` });
      await shot('30-home-central');
      for (const [name, hash] of [['31-orders-central', '#/orders'], ['32-purchases', '#/purchases?tab=buy'], ['33-suppliers', '#/suppliers']]) {
        await go(page, hash);
        await page.waitForTimeout(450);
        await shot(name);
      }
      await go(page, '#/orders');
      const open = page.locator('[data-action="orders.open"]').first();
      if (await open.count()) {
        await open.click();
        await page.waitForTimeout(700);
        await shot('34-pick');
      }
    });
  });
}

test('briefing du jour', async ({ page }) => {
  test.skip(!DIR, 'captures désactivées');
  await loginDemo(page, { ...SOPHIE, keepBriefing: true });
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${DIR}/light-29-briefing.png` });
});
