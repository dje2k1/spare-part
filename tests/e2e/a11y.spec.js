// Accessibilité automatisée (axe-core, WCAG 2.1 A/AA) sur tous les écrans, thèmes clair et sombre.
// Ne remplace pas un audit manuel (lecteur d'écran, zoom 200 %), mais attrape contrastes, noms, rôles, étiquettes.
import AxeBuilder from '@axe-core/playwright';
import { test, expect, seedDemo, loginDemo, go } from './helpers.js';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
const ROUTES = ['#/home', '#/articles', '#/reorder', '#/plan', '#/transfers', '#/journal', '#/inventory', '#/dashboard', '#/admin', '#/admin?s=data', '#/admin?s=users', '#/photo', '#/scan/in'];

async function audit(page, label) {
  const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const summary = violations.map((v) => `${label} — ${v.id} (${v.impact}) : ${v.help}\n   ${v.nodes.slice(0, 4).map((n) => n.target.join(' ')).join('\n   ')}`);
  expect(summary, `violations d'accessibilité\n${summary.join('\n')}`).toEqual([]);
}

for (const scheme of ['light', 'dark']) {
  test.describe(`accessibilité (${scheme})`, () => {
    test.use({ colorScheme: scheme });

    test('connexion : dépôt, profil, PIN', async ({ page }) => {
      await seedDemo(page);
      await page.goto('./');
      await audit(page, 'depot');
      await page.locator('[data-action="login.depot"]').first().click();
      await audit(page, 'profil');
      await page.locator('[data-action="login.user"]').first().click();
      await audit(page, 'pin');
    });

    test('écrans de l\'application', async ({ page }) => {
      await loginDemo(page);
      for (const hash of ROUTES) {
        await go(page, hash);
        await page.waitForTimeout(250);
        await audit(page, hash);
      }
    });

    test('feuille article, menu et dialogues', async ({ page }) => {
      await loginDemo(page);
      await go(page, '#/articles');
      await page.locator('#articles-list .row').first().click();
      await audit(page, 'feuille article');
      await page.getByRole('button', { name: 'Fiche' }).click();
      await audit(page, 'feuille fiche');
      await page.locator('#sheet [data-action="sheet.close"]').first().click();
      await page.locator('[data-action="menu.open"]').first().click();
      await audit(page, 'menu');
    });
  });
}
