// Articles, fiche, plan, transferts, journal, tableau de bord : parcours fonctionnels réels (clics, saisies, base résultante).
import { test, expect, loginDemo, db, go, toastText } from './helpers.js';

const SOPHIE = { name: 'Sophie Martin', pin: '2345', depot: 'Paris' };
const stockOf = (data, depotName, ean) => {
  const d = Object.values(data.depots).find((x) => x.name.includes(depotName));
  return data.stocks[d.id][ean] ?? 0;
};
const eanByName = (data, part) => Object.values(data.articles).find((a) => a.name.includes(part)).ean;

test.describe('articles et fiche', () => {
  test.beforeEach(async ({ page }) => { await loginDemo(page, SOPHIE); await go(page, '#/articles'); });

  test('recherche sans accent ni casse, filtres et compteurs', async ({ page }) => {
    await expect(page.locator('#articles-list .row').first()).toBeVisible();
    const all = await page.locator('#articles-list .row').count();
    await page.locator('#articles-q').fill('ZIP ykk');
    await expect(page.locator('#articles-list .row')).not.toHaveCount(all);
    await expect(page.locator('#articles-list .row').first()).toContainText('Zip YKK');
    await page.locator('#articles-q').fill('zzzzzz');
    await expect(page.locator('#articles-list')).toContainText('Aucune pièce trouvée');
    await page.locator('#articles-q').fill('');
    await page.getByRole('button', { name: /Alertes/ }).click();
    await expect(page.getByRole('button', { name: /Alertes/ })).toHaveAttribute('aria-pressed', 'true');
    for (const pill of await page.locator('#articles-list .row').all()) await expect(pill.locator('.pill')).toHaveCount(1);
  });

  test('fiche : correction de stock tracée en inventaire', async ({ page }) => {
    const data = await db(page);
    const ean = eanByName(data, 'Bouton nacre');
    const was = stockOf(data, 'Paris', ean);
    await page.locator('#articles-q').fill(ean);
    await expect(page.locator('#articles-list .row')).toHaveCount(1); // la recherche est temporisée
    await page.locator('#articles-list .row').click();
    await expect(page.locator('#sheet')).toBeVisible();
    await page.locator('[data-submit="art.adjust"] [name=qty]').fill(String(was + 7));
    await page.locator('[data-submit="art.adjust"] [name=reason]').selectOption('Inventaire');
    await page.locator('[data-submit="art.adjust"] button[type=submit]').click();
    await expect(toastText(page)).toContainText('Stock corrigé');
    const after = await db(page);
    expect(stockOf(after, 'Paris', ean)).toBe(was + 7);
    const last = after.history[0]; // le plus récent en premier
    expect(last).toMatchObject({ ean, type: 'inv', delta: 7 });
  });

  test('création d\'une pièce avec code interne, puis modification et rangement', async ({ page }) => {
    await page.locator('[data-action="articles.new"]').click();
    await page.locator('[data-action="art.gencode"]').click();
    await expect(page.locator('#sheet [name=ean]')).toHaveValue(/^200\d{10}$/);
    await page.locator('#sheet [name=name]').fill('Mousqueton laiton 15mm');
    await page.locator('#sheet [name=family]').fill('Mousquetons');
    await page.locator('#sheet [name=price]').fill('1,25');
    await page.locator('#sheet [name=threshold]').fill('12');
    await page.getByRole('button', { name: 'Créer la pièce' }).click();
    await expect(toastText(page)).toContainText('Pièce créée');
    const created = Object.values((await db(page)).articles).find((a) => a.name === 'Mousqueton laiton 15mm');
    expect(created).toMatchObject({ family: 'Mousquetons', price: 1.25, threshold: 12 });
    // rangement : « r1 a1 e2 » est normalisé en R1-A1-E2
    await page.getByRole('button', { name: 'Rangement' }).click();
    await page.locator('[data-submit="art.loc.add"] [name=code]').fill('r1 a1 e2');
    await page.locator('[data-submit="art.loc.add"] button[type=submit]').click();
    await expect(page.locator('#sheet .loc').first()).toContainText('R1-A1-E2');
  });

  test('XSS : un nom contenant du HTML s\'affiche littéralement, sans exécution', async ({ page }) => {
    const payload = '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>';
    await page.locator('[data-action="articles.new"]').click();
    await page.locator('[data-action="art.gencode"]').click();
    await page.locator('#sheet [name=name]').fill(payload);
    await page.getByRole('button', { name: 'Créer la pièce' }).click();
    await page.locator('#sheet [data-action="sheet.close"]').first().click();
    await page.locator('#articles-q').fill('onerror');
    await expect(page.locator('#articles-list .row__title').first()).toContainText('<img src=x onerror=');
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
    await expect(page.locator('#view img[src="x"]')).toHaveCount(0);
  });

  test('doublon de code refusé avec message', async ({ page }) => {
    const ean = eanByName(await db(page), 'Bouton nacre');
    await page.locator('[data-action="articles.new"]').click();
    await page.locator('#sheet [name=ean]').fill(ean);
    await page.locator('#sheet [name=name]').fill('Autre nom');
    await page.getByRole('button', { name: 'Créer la pièce' }).click();
    await expect(page.locator('#sheet [data-err]')).not.toBeEmpty();
    expect(Object.values((await db(page)).articles).some((a) => a.name === 'Autre nom')).toBe(false);
  });
});

