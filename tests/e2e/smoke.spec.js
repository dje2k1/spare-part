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
  await expect(page.getByTestId('version-pill')).toHaveText(/Version 3/);
});

test('accueil magasinier : recherche, 4 tuiles avec compteurs, « Aujourd\'hui », briefing du jour', async ({ page }) => {
  await loginDemo(page, { name: 'Sophie Martin', pin: '2345', depot: 'Paris', keepBriefing: true });
  // Première connexion du jour : « Votre journée » s'ouvre, puis ne revient plus de la journée
  await expect(page.locator('#sheet .sheet__title')).toHaveText('Votre journée');
  await page.getByRole('button', { name: 'C\'est parti' }).click();
  await expect(page).toHaveTitle(/MODE/);
  await expect(page.locator('.tile')).toHaveCount(4);
  await expect(page.getByTestId('tile-receive').locator('.tile__count')).toBeVisible();
  await expect(page.getByTestId('lookup')).toBeVisible();
  await expect(page.locator('.today')).toBeVisible();
  await expect(page.locator('.kpis')).toHaveCount(0, { timeout: 1000 });
  await page.reload();
  await login(page, { name: 'Sophie Martin', pin: '2345', depot: 'Paris', keepBriefing: true });
  await expect(page.locator('#sheet[open]')).toHaveCount(0);
});

test('accueil de l\'entrepôt central : préparer, réceptionner, sortir, commander', async ({ page }) => {
  await loginDemo(page, { name: 'Karim Benali', pin: '2468', depot: 'Entrepôt' });
  await expect(page.locator('.tile__title')).toHaveText(['Préparer', 'Réceptionner', 'Sortir', 'Commander']);
  await page.getByTestId('lookup').click();
  await expect(page.locator('#topbar-title')).toHaveText('Rechercher une pièce');
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

test.describe('avec les animations', () => {
  test.use({ reducedMotion: 'no-preference' });
  test('accueil animé : compteurs, tuiles et navigation fonctionnent', async ({ page }) => {
    await loginDemo(page, { name: 'Sophie Martin', pin: '2345', depot: 'Paris' });
    await expect(page.locator('.tile')).toHaveCount(4);
    await expect(page.locator('#view.is-entering')).toHaveCount(0, { timeout: 3000 }); // l'arrivée se termine
    const value = page.locator('.hstat [data-count]').nth(1);
    await expect(value).toHaveText(await value.getAttribute('data-count')); // le compteur atteint sa valeur
    await page.getByTestId('tile-out').click();
    await expect(page.locator('body')).toHaveAttribute('data-accent', 'red');
    await expect(page.locator('#topbar-title')).toHaveText('Sortie de stock');
  });
});
