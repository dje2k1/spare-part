// Inventaire guidé : comptage à l'aveugle, écarts, signature, PIN d'un responsable, brouillon qui survit au rechargement.
import { test, expect, loginDemo, login, db, go, toastText, typePin, scribble } from './helpers.js';

const SOPHIE = { name: 'Sophie Martin', pin: '2345', depot: 'Paris' };

async function startAlertInventory(page) {
  await go(page, '#/inventory');
  await page.locator('[name=scope]').selectOption('alert');
  await page.getByRole('button', { name: "Démarrer l'inventaire" }).click();
  await expect(page.locator('#inv-qty')).toBeVisible();
}

/** Compte tous les articles : la valeur saisie pour le n-ième est `values[n]`. Retourne [{name, real}]. */
async function countAll(page, values) {
  const counted = [];
  for (let i = 0; await page.locator('#inv-qty').count(); i++) {
    const name = (await page.locator('.scan-card__name').innerText()).trim();
    const real = values[i % values.length];
    await page.locator('#inv-qty').fill(String(real));
    counted.push({ name, real });
    await page.locator('[data-action="inv.next"]').click();
  }
  return counted;
}

test.describe('inventaire guidé', () => {
  test.beforeEach(async ({ page }) => { await loginDemo(page, SOPHIE); });

  test('parcours complet : comptage → écarts → signature → PIN → stocks corrigés et audités', async ({ page }) => {
    await startAlertInventory(page);
    await expect(page.locator('.inv-progress')).toContainText(/^1 \/ \d+/);
    const counted = await countAll(page, [500, 0]);
    await expect(page.locator('#inv-body')).toContainText('Écarts constatés');
    const before = await db(page);
    // sans signature : refusé
    await page.locator('[data-action="inv.validate"]').click();
    await expect(toastText(page)).toContainText('signature');
    // signature + mauvais PIN, puis bon PIN
    await scribble(page, '#sig');
    await page.locator('[data-action="inv.validate"]').click();
    await typePin(page, '9999', { ok: true });
    await expect(page.locator('#modal')).toContainText(/incorrect/i);
    await typePin(page, '2345', { ok: true });
    await expect(page.locator('#inv-body')).toContainText('Inventaire validé');

    const after = await db(page);
    const paris = Object.values(after.depots).find((d) => d.name.includes('Paris')).id;
    for (const { name, real } of counted) {
      const a = Object.values(after.articles).find((x) => x.name === name);
      expect(after.stocks[paris][a.ean], name).toBe(real);
    }
    const entry = after.audit.find((e) => e.type === 'inv' && /nventaire/.test(e.action) && e.meta?.sig);
    expect(entry?.meta.sig).toMatch(/^data:image\/png;base64,/);
    expect(after.history.filter((h) => h.type === 'inv' && h.note !== 'Import CSV').length).toBeGreaterThanOrEqual(before.history.filter((h) => h.type === 'inv').length);
    expect(await page.evaluate(() => localStorage.getItem('mode_inventory_draft'))).toBeNull();
  });

  test('le brouillon survit au rechargement et peut être repris ou abandonné', async ({ page }) => {
    await startAlertInventory(page);
    await page.locator('#inv-qty').fill('7');
    await page.locator('[data-action="inv.next"]').click();
    await login(page, SOPHIE); // un rechargement ramène à la connexion : la session n'est jamais conservée
    await go(page, '#/inventory');
    await expect(page.locator('#inv-body')).toContainText('Inventaire en cours');
    await expect(page.locator('#inv-body')).toContainText(/1 \/ \d+ articles comptés/);
    await page.locator('[data-action="inv.resume"]').click();
    await expect(page.locator('.inv-progress')).toContainText(/^2 \/ \d+/);
    await page.locator('[data-action="inv.back"]').count();
    await go(page, '#/home');
    await go(page, '#/inventory');
    await page.locator('[data-action="inv.discard"]').click();
    await page.locator('#modal [data-action="dialog.ok"], #modal .btn--danger').first().click();
    await expect(page.locator('#inv-body')).not.toContainText('Inventaire en cours');
  });

  test('saisie vide : on ne peut pas avancer sans compter (ou passer explicitement)', async ({ page }) => {
    await startAlertInventory(page);
    await page.locator('[data-action="inv.next"]').click();
    await expect(toastText(page)).toContainText('Saisissez la quantité');
    await page.locator('[data-action="inv.skip"]').click();
    await expect(page.locator('.inv-progress')).toContainText(/^2 \/ \d+/);
  });
});