test.describe('opérateur : droits limités', () => {
  test.beforeEach(async ({ page }) => { await loginDemo(page, { name: 'Julie Laurent', pin: '4567', depot: 'Paris' }); });

  test('écrans réservés aux responsables : redirection avec message', async ({ page }) => {
    for (const hash of ['#/admin', '#/inventory', '#/reorder', '#/photo']) {
      await go(page, hash);
      await expect(page).toHaveURL(/#\/home/);
      await expect(toastText(page)).toContainText('réservé');
    }
  });

  test('fiche en lecture seule : pas de correction de stock ni de suppression', async ({ page }) => {
    await go(page, '#/articles');
    await page.locator('#articles-list .row').first().click();
    await expect(page.locator('[data-submit="art.adjust"]')).toHaveCount(0);
    await page.getByRole('button', { name: 'Fiche', exact: true }).click();
    await expect(page.locator('#sheet')).toContainText('Lecture seule');
    await expect(page.locator('[data-action="art.delete"]')).toHaveCount(0);
  });
});

test.describe('plan, transferts, journal, tableau de bord', () => {
  test.beforeEach(async ({ page }) => { await loginDemo(page, SOPHIE); });

  test('plan : une case ouvre la liste de ses pièces', async ({ page }) => {
    await go(page, '#/plan');
    await expect(page.locator('.rack').first()).toBeVisible();
    await page.locator('button.cell').first().click();
    await expect(page.locator('#sheet .row').first()).toBeVisible();
  });

  test('transfert reçu : le stock du dépôt de destination augmente', async ({ page }) => {
    const before = await db(page);
    const t = Object.values(before.transfers).find((x) => x.status === 'pending' && x.toDepotId === Object.values(before.depots).find((d) => d.code === 'DEP-01').id);
    const was = stockOf(before, 'Paris', t.ean);
    await go(page, '#/transfers');
    await expect(page.locator('.tr-card')).toHaveCount(1);
    await page.getByRole('button', { name: 'Réceptionner' }).click();
    await expect(toastText(page)).toContainText(/reçu|Réception/i);
    const after = await db(page);
    expect(stockOf(after, 'Paris', t.ean)).toBe(was + t.qty);
    expect(after.transfers[t.id].status).toBe('done');
    const badge = Number(await page.locator('#orders-count').innerText().catch(() => '0')) || 0;
    expect(badge).toBe(Object.values(after.orders).filter((o) => o.depotId === t.toDepotId && o.status === 'shipped').length, 'pastille : livraisons restant à réceptionner');
  });

  test('journal : filtres par type et recherche, onglet audit réservé aux responsables', async ({ page }) => {
    await go(page, '#/journal');
    await expect(page.locator('#journal-list .row').first()).toBeVisible();
    await page.getByRole('button', { name: 'Sorties' }).click();
    for (const m of await page.locator('#journal-list .row__sub').allInnerTexts()) expect(m).toMatch(/Sortie/);
    await page.locator('[data-input="journal.search"]').fill('zzzzzz');
    await expect(page.locator('#journal-list')).toContainText('Aucun mouvement');
    await page.getByRole('button', { name: 'Audit' }).click();
    await page.locator('[data-input="journal.search"]').fill('');
    await expect(page.locator('#journal-list .row').first()).toBeVisible();
  });

  test('tableau de bord : changement de période', async ({ page }) => {
    await go(page, '#/dashboard');
    await expect(page.getByRole('button', { name: '30 jours' })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: '7 jours' }).click();
    await expect(page.getByRole('button', { name: '7 jours' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#view')).toContainText('Entrées 7 j');
    await expect(page.locator('.chart')).toBeVisible();
  });
});

test('réassort : pièce sous le seuil sans commande en cours → quantité suggérée', async ({ page }) => {
  await loginDemo(page, { ...SOPHIE, mutate(d) {
    const paris = Object.values(d.depots).find((x) => x.code === 'DEP-01').id;
    const busy = new Set(Object.values(d.orders).filter((o) => o.depotId === paris && ['draft', 'submitted', 'picking', 'shipped'].includes(o.status)).flatMap((o) => o.lines.map((l) => l.ean)));
    const a = Object.values(d.articles).find((x) => !busy.has(x.ean) && x.threshold > 0);
    d.stocks[paris][a.ean] = 0;
  } });
  await go(page, '#/reorder');
  await expect(page.locator('#view .row').first()).toBeVisible();
  await expect(page.locator('#view .row__qty').first()).toHaveText(/^\+\d+/);
});
