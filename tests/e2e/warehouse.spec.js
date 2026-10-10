// Ergonomie magasinier (passe 4) : douchette dans un champ, comptage d'inventaire au scan, historique de la
// session de scan avec annulation, garde-fou de stock, codes UPC-A/EAN-13 équivalents, connexion d'un grand site.
import { test, expect, loginDemo, seedDemo, db, go, toastText, stockedArticle } from './helpers.js';

const SOPHIE = { name: 'Sophie Martin', pin: '2345', depot: 'Paris' };
const parisOf = (d) => Object.values(d.depots).find((x) => x.name.includes('Paris'));
const stockAt = (d, ean) => d.stocks[parisOf(d).id][ean] ?? 0;

test('douchette pendant qu\'un champ quantité a le focus : le champ est restauré, le code est traité comme un scan', async ({ page }) => {
  await loginDemo(page, SOPHIE);
  const d = await db(page);
  const paris = parisOf(d);
  const order = Object.values(d.orders).find((o) => o.kind === 'internal' && o.status === 'shipped' && o.depotId === paris.id && o.lines.length >= 2);
  test.skip(!order, 'aucune livraison à plusieurs lignes dans la démonstration');
  await go(page, `#/receive/${order.id}`);
  const [a, b] = order.lines;
  const qtyA = page.locator(`#line-${a.ean} .mini-qty__input`);
  await expect(qtyA).toHaveValue(String(a.shipped));
  await qtyA.click();
  await page.keyboard.type(b.ean); // rafale (< 30 ms d'écart) tapée par erreur dans la quantité de A
  await page.keyboard.press('Enter');
  await expect(page.locator(`#line-${b.ean}`)).toHaveClass(/is-checked/);
  await expect(page.locator(`#line-${a.ean} .mini-qty__input`)).toHaveValue(String(a.shipped));
  await expect(page.locator(`#line-${a.ean}`)).not.toHaveClass(/is-checked/);
  // Une saisie humaine (lente) reste une saisie
  await page.locator(`#line-${a.ean} .mini-qty__input`).fill(String(a.shipped + 2));
  await page.locator(`#line-${a.ean} .mini-qty__input`).press('Tab');
  await expect(page.locator(`#line-${a.ean}`)).toContainText('Surplus 2');
});

test('inventaire : chaque lecture de la pièce affichée ajoute 1 ; une autre pièce de l\'inventaire s\'affiche', async ({ page }) => {
  await loginDemo(page, SOPHIE);
  const d = await db(page);
  await go(page, '#/inventory');
  await page.getByRole('button', { name: 'Démarrer l\'inventaire' }).click();
  const nameOf = async () => (await page.locator('.scan-card__name').innerText()).trim();
  const eanNamed = (n) => Object.values(d.articles).find((x) => x.name === n).ean;
  const first = await nameOf();
  await expect(page.locator('#inv-qty')).toBeFocused();
  for (let i = 0; i < 2; i++) { await page.keyboard.type(eanNamed(first)); await page.keyboard.press('Enter'); }
  await expect(page.locator('#inv-qty')).toHaveValue('2');
  // Une pièce plus loin dans la tournée : elle s'affiche et compte 1
  await page.getByRole('button', { name: 'Suivant' }).click();
  await page.getByRole('button', { name: 'Suivant' }).click();
  const third = await nameOf();
  await page.getByRole('button', { name: 'Précédent' }).click();
  await page.keyboard.type(eanNamed(third));
  await page.keyboard.press('Enter');
  await expect(page.locator('.scan-card__name')).toHaveText(third);
  await expect(page.locator('#inv-qty')).toHaveValue('1');
  // Code hors catalogue : refusé, rien ne change
  await page.keyboard.type('96385074');
  await page.keyboard.press('Enter');
  await expect(toastText(page)).toContainText('inconnu');
  await expect(page.locator('#inv-qty')).toHaveValue('1');
});

