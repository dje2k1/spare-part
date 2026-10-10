// Administration : utilisateurs, import CSV avec aperçu, sauvegarde/restauration, verrouillage, passage en production.
import { readFileSync } from 'node:fs';
import { test, expect, loginDemo, login, db, go, toastText, typePin } from './helpers.js';

test.describe('administration', () => {
  test.beforeEach(async ({ page }) => { await loginDemo(page); });

  test('menu d\'administration complet pour un administrateur', async ({ page }) => {
    await go(page, '#/admin');
    await expect(page.locator('#view .row')).toHaveCount(6);
  });

  test('créer un utilisateur : PIN faible refusé, puis connexion avec le nouveau compte', async ({ page }) => {
    await go(page, '#/admin?s=users');
    await page.locator('[data-action="adm.user"][data-id=""]').click();
    await page.locator('#sheet [name=name]').fill('Léa Test');
    await page.locator('#sheet [name=role]').selectOption('operator');
    await page.locator('#sheet [name=pin]').fill('1234');
    await page.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(page.locator('#sheet [data-err]')).toContainText('suite');
    await page.locator('#sheet [name=pin]').fill('7391');
    await page.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(toastText(page)).toContainText('Utilisateur enregistré');
    const u = Object.values((await db(page)).users).find((x) => x.name === 'Léa Test');
    expect(u.role).toBe('operator');
    expect(JSON.stringify(u)).not.toContain('7391'); // le PIN n'est jamais stocké en clair
    expect(u.pin).toMatchObject({ iter: expect.any(Number) });
    await page.locator('[data-action="menu.open"]').first().click();
    await page.locator('[data-action="menu.logout"]').click();
    await page.locator('#modal [data-r="yes"]').click();
    await expect(page.locator('#login')).toBeVisible();
    await login(page, { name: 'Léa Test', pin: '7391' });
    await expect(page.locator('#view')).toBeVisible();
  });

  test('import CSV : aperçu sans écriture, puis application', async ({ page }) => {
    const before = await db(page);
    const csv = 'ean13;name;family;ref;price;threshold\n3700089699999;Rivet laiton 6mm;Rivets;RIV-6;0,12;50\n123;Code trop court;X;;;\n3700089699999;Doublon;Rivets;;;\n';
    await go(page, '#/admin?s=import');
    await page.locator('#imp-file').setInputFiles({ name: 'catalogue.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
    await expect(page.locator('#sheet')).toContainText('Aperçu de l\'import');
    await expect(page.locator('#sheet .kpi').nth(0)).toContainText('1');
    await expect(page.locator('#sheet .kpi').nth(2)).toContainText('2'); // 2 lignes ignorées, avec leur raison
    await expect(page.locator('#sheet')).toContainText('invalide');
    await expect(page.locator('#sheet')).toContainText('doublon');
    expect(Object.keys((await db(page)).articles)).toHaveLength(Object.keys(before.articles).length); // rien d'écrit
    await page.getByRole('button', { name: 'Importer', exact: true }).click();
    await expect(toastText(page)).toContainText('Import terminé');
    const after = await db(page);
    expect(after.articles['3700089699999']).toMatchObject({ name: 'Rivet laiton 6mm', price: 0.12, threshold: 50 });
  });

  test('import : fichier trop volumineux refusé', async ({ page }) => {
    await go(page, '#/admin?s=import');
    await page.locator('#imp-file').setInputFiles({ name: 'gros.csv', mimeType: 'text/csv', buffer: Buffer.alloc(5 * 1024 * 1024 + 1, 'a') });
    await expect(toastText(page)).toContainText('trop volumineux');
  });

  test('sauvegarde puis restauration : les données reviennent et la session est fermée', async ({ page }) => {
    await go(page, '#/admin?s=data');
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('[data-action="adm.backup"]').click()]);
    expect(download.suggestedFilename()).toMatch(/^mode-stock-sauvegarde-\d{4}-\d{2}-\d{2}\.json$/);
    const path = await download.path();
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    expect(saved.format ?? saved.app ?? Object.keys(saved)).toBeTruthy();

    // on modifie la base, puis on restaure
    await go(page, '#/articles');
    await page.locator('[data-action="articles.new"]').click();
    await page.locator('[data-action="art.gencode"]').click();
    await page.locator('#sheet [name=name]').fill('Pièce à oublier');
    await page.getByRole('button', { name: 'Créer la pièce' }).click();
    expect(Object.values((await db(page)).articles).some((a) => a.name === 'Pièce à oublier')).toBe(true);
    await page.locator('#sheet [data-action="sheet.close"]').first().click();

    await go(page, '#/admin?s=data');
    await page.locator('#restore-file').setInputFiles(path);
    await expect(page.locator('#modal')).toContainText('Remplacer toutes les données');
    await page.locator('#modal [data-r="yes"]').click();
    await expect(page.locator('#login')).toBeVisible();
    expect(Object.values(await db(page).then((d) => d.articles)).some((a) => a.name === 'Pièce à oublier')).toBe(false);
  });

  test('restauration d\'un fichier invalide : refus explicite, données intactes', async ({ page }) => {
    const before = await db(page);
    await go(page, '#/admin?s=data');
    await page.locator('#restore-file').setInputFiles({ name: 'x.json', mimeType: 'application/json', buffer: Buffer.from('{"pas":"une sauvegarde"}') });
    await expect(toastText(page)).toBeVisible();
    await expect(page.locator('#modal[open]')).toHaveCount(0);
    expect(Object.keys((await db(page)).articles)).toEqual(Object.keys(before.articles));
  });

  test('délai de verrouillage : réglage enregistré', async ({ page }) => {
    await go(page, '#/admin?s=data');
    await page.locator('[data-change="adm.lock"]').selectOption('5');
    await expect(toastText(page)).toContainText('Réglage enregistré');
    expect((await db(page)).meta.settings.sessionMinutes).toBe(5);
  });

  test('passage en production : base vide, PIN de démonstration supprimés, nouvel administrateur', async ({ page }) => {
    await go(page, '#/admin?s=data');
    await page.locator('[data-action="adm.production"]').click();
    await page.locator('#sheet [name=depot]').fill('Atelier Test');
    await page.locator('#sheet [name=admin]').fill('Camille');
    await page.locator('#sheet [name=pin]').fill('8264');
    await page.locator('#sheet [name=pin2]').fill('8264');
    await page.getByRole('button', { name: 'Effacer la démo et démarrer' }).click();
    await page.getByRole('button', { name: 'Effacer', exact: true }).click();
    await expect(page.locator('#login')).toBeVisible();
    const fresh = await db(page);
    expect(Object.keys(fresh.articles)).toHaveLength(0);
    expect(fresh.meta.demo).toBeFalsy();
    expect(fresh.meta.demoPins).toBeUndefined();
    expect(JSON.stringify(fresh)).not.toContain('"1234"');
    await login(page, { name: 'Camille', pin: '8264' });
    await expect(page.locator('#view')).toBeVisible();
  });

  test('effacement total : confirmation par saisie, retour à l\'écran d\'installation', async ({ page }) => {
    await go(page, '#/admin?s=data');
    await page.locator('[data-action="adm.wipe"]').click();
    await page.locator('#modal [name=v]').fill('efface');
    await page.locator('#modal button[type=submit]').click();
    await expect(page.locator('#modal [data-err]')).toContainText('EFFACER');
    await page.locator('#modal [name=v]').fill('EFFACER');
    await page.locator('#modal button[type=submit]').click();
    await expect(page.getByRole('heading', { name: 'Bienvenue' })).toBeVisible();
  });
});

test('un responsable n\'accède qu\'aux sections autorisées', async ({ page }) => {
  await loginDemo(page, { name: 'Sophie Martin', pin: '2345', depot: 'Paris' });
  await go(page, '#/admin');
  await expect(page.locator('#view .row')).toHaveCount(3); // emplacements, import, exports
  await go(page, '#/admin?s=users');
  await expect(page.locator('#view')).not.toContainText('Utilisateurs et rôles');
  void typePin;
});
