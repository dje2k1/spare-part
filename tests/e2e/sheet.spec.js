// Feuilles (fiches en bas d'écran) : hauteur du contenu, posées sur le bas, et geste de la poignée.
import { test, expect, loginDemo, go } from './helpers.js';

test('fiche en feuille : hauteur du contenu ; un petit glissement la laisse ouverte, un grand la ferme', async ({ page }) => {
  await loginDemo(page, { name: 'Sophie Martin', pin: '2345', depot: 'Paris' });
  await go(page, '#/articles');
  await page.locator('#view .row').first().click();
  const sheet = page.locator('#sheet[open]');
  await expect(sheet).toBeVisible();
  const vh = page.viewportSize().height;
  const box = await sheet.boundingBox();
  expect(box.height).toBeGreaterThan(vh * 0.6); // fiche longue : presque tout l'écran, jamais un simple en-tête
  expect(Math.abs(box.y + box.height - vh)).toBeLessThan(2); // posée sur le bas de l'écran
  const grab = await page.locator('#sheet .sheet__grab').boundingBox();
  const x = grab.x + grab.width / 2, y = grab.y + grab.height / 2;
  // Petit glissement : la feuille revient en place
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + 30, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  await expect(sheet).toBeVisible();
  expect(Math.abs((await sheet.boundingBox()).y - box.y)).toBeLessThan(2);
  // Grand glissement depuis l'en-tête : elle se ferme
  const head = await page.locator('#sheet .sheet__title').boundingBox();
  await page.mouse.move(head.x + 20, head.y + head.height / 2);
  await page.mouse.down();
  await page.mouse.move(head.x + 20, head.y + 320, { steps: 12 });
  await page.mouse.up();
  await expect(page.locator('#sheet[open]')).toHaveCount(0);
  await expect(page.locator('#topbar-title')).toHaveText('Articles'); // on reste sur l'écran d'origine
});

test('fiche en feuille : un appui sur l\'en-tête ne la ferme pas, le bouton Fermer si', async ({ page }) => {
  await loginDemo(page, { name: 'Sophie Martin', pin: '2345', depot: 'Paris' });
  await go(page, '#/articles');
  await page.locator('#view .row').first().click();
  await page.locator('#sheet .sheet__title').click();
  await page.waitForTimeout(300);
  await expect(page.locator('#sheet[open]')).toHaveCount(1);
  await page.locator('#sheet [data-action="sheet.close"]').click();
  await expect(page.locator('#sheet[open]')).toHaveCount(0);
});
