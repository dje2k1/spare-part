import { test, expect, seedDemo, login, loginDemo, db } from './helpers.js';

test('première visite : accueil d\'installation, démo, connexion en 3 temps', async ({ page }) => {
  await page.goto('./');
  await expect(page.getByRole('heading', { name: 'Bienvenue' })).toBeVisible();
  await page.getByRole('button', { name: /données de démonstration/i }).click();
  // choix du dépôt → profil → PIN
  await expect(page.getByRole('heading', { name: 'Où travaillez-vous ?' })).toBeVisible();
  await page.locator('[data-action="login.depot"]').first().click();
  await expect(page.getByRole('heading', { name: 'Qui êtes-vous ?' })).toBeVisible();
  await page.locator('[data-action="login.user"]', { hasText: 'Administrateur' }).click();
  for (const d of '1234') await page.locator(`.keypad [data-key="${d}"]`).click();
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.getByTestId('version-pill')).toHaveText(/Version 2/);
});

test('accueil : indicateurs, actions et activité', async ({ page }) => {
  await loginDemo(page);
  await expect(page).toHaveTitle(/MODE/);
  await expect(page.locator('.kpis .kpi')).toHaveCount(3);
  await expect(page.locator('a.action')).toHaveCount(4);
  await expect(page.locator('.list .row').first()).toBeVisible();
});

test('captures (design)', async ({ page }, info) => {
  test.skip(!process.env.SHOTS_DIR, 'captures désactivées');
  const dir = process.env.SHOTS_DIR;
  await seedDemo(page);
  await page.goto('./');
  await page.screenshot({ path: `${dir}/01-depot.png` });
  await page.locator('[data-action="login.depot"]').first().click();
  await page.screenshot({ path: `${dir}/02-profil.png` });
  await page.locator('[data-action="login.user"]').first().click();
  await page.locator('.keypad [data-key="1"]').click();
  await page.locator('.keypad [data-key="2"]').click();
  await page.screenshot({ path: `${dir}/03-pin.png` });
  await page.locator('.keypad [data-key="3"]').click();
  await page.locator('.keypad [data-key="4"]').click();
  await expect(page.locator('#app')).toBeVisible();
  await page.screenshot({ path: `${dir}/04-accueil.png` });
  await page.screenshot({ path: `${dir}/04-accueil-full.png`, fullPage: true });
  await page.locator('[data-action="menu.open"]').first().click();
  await page.screenshot({ path: `${dir}/05-menu.png` });
});
