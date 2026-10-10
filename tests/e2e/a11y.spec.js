// Accessibilité automatisée (axe-core, WCAG 2.1 A/AA) sur tous les écrans, thèmes clair et sombre.
// Ne remplace pas un audit manuel (lecteur d'écran, zoom 200 %), mais attrape contrastes, noms, rôles, étiquettes.
import AxeBuilder from '@axe-core/playwright';
import { test, expect, seedDemo, loginDemo, go } from './helpers.js';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
const ROUTES = ['#/home', '#/articles', '#/reorder', '#/plan', '#/transfers', '#/journal', '#/inventory', '#/dashboard', '#/admin', '#/admin?s=data', '#/admin?s=users', '#/admin?s=depots', '#/photo', '#/scan/in', '#/scan/find', '#/orders', '#/order', '#/levels', '#/labels', '#/reports'];
const CENTRAL = ['#/home', '#/orders', '#/purchases?tab=buy', '#/purchases?tab=open', '#/suppliers'];

/** Les animations d'arrivée (opacité, glissement) doivent être terminées : axe mesure les contrastes réels. */
const settled = (page) => page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || !(a.effect?.getComputedTiming().endTime < 3000)), null, { timeout: 5000 });

async function audit(page, label) {
  await settled(page);
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
      test.setTimeout(150_000); // 20 écrans, chacun audité après la fin de ses animations
      await loginDemo(page);
      for (const hash of ROUTES) {
        await go(page, hash);
        await page.waitForTimeout(250);
        await audit(page, hash);
      }
    });

    test('entrepôt central : préparation, achats, réception', async ({ page }) => {
      await loginDemo(page, { name: 'Karim Benali', pin: '2468', depot: 'Entrepôt' });
      for (const hash of CENTRAL) { await go(page, hash); await page.waitForTimeout(250); await audit(page, hash); }
      await go(page, '#/orders');
      await page.locator('[data-action="orders.open"]').first().click();
      await page.waitForTimeout(300);
      await audit(page, 'préparation');
      await go(page, '#/purchases?tab=open');
      await page.locator('[data-action="pu.open"]').first().click();
      await audit(page, 'commande fournisseur');
      await page.locator('a[href^="#/preceive/"]').click();
      await page.waitForTimeout(300);
      await audit(page, 'réception fournisseur');
    });

    test('parcours magasinier : sortie au-delà du stock, historique de session, comptage d\'inventaire', async ({ page }) => {
      await loginDemo(page, { name: 'Sophie Martin', pin: '2345', depot: 'Paris' });
      await go(page, '#/scan/out');
      await page.locator('#scan-q').fill('bandouliere');
      await page.locator('#scan-suggest .row').first().click();
      await page.locator('[name=qty]').fill('9999');
      await expect(page.locator('#scan-over')).toBeVisible();
      await audit(page, 'sortie au-delà du stock');
      await page.locator('[name=qty]').fill('1');
      await page.locator('.scan-card__go').click();
      await expect(page.locator('.recap')).toBeVisible();
      await audit(page, 'récapitulatif de session');
      await page.locator('.recap').getByRole('button', { name: 'Voir', exact: true }).click();
      await audit(page, 'historique de session');
      await page.locator('#sheet [data-action="sheet.close"]').first().click();
      await go(page, '#/inventory');
      await page.getByRole('button', { name: 'Démarrer l\'inventaire' }).click();
      await audit(page, 'comptage d\'inventaire');
    });

    test('connexion d\'un grand site : filtre des profils', async ({ page }) => {
      await seedDemo(page, (d) => {
        const paris = Object.values(d.depots).find((x) => x.name.includes('Paris'));
        for (let i = 0; i < 8; i++) { const id = `usera11y${String(i).padStart(4, '0')}`; d.users[id] = { id, name: `Personne ${i}`, role: 'operator', depotId: paris.id, pin: null }; }
      });
      await page.goto('./');
      await page.locator('[data-action="login.depot"]', { hasText: 'Paris' }).click();
      await page.getByRole('searchbox', { name: 'Rechercher votre nom' }).fill('zzz');
      await audit(page, 'filtre des profils');
    });

    test('feuille article, menu et dialogues', async ({ page }) => {
      await loginDemo(page);
      await go(page, '#/articles');
      await page.locator('#articles-list .row').first().click();
      await audit(page, 'feuille article');
      await page.getByRole('button', { name: 'Fiche', exact: true }).click();
      await audit(page, 'feuille fiche');
      await page.locator('#sheet [data-action="sheet.close"]').first().click();
      await page.locator('[data-action="menu.open"]').first().click();
      await audit(page, 'menu');
      await page.locator('[data-action="menu.printer"]').click();
      await audit(page, 'imprimante');
    });
  });
}
