// Parcours de toutes les vues avec la base de démo : aucune erreur JS/CSP, contenu attendu, captures optionnelles.
import { test, expect, loginDemo, go } from './helpers.js';

const SHOTS = process.env.SHOTS_DIR;
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false }); };

const ROUTES = [
  ['#/home', 'Bonjour'], ['#/articles', 'Articles'], ['#/reorder', 'À réapprovisionner'], ['#/plan', 'Emplacements'],
  ['#/transfers', 'Transferts'], ['#/journal', 'Journal'], ['#/inventory', 'Inventaire guidé'],
  ['#/dashboard', 'Tableau de bord'], ['#/admin', 'Administration'], ['#/photo', 'Analyser une pièce'],
];

test.describe('vues', () => {
  test('chaque écran s\'affiche sans erreur', async ({ page }) => {
    await loginDemo(page);
    for (const [hash, title] of ROUTES) {
      await go(page, hash);
      await expect(page.locator('#view')).toContainText(title);
      await shot(page, hash.slice(2));
    }
  });
});