test('scan : historique de la session, annulation après la disparition du toast', async ({ page }) => {
  await loginDemo(page, SOPHIE);
  const d = await db(page);
  const art = stockedArticle(d, 'Paris', 3);
  const was = stockAt(d, art.ean);
  await go(page, '#/scan/out');
  await page.locator('#scan-q').fill(art.ean);
  await page.locator('#scan-q').press('Enter');
  await page.locator('.scan-card__go').click();
  await expect(page.locator('.recap')).toContainText('1 opération');
  await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove())); // le toast « Annuler » a disparu
  expect(stockAt(await db(page), art.ean)).toBe(was - 1);
  await page.locator('.recap').getByRole('button', { name: 'Voir', exact: true }).click();
  const sheet = page.locator('#sheet[open]');
  await expect(sheet).toContainText(art.name);
  await sheet.getByRole('button', { name: 'Annuler' }).click();
  await expect(sheet).toContainText('annulée');
  expect(stockAt(await db(page), art.ean)).toBe(was);
  await sheet.locator('[data-action="sheet.close"]').first().click();
  await expect(page.locator('.recap')).toContainText('0 opération');
});

test('sortie au-delà du stock : signalée tout de suite, « Tout » remplit la quantité disponible', async ({ page }) => {
  await loginDemo(page, SOPHIE);
  const d = await db(page);
  const art = stockedArticle(d, 'Paris', 2);
  const n = stockAt(d, art.ean);
  await go(page, '#/scan/out');
  await page.locator('#scan-q').fill(art.ean);
  await page.locator('#scan-q').press('Enter');
  await page.locator('[name=qty]').fill(String(n + 1));
  await expect(page.locator('#scan-over')).toBeVisible();
  await expect(page.locator('#scan-over')).toContainText(`${n} disponible`);
  await expect(page.locator('.scan-card__go')).toBeDisabled();
  await page.getByRole('button', { name: `Tout (${n})` }).click();
  await expect(page.locator('[name=qty]')).toHaveValue(String(n));
  await expect(page.locator('#scan-over')).toBeHidden();
  await expect(page.locator('.scan-card__go')).toBeEnabled();
});

test('code UPC-A lu pour une pièce enregistrée en EAN-13 : la pièce est retrouvée (pas de doublon)', async ({ page }) => {
  await loginDemo(page, {
    ...SOPHIE,
    mutate: (d) => {
      const paris = parisOf(d);
      const model = Object.values(d.articles)[0];
      d.articles['0036000291452'] = { ...model, ean: '0036000291452', name: 'Pièce importée UPC', locations: {} };
      for (const id of Object.keys(d.stocks)) d.stocks[id]['0036000291452'] = id === paris.id ? 7 : 0;
    },
  });
  await go(page, '#/scan/out');
  await page.locator('#scan-q').fill('036000291452');
  await page.locator('#scan-q').press('Enter');
  await expect(page.locator('.scan-card__name')).toHaveText('Pièce importée UPC');
  await expect(page.locator('.scan-card__stock')).toContainText('7');
});

test('grand site : un champ filtre la liste des profils à la connexion', async ({ page }) => {
  await seedDemo(page, (d) => {
    const paris = parisOf(d);
    for (const [i, name] of ['Alice Roux', 'Bruno Petit', 'Chloé Garnier', 'David Faure', 'Emma Girard', 'Hugo Lambert'].entries()) {
      const id = `userextra${String(i).padStart(3, '0')}`;
      d.users[id] = { id, name, role: 'operator', depotId: paris.id, pin: null };
    }
  });
  await page.goto('./');
  await page.locator('[data-action="login.depot"]', { hasText: 'Paris' }).click();
  const filter = page.getByRole('searchbox', { name: 'Rechercher votre nom' });
  await expect(filter).toBeFocused();
  await filter.fill('chloe');
  await expect(page.locator('[data-action="login.user"]:visible')).toHaveCount(1);
  await expect(page.locator('[data-action="login.user"]:visible')).toContainText('Chloé Garnier');
  await filter.fill('zzz');
  await expect(page.getByText('Aucun profil ne correspond.')).toBeVisible();
  await filter.fill('');
  await expect(page.locator('[data-action="login.user"]:visible')).toHaveCount(await page.locator('[data-action="login.user"]').count());
});

test('indicateurs d\'un atelier : les livraisons de l\'entrepôt comptent comme entrées', async ({ page }) => {
  await loginDemo(page, SOPHIE);
  await go(page, '#/dashboard');
  const entries = page.locator('.kpi', { hasText: 'Entrées 30 j' }).locator('.kpi__value');
  await expect(entries).not.toHaveText('+0');
  await expect(page.locator('.kpi', { hasText: 'Stock sain' })).toBeVisible();
});
