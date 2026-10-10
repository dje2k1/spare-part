// Parcours v3 de bout en bout (un seul appareil, base locale) : l'atelier commande, l'entrepôt prépare et
// expédie (reliquat), l'atelier réceptionne (écart) ; commande fournisseur ; seuils ; étiquettes ; rapport.
import { readFileSync } from 'node:fs';
import { test, expect, loginDemo, login, db, go, toastText, wedge } from './helpers.js';

const SOPHIE = { name: 'Sophie Martin', pin: '2345', depot: 'Paris' };
const KARIM = { name: 'Karim Benali', pin: '2468', depot: 'Entrepôt' };
const depotBy = (d, code) => Object.values(d.depots).find((x) => x.code === code);
const confirmModal = (page) => page.locator('#modal [data-r="yes"]').click();
const declineModal = (page) => page.locator('#modal [data-r="no"]').click();

async function stubPrint(page) {
  await page.addInitScript(() => { window.print = () => { window.__printed = (window.__printed || 0) + 1; }; });
}

test('commande atelier → préparation entrepôt (reliquat) → réception avec écart', async ({ page }) => {
  await stubPrint(page);
  // L'entrepôt n'a que 4 boutons nacre : la commande de 10 partira incomplète
  await loginDemo(page, { ...SOPHIE, mutate(d) {
    const cen = depotBy(d, 'CEN');
    const nacre = Object.values(d.articles).find((a) => a.name.startsWith('Bouton nacre'));
    d.stocks[cen.id][nacre.ean] = 4;
    for (const o of Object.values(d.orders)) if (o.kind === 'internal' && o.status === 'draft') delete d.orders[o.id];
  } });
  const start = await db(page);
  const nacre = Object.values(start.articles).find((a) => a.name.startsWith('Bouton nacre'));
  const zip = Object.values(start.articles).find((a) => a.name.startsWith('Zip YKK 20cm'));

  // ── Atelier : panier ──
  await page.getByTestId('tile-order').click();
  await expect(page.locator('#topbar-title')).toHaveText('Panier');
  await page.locator('#cart-q').fill(nacre.ean);
  await page.locator('#cart-q').press('Enter');
  await expect(page.locator('.cart-line')).toHaveCount(1);
  await expect(page.locator('.cart-line input')).toHaveValue('10', { timeout: 3000 }); // conditionnement de 10
  await page.locator('#cart-q').fill('zip ykk 20');
  await page.locator('#cart-results .row').first().click();
  await expect(page.locator('.cart-line')).toHaveCount(2);
  await page.locator(`.cart-line [data-action="cart.step"][data-ean="${zip.ean}"][data-delta="1"]`).click();
  await expect(page.locator(`.cart-line input[data-ean="${zip.ean}"]`)).toHaveValue('20');
  await page.getByTestId('cart-submit').click();
  await confirmModal(page);
  await expect(toastText(page)).toContainText(/Commande CMD \d+ envoyée/);
  await expect(page).toHaveURL(/#\/orders/);
  let d = await db(page);
  const order = Object.values(d.orders).filter((o) => o.depotId === depotBy(d, 'DEP-01').id && o.status === 'submitted').sort((a, b) => b.no - a.no)[0];
  expect(order.lines.map((l) => [l.ean, l.qty])).toEqual([[nacre.ean, 10], [zip.ean, 20]]);

  // ── Entrepôt central : préparation ──
  await login(page, KARIM);
  await go(page, '#/orders');
  await page.locator(`[data-action="orders.open"][data-id="${order.id}"]`).click();
  await expect(page).toHaveURL(new RegExp(`#/pick/${order.id}`));
  await expect(page.locator('.recv-line')).toHaveCount(2);
  d = await db(page);
  expect(d.orders[order.id]).toMatchObject({ status: 'picking', pickedBy: 'Karim Benali' });
  await expect(page.locator(`#pick-${nacre.ean} input`)).toHaveValue('4', { timeout: 3000 }); // limité au disponible
  await page.locator('#pick-q').fill(zip.ean);
  await page.locator('#pick-q').press('Enter');
  await expect(page.locator(`#pick-${zip.ean}`)).toHaveClass(/is-checked/);
  await page.getByTestId('pick-ship').click();
  await expect(page.locator('#modal')).toContainText('reliquat');
  await confirmModal(page); // expédier
  await expect(page.locator('#modal')).toContainText('bon de livraison');
  await confirmModal(page); // imprimer le bon
  await expect(page).toHaveURL(/#\/orders/);
  await expect.poll(() => page.evaluate(() => window.__printed)).toBe(1);
  d = await db(page);
  expect(d.orders[order.id].status).toBe('shipped');
  expect(d.orders[order.id].lines.map((l) => l.shipped)).toEqual([4, 20]);
  const back = Object.values(d.orders).find((o) => o.backorderOf === order.id);
  expect(back).toMatchObject({ status: 'submitted', lines: [{ ean: nacre.ean, qty: 6 }] });

  // ── Atelier : réception avec un manquant ──
  await login(page, SOPHIE);
  await go(page, `#/receive/${order.id}`);
  await page.locator('#recv-q').fill(nacre.ean);
  await page.locator('#recv-q').press('Enter');
  await page.locator(`#line-${zip.ean} [data-delta="-1"]`).click(); // 19 reçus sur 20
  await expect(page.locator(`#line-${zip.ean}`)).toContainText('Manque 1');
  await page.getByTestId('recv-validate').click();
  await expect(page.locator('#modal')).toContainText('1 écart');
  await confirmModal(page);
  await expect(page.locator('#modal')).toContainText('Étiqueter les pièces reçues');
  await declineModal(page);
  await expect(page).toHaveURL(/#\/home/);
  d = await db(page);
  expect(d.orders[order.id]).toMatchObject({ status: 'received', gaps: 1 });
  const paris = depotBy(d, 'DEP-01').id;
  expect(d.stocks[paris][zip.ean]).toBe(start.stocks[paris][zip.ean] + 19);
  expect(d.stocks[paris][nacre.ean]).toBe(start.stocks[paris][nacre.ean] + 4);
});

test('commande fournisseur : suggestions → brouillon → envoi → réception partielle', async ({ page }) => {
  await loginDemo(page, KARIM);
  await go(page, '#/purchases?tab=buy');
  const create = page.locator('[data-action="pu.create"]').first();
  await expect(create).toBeVisible();
  await create.click();
  await expect(page).toHaveURL(/#\/purchase\//);
  const id = page.url().split('/purchase/')[1];
  const first = page.locator('[data-change="pu.qty"]').first();
  await first.fill('120');
  await first.dispatchEvent('change');
  await expect(page.locator('[data-change="pu.qty"]').first()).toHaveValue('120');
  await page.getByRole('button', { name: 'Envoyer au fournisseur' }).click();
  await confirmModal(page);
  await expect(page.locator('#modal')).toContainText('e-mail');
  await declineModal(page);
  let d = await db(page);
  expect(d.orders[id]).toMatchObject({ kind: 'supplier', status: 'sent' });
  expect(d.orders[id].lines[0].qty).toBe(120);
  // Réception partielle : la première ligne seulement
  await go(page, `#/preceive/${id}`);
  const lines = d.orders[id].lines;
  for (const l of lines.slice(1)) await page.locator(`#line-${l.ean} input`).fill('0').then(() => page.locator(`#line-${l.ean} input`).dispatchEvent('change'));
  await page.getByTestId('recv-validate').click();
  if (await page.locator('#modal[open]').count()) await confirmModal(page);
  await expect(toastText(page)).toContainText(/reçue\(s\) ; le reste reste attendu|soldée/);
  d = await db(page);
  expect(d.orders[id].status).toBe(lines.length > 1 ? 'partial' : 'received');
  expect(d.orders[id].lines[0].received).toBe(120);
});

test('seuils intelligents : sélection et application', async ({ page }) => {
  await loginDemo(page, SOPHIE);
  await go(page, '#/levels');
  await page.getByRole('button', { name: 'Toutes les pièces' }).click();
  await expect(page.locator('.levels__row').first()).toBeVisible();
  const n = await page.locator('.levels__row').count();
  await page.getByRole('button', { name: 'Tout sélectionner' }).click();
  await expect(page.locator('#levels-apply')).toContainText(`Appliquer ${n}`);
  await page.locator('#levels-apply').click();
  await confirmModal(page);
  await expect(toastText(page)).toContainText('mis à jour');
  const d = await db(page);
  expect(Object.keys(d.levels[depotBy(d, 'DEP-01').id]).length).toBeGreaterThanOrEqual(n);
});

test('étiquettes : planche A4 imprimée, puis fichier ZPL pour imprimante thermique', async ({ page }) => {
  await stubPrint(page);
  await loginDemo(page, SOPHIE);
  const d = await db(page);
  const zip = Object.values(d.articles).find((a) => a.name.startsWith('Zip YKK 20cm'));
  await go(page, '#/labels');
  await page.locator('#labels-q').fill(zip.ean);
  await page.locator('#labels-q').press('Enter');
  await page.locator(`[data-action="labels.copies"][data-ean="${zip.ean}"][data-delta="1"]`).click();
  await page.locator('[data-action="labels.print"]').click();
  await expect.poll(() => page.evaluate(() => window.__printed)).toBe(1);
  await expect(page.locator('#print-root .lbl--sheet')).toHaveCount(2);
  await expect(page.locator('#print-root .lbl--sheet').first()).toContainText(zip.name);
  expect(await page.evaluate(() => document.getElementById('print-page-rule').textContent)).toContain('A4');
  // Profil thermique ZPL
  await page.locator('[data-action="labels.printer"]').click();
  await page.locator('#sheet [data-action="labels.printer.type"][data-value="thermal"]').click();
  await page.locator('#sheet [name=output]').selectOption('zpl');
  await page.locator('#sheet button[type=submit]').click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('[data-action="labels.print"]').click()]);
  expect(download.suggestedFilename()).toMatch(/\.zpl$/);
  const zpl = readFileSync(await download.path(), 'utf8');
  expect(zpl).toContain('^XA');
  expect(zpl).toContain(`^FD${zip.ean.slice(0, 12)}^FS`);
  expect(zpl).toContain('^PQ2');
});

test('rapport hebdomadaire et consultation par douchette depuis l\'accueil', async ({ page }) => {
  await stubPrint(page);
  await loginDemo(page, SOPHIE);
  const d = await db(page);
  const zip = Object.values(d.articles).find((a) => a.name.startsWith('Zip YKK 20cm'));
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await wedge(page, zip.ean);
  await expect(page.locator('#sheet .sheet__title')).toHaveText(zip.name);
  await page.locator('#sheet [data-action="sheet.close"]').first().click();
  await go(page, '#/reports');
  await expect(page.locator('.kpi').first()).toContainText('Pièces sorties');
  await page.locator('[data-action="rp.print"]').click();
  await expect.poll(() => page.evaluate(() => window.__printed)).toBe(1);
  await expect(page.locator('#print-root')).toContainText('Rapport 7 jours');
});

test('opérateur d\'atelier : pas de seuils, rapports ni fournisseurs ; achats réservés à l\'entrepôt', async ({ page }) => {
  await loginDemo(page, { name: 'Julie Laurent', pin: '4567', depot: 'Paris' });
  for (const h of ['#/levels', '#/reports', '#/suppliers']) {
    await go(page, h);
    await expect(page).toHaveURL(/#\/home/);
  }
  await go(page, '#/purchases');
  await expect(page.locator('#view')).toContainText('Réservé à l\'entrepôt central');
});
