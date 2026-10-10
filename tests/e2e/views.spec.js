// Parcours de toutes les vues avec la base de démo : aucune erreur JS/CSP, contenu attendu, captures optionnelles.
import { test, expect, loginDemo, go } from './helpers.js';

const SHOTS = process.env.SHOTS_DIR;
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false }); };

const ROUTES = [
  ['#/home', /Bonjour|Bonsoir/], ['#/articles', 'Articles'], ['#/reorder', 'À réapprovisionner'], ['#/plan', 'Emplacements'],
  ['#/transfers', 'Transferts'], ['#/journal', 'Journal'], ['#/inventory', 'Inventaire guidé'],
  ['#/dashboard', 'Tableau de bord'], ['#/admin', 'Administration'], ['#/photo', 'Analyser une pièce'],
];

/** Aucun défilement horizontal : rien ne dépasse la largeur du téléphone (390 px). */
async function noSideScroll(page, label) {
  const over = await page.evaluate(() => {
    const w = document.documentElement.clientWidth;
    return document.documentElement.scrollWidth > w + 1 ? [...document.querySelectorAll('#view *, #sheet *')].filter((el) => el.getBoundingClientRect().right > w + 1).slice(0, 3).map((el) => `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}`) : [];
  });
  expect(over, `${label} : contenu plus large que l'écran`).toEqual([]);
}

test.describe('vues', () => {
  test('chaque écran s\'affiche sans erreur et sans défilement horizontal', async ({ page }) => {
    await loginDemo(page, { name: 'Sophie Martin', pin: '2345', depot: 'Paris' });
    for (const [hash, title] of ROUTES) {
      await go(page, hash);
      await expect(page.locator('#view')).toContainText(title);
      await noSideScroll(page, hash);
      await shot(page, hash.slice(2));
    }
    for (const hash of ['#/orders', '#/order', '#/levels', '#/labels', '#/reports', '#/scan/in', '#/scan/out', '#/scan/find']) {
      await go(page, hash);
      await page.waitForTimeout(150);
      await noSideScroll(page, hash);
    }
  });

  test('fiche de scan, fiche article et accueil de l\'entrepôt : sans défilement horizontal', async ({ page }) => {
    await loginDemo(page, { name: 'Sophie Martin', pin: '2345', depot: 'Paris' });
    const longest = await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem('mode_stock_v5')).articles).sort((a, b) => b.name.length - a.name.length)[0].ean);
    await go(page, '#/scan/out');
    await page.locator('#scan-q').fill(longest);
    await page.locator('#scan-q').press('Enter');
    await expect(page.locator('.scan-card')).toBeVisible();
    await noSideScroll(page, 'fiche de scan');
    await go(page, '#/articles');
    await page.locator('#articles-list .row').first().click();
    await expect(page.locator('#sheet')).toBeVisible();
    await noSideScroll(page, 'fiche article');
  });
});
