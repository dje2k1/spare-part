// Aides E2E : base de démo pré-injectée (rapide), connexion par profil + PIN, et fixture qui fait
// ÉCHOUER tout test produisant une erreur JS, une violation de CSP ou une erreur réseau inattendue.
import { test as base, expect } from '@playwright/test';
import { buildDemoDb } from '../../js/core/seed.js';
import { KEYS } from '../../js/core/config.js';

let cachedDemo = null;
/** Base de démo avec vrais PIN hachés (150 000 itérations), générée une fois par worker. */
export async function demoJson() {
  cachedDemo ??= JSON.stringify(await buildDemoDb(new Date()));
  return cachedDemo;
}

export const test = base.extend({
  /** Page qui échoue si la console signale une erreur (dont les violations de CSP). */
  page: async ({ page }, use) => {
    const problems = [];
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('response', (r) => { if (r.status() >= 400) problems.push(`HTTP ${r.status()} : ${r.url()}`); });
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      const t = m.text();
      if (/^Failed to load resource/.test(t)) return; // déjà signalé avec l'URL par l'écouteur « response »
      problems.push(`console.error: ${t}`);
    });
    await use(page);
    const appErrors = await page.evaluate(() => window.__errors ?? []).catch(() => []);
    expect([...problems, ...appErrors.map((e) => `__errors: ${e}`)], 'erreurs JS / CSP pendant le test').toEqual([]);
  },
});
export { expect };

/** Injecte la base de démo dans localStorage avant le chargement de la page (une seule fois). */
export async function seedDemo(page, mutate) {
  let json = await demoJson();
  if (mutate) { const d = JSON.parse(json); mutate(d); json = JSON.stringify(d); }
  await page.addInitScript(([key, value]) => { if (!localStorage.getItem(key)) localStorage.setItem(key, value); }, [KEYS.db, json]);
}

/** Écrans de connexion : dépôt (si plusieurs) → profil → PIN. */
export async function login(page, { name = 'Administrateur', pin = '1234', depot } = {}) {
  await page.goto('./');
  const depotBtn = page.locator('[data-action="login.depot"]');
  if (await depotBtn.count()) await (depot ? depotBtn.filter({ hasText: depot }) : depotBtn.first()).click();
  await page.locator('[data-action="login.user"]', { hasText: name }).click();
  for (const d of pin) await page.locator(`.keypad [data-key="${d}"]`).click();
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('#view')).toBeVisible();
}

/** Raccourci : base de démo + connexion. */
export async function loginDemo(page, opts = {}) {
  await seedDemo(page, opts.mutate);
  await login(page, opts);
}

export const db = (page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key)), KEYS.db);
export const toastText = (page) => page.locator('.toast__text').last();

/** Navigue par hash et attend le rendu du titre. */
export async function go(page, hash, titleRe) {
  await page.evaluate((h) => { location.hash = h; }, hash);
  if (titleRe) await expect(page.locator('#topbar-title')).toHaveText(titleRe);
}
