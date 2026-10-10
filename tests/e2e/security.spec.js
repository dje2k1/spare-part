// Sécurité : verrouillage progressif, verrouillage par inactivité, PIN hachés, CSP, aucune requête tierce.
import { test, expect, seedDemo, login, loginDemo, db, typePin } from './helpers.js';

test('5 PIN erronés : compte verrouillé, même le bon PIN est refusé pendant le délai', async ({ page }) => {
  await seedDemo(page);
  await page.goto('./');
  await page.locator('[data-action="login.depot"]').first().click();
  await page.locator('[data-action="login.user"]', { hasText: 'Julie Laurent' }).click();
  for (let i = 0; i < 5; i++) {
    await typePin(page, '0000');
    await expect(page.locator('.pin-dot.is-on')).toHaveCount(0); // vérification terminée (PBKDF2) avant l'essai suivant
  }
  await expect(page.locator('[data-pin] [data-err]')).toContainText(/Trop d'essais|Réessayez|verrouillé/i);
  await typePin(page, '4567'); // bon PIN, mais compte verrouillé
  await expect(page.locator('.pin-dot.is-on')).toHaveCount(0);
  await expect(page.locator('#app')).toBeHidden();
  await expect(page.locator('[data-pin] [data-err]')).toContainText(/Réessayez|Trop d'essais|verrouillé/i);
  const lock = await page.evaluate(() => JSON.parse(localStorage.getItem('mode_auth_lock')));
  expect(Object.values(lock)[0].n).toBeGreaterThanOrEqual(5);
});

test('verrouillage après inactivité : retour à la connexion, journalisé', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-10-10T09:00:00Z') });
  await loginDemo(page, { name: 'Julie Laurent', pin: '4567', depot: 'Paris' });
  await page.clock.fastForward('16:00'); // > 15 min sans aucune action
  await page.clock.runFor(6000);
  await expect(page.locator('#login')).toBeVisible();
  await expect(page.locator('#app')).toBeHidden();
  await expect(page.locator('#login')).toContainText('inactivité');
});

test('stockage : aucun PIN en clair dans les comptes ; les données de démonstration le signalent', async ({ page }) => {
  await loginDemo(page);
  const data = await db(page);
  for (const u of Object.values(data.users)) {
    expect(typeof u.pin, u.name).toBe('object');
    expect(u.pin.hash ?? u.pin.h).toBeTruthy();
    expect(u.pin.iter).toBeGreaterThanOrEqual(100_000);
  }
  expect(data.meta.demo).toBe(true);
});

test('CSP stricte et aucune requête vers un domaine tiers', async ({ page }) => {
  const hosts = new Set();
  page.on('request', (r) => { const u = new URL(r.url()); if (u.protocol.startsWith('http')) hosts.add(u.host); });
  await loginDemo(page);
  for (const h of ['#/articles', '#/plan', '#/dashboard', '#/journal', '#/admin']) { await page.evaluate((x) => { location.hash = x; }, h); await page.waitForTimeout(150); }
  expect([...hosts]).toEqual(['127.0.0.1:4173']);
  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  expect(csp).toMatch(/script-src 'self'(;|$)/);
  expect(csp).not.toMatch(/unsafe-eval|script-src[^;]*unsafe-inline/);
  expect(csp).toMatch(/default-src 'none'/); // objets, cadres, etc. interdits par défaut
  expect(csp).toMatch(/base-uri 'none'/);
  expect(csp).toMatch(/form-action 'none'/);
});

test('déconnexion : la vue précédente n\'est plus accessible par le hash', async ({ page }) => {
  await loginDemo(page, { name: 'Sophie Martin', pin: '2345', depot: 'Paris' });
  await page.evaluate(() => { location.hash = '#/journal'; });
  await page.locator('[data-action="menu.open"]').first().click();
  await page.locator('[data-action="menu.logout"]').click();
  await page.locator('#modal [data-r="yes"]').click();
  await expect(page.locator('#login')).toBeVisible();
  await page.evaluate(() => { location.hash = '#/admin'; });
  await expect(page.locator('#login')).toBeVisible();
  await expect(page.locator('#app')).toBeHidden();
  void login;
});
