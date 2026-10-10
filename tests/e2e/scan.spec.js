import { test, expect, loginDemo, login, db, toastText, stockedArticle } from './helpers.js';
import { KEYS } from '../../js/core/config.js';

const stockOf = (data, depotName, ean) => {
  const d = Object.values(data.depots).find((x) => x.name.includes(depotName));
  return data.stocks[d.id][ean] ?? 0;
};
const eanByName = (data, part) => Object.values(data.articles).find((a) => a.name.includes(part)).ean;

test.describe('scan continu', () => {
  test.beforeEach(async ({ page }) => { await loginDemo(page, { name: 'Julie Laurent', pin: '4567', depot: 'Paris' }); });

  test('entrée par saisie du nom : fiche, quantité rapide, validation, réarmement', async ({ page }) => {
    const before = await db(page);
    const ean = eanByName(before, 'Zip YKK 20cm');
    const was = stockOf(before, 'Paris', ean);
    await page.goto('./#/scan/in');
    await expect(page.locator('#topbar-title')).toHaveText('Entrée de stock');
    await page.locator('#scan-q').fill('zip ykk');
    await page.locator('#scan-suggest .row', { hasText: '20cm' }).click();
    await expect(page.locator('.scan-card__name')).toHaveText(/Zip YKK 20cm/);
    await page.getByRole('button', { name: '+5', exact: true }).click();
    await expect(page.locator('[name=qty]')).toHaveValue('6');
    await page.locator('.scan-card__go').click();
    await expect(toastText(page)).toContainText(`+6 × ${before.articles[ean].name} · stock ${was + 6}`);
    await expect(page.locator('.scan-card')).toHaveCount(0);       // réarmé pour la pièce suivante
    await expect(page.locator('.recap')).toContainText('1 opération');
    expect(stockOf(await db(page), 'Paris', ean)).toBe(was + 6);
  });

  test('annuler immédiatement une opération', async ({ page }) => {
    const data = await db(page);
    const art = stockedArticle(data, 'Paris', 2);
    const ean = art.ean;
    const was = stockOf(data, 'Paris', ean);
    await page.goto('./#/scan/out');
    await page.locator('#scan-q').fill(ean);
    await page.locator('#scan-q').press('Enter');
    await page.locator('.scan-card__go').click();
    await expect(toastText(page)).toContainText(`−1 × ${art.name}`);
    expect(stockOf(await db(page), 'Paris', ean)).toBe(was - 1);
    await page.locator('.toast__action').click();
    await expect(page.locator('.toast__text').last()).toContainText('Opération annulée');
    expect(stockOf(await db(page), 'Paris', ean)).toBe(was);
  });

  test('sortie supérieure au stock : signalée avant validation, rien ne change', async ({ page }) => {
    const data = await db(page);
    const ean = eanByName(data, 'Bouton nacre');
    const was = stockOf(data, 'Paris', ean);
    await page.goto('./#/scan/out');
    await page.locator('#scan-q').fill(ean);
    await page.locator('#scan-q').press('Enter');
    await page.locator('[name=qty]').fill(String(was + 1));
    await expect(page.locator('#scan-over')).toContainText('Stock insuffisant');
    await expect(page.locator('.scan-card__go')).toBeDisabled();
    expect(stockOf(await db(page), 'Paris', ean)).toBe(was);
    await expect(page.locator('.scan-card')).toBeVisible(); // la fiche reste ouverte pour corriger
  });

  test('stock consommé entre-temps dans un autre onglet : refus avec message clair, rien ne change', async ({ page }) => {
    const data = await db(page);
    const art = stockedArticle(data, 'Paris', 2);
    const was = stockOf(data, 'Paris', art.ean);
    await page.goto('./#/scan/out');
    await page.locator('#scan-q').fill(art.ean);
    await page.locator('#scan-q').press('Enter');
    await page.getByRole('button', { name: `Tout (${was})` }).click();
    // Un second onglet sort une pièce pendant que la fiche est ouverte
    const other = await page.context().newPage();
    await login(other, { name: 'Sophie Martin', pin: '2345', depot: 'Paris' });
    await other.evaluate((h) => { location.hash = h; }, '#/scan/out');
    await other.locator('#scan-q').fill(art.ean);
    await other.locator('#scan-q').press('Enter');
    await other.locator('.scan-card__go').click();
    await expect(other.locator('.toast__text').last()).toContainText(`−1 × ${art.name}`);
    await other.close();
    await page.locator('.scan-card__go').click();
    await expect(toastText(page)).toContainText('Stock insuffisant');
    expect(stockOf(await db(page), 'Paris', art.ean)).toBe(was - 1);
    await expect(page.locator('.scan-card')).toBeVisible();
  });

  test('pièce inconnue : création avec l\'entrée (nom, famille, rangement)', async ({ page }) => {
    await page.goto('./#/scan/in');
    await page.locator('#scan-q').fill('2000000100019');
    await page.locator('#scan-q').press('Enter');
    await expect(page.locator('.eyebrow', { hasText: 'Code inconnu' })).toBeVisible();
    await page.locator('[name=name]').fill('Rivet cuivre 8mm');
    await page.locator('[name=family]').fill('Rivets');
    await page.locator('#scan-loc').fill('r2 a3 e1');
    await page.locator('[name=qty]').fill('40');
    await page.locator('.scan-card__go').click();
    await expect(toastText(page)).toContainText('+40 × Rivet cuivre 8mm');
    const data = await db(page);
    expect(data.articles['2000000100019']).toMatchObject({ name: 'Rivet cuivre 8mm', family: 'Rivets' });
    const loc = Object.values(data.locations).find((l) => l.rack === 'R2' && l.allee === 'A3' && l.etagere === 'E1' && !l.case);
    expect(loc).toBeTruthy();
    expect(data.articles['2000000100019'].locations[loc.depotId]).toEqual([loc.id]);
  });

  test('pièce inconnue en sortie : explication, pas de création', async ({ page }) => {
    await page.goto('./#/scan/out');
    await page.locator('#scan-q').fill('2000000100019');
    await page.locator('#scan-q').press('Enter');
    await expect(page.locator('.scan-card')).toContainText('pas encore au catalogue');
  });

  test('créer une pièce sans code-barres : code interne EAN-13 valide généré', async ({ page }) => {
    await page.goto('./#/scan/in');
    await page.locator('#scan-q').fill('Passe-poil');
    await page.getByRole('button', { name: /Créer « Passe-poil » sans code-barres/ }).click();
    await expect(page.locator('[name=name]')).toHaveValue('Passe-poil');
    const ean = await page.locator('.scan-card__name').innerText();
    expect(ean).toMatch(/^200\d{10}$/);
    await page.locator('.scan-card__go').click();
    const data = await db(page);
    expect(data.articles[ean].name).toBe('Passe-poil');
  });

  test('mode transfert : destinataire, débit immédiat, annulation restitue le stock', async ({ page }) => {
    const data = await db(page);
    const ean = stockedArticle(data, 'Paris', 3).ean;
    const was = stockOf(data, 'Paris', ean);
    await page.goto('./#/scan/transfer');
    await page.locator('#scan-q').fill(ean);
    await page.locator('#scan-q').press('Enter');
    await page.locator('[name=to]').selectOption({ label: 'Atelier Lyon – Sellerie' });
    await page.locator('[name=qty]').fill('3');
    await page.locator('.scan-card__go').click();
    await expect(toastText(page)).toContainText('→ Atelier Lyon');
    expect(stockOf(await db(page), 'Paris', ean)).toBe(was - 3);
    await page.locator('.toast__action').click();
    expect(stockOf(await db(page), 'Paris', ean)).toBe(was);
  });

  test('douchette (clavier) : une rafale de chiffres + Entrée ouvre la fiche', async ({ page }) => {
    const ean = eanByName(await db(page), 'Zip YKK 30cm');
    await page.goto('./#/scan/in');
    await page.locator('body').click({ position: { x: 5, y: 300 } });
    await page.keyboard.type(ean); // sans délai : une douchette envoie ses caractères à < 30 ms d'écart
    await page.keyboard.press('Enter');
    await expect(page.locator('.scan-card__name')).toHaveText(/Zip YKK 30cm/);
  });

  test('le mode choisi est conservé et change le titre', async ({ page }) => {
    await page.goto('./#/scan/in');
    await page.getByRole('button', { name: 'Sortie' }).click();
    await expect(page.locator('#topbar-title')).toHaveText('Sortie de stock');
    await expect(page).toHaveURL(/#\/scan\/out/);
  });
});
