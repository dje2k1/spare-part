// Captures d'écran pour la revue visuelle (SHOTS_DIR=/chemin npm run test:e2e -- shots). Ignoré sinon.
import { test, loginDemo, go } from './helpers.js';

const DIR = process.env.SHOTS_DIR;
for (const scheme of ['light', 'dark']) {
  test(`captures ${scheme}`, async ({ page }) => {
    test.skip(!DIR, 'captures désactivées');
    await page.emulateMedia({ colorScheme: scheme });
    await loginDemo(page);
    const shot = (n) => page.screenshot({ path: `${DIR}/${scheme}-${n}.png` });
    await shot('home');
    for (const [name, hash] of [['scan', '#/scan/in'], ['articles', '#/articles'], ['plan', '#/plan'], ['dashboard', '#/dashboard'], ['admin', '#/admin?s=data']]) {
      await go(page, hash); await page.waitForTimeout(350); await shot(name);
    }
    await go(page, '#/articles');
    await page.locator('#articles-list .row').first().click();
    await page.waitForTimeout(350); await shot('sheet');
  });
}
