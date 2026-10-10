// Analyse par photo : API Anthropic simulée (aucune clé réelle, aucun appel réseau sortant).
import { test, expect, loginDemo, db, go, toastText } from './helpers.js';

const KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';
// PNG 1×1 valide
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };

const reply = (obj) => ({ id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(obj) }], usage: { input_tokens: 1, output_tokens: 1 } });

async function mockApi(page, handler) {
  const calls = [];
  await page.route('https://api.anthropic.com/**', async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    calls.push({ headers: req.headers(), body: JSON.parse(req.postData() ?? '{}') });
    const { status = 200, json } = handler(calls.length);
    return route.fulfill({ status, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(json) });
  });
  return calls;
}

test.use({ expectedHttpErrors: [/api\.anthropic\.com/] }); // statuts d'erreur simulés volontairement

test.describe('analyse photo', () => {
  test.beforeEach(async ({ page }) => { await loginDemo(page, { name: 'Sophie Martin', pin: '2345', depot: 'Paris' }); });

  test('sans clé : explication de la confidentialité, clé invalide refusée, clé valide enregistrée', async ({ page }) => {
    await go(page, '#/photo');
    await expect(page.locator('#photo-body')).toContainText('uniquement sur cet appareil');
    await page.locator('[name=key]').fill('pas-une-cle');
    await page.getByRole('button', { name: 'Enregistrer la clé' }).click();
    await expect(page.locator('#photo-body [data-err]')).not.toBeEmpty();
    await page.locator('[name=key]').fill(KEY);
    await page.getByRole('button', { name: 'Enregistrer la clé' }).click();
    await expect(page.locator('.photo-drop')).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('mode_anthropic_api_key'))).toBe(KEY);
  });

  test('analyse réussie : suggestions, sélection, import avec codes internes (EAN du modèle ignorés)', async ({ page }) => {
    const calls = await mockApi(page, () => ({ json: reply({
      product_name: 'Sac cabas cuir', product_description: 'Grand sac', product_category: 'Maroquinerie', confidence: 'high',
      spare_parts: [
        { id: 'a', name: 'Anse cuir 60cm', family: 'Anses', description: 'Anse de rechange', typical_ean: '3700000000017', typical_threshold: 8, priority: 'high' },
        { id: 'b', name: 'Fermoir magnétique', family: 'Fermoirs', description: 'Fermoir', typical_threshold: 5, priority: 'medium' },
        { id: 'c', name: '<img src=x onerror=window.__xss=1>', family: 'Test', description: '', priority: 'low' },
      ] }) }));
    await page.evaluate((k) => localStorage.setItem('mode_anthropic_api_key', k), KEY);
    await go(page, '#/photo');
    await page.locator('#photo-file').setInputFiles({ name: 'sac.png', mimeType: 'image/png', buffer: PNG });
    await page.getByRole('button', { name: 'Analyser le produit' }).click();
    await expect(page.locator('#photo-body')).toContainText('Sac cabas cuir');
    expect(calls).toHaveLength(1);
    expect(calls[0].headers['x-api-key']).toBe(KEY);
    expect(calls[0].headers['anthropic-dangerous-direct-browser-access']).toBe('true');
    expect(calls[0].body.model).toBe('claude-sonnet-5-5');
    expect(calls[0].body.messages[0].content[0].source.media_type).toBe('image/jpeg'); // recompressée localement
    // les pièces « essentielles » sont présélectionnées ; on ajoute le fermoir
    await expect(page.locator('input[data-change="photo.toggle"]:checked')).toHaveCount(1);
    await page.locator('input[data-change="photo.toggle"]').nth(1).check();
    await page.getByRole('button', { name: /Importer 2 pièces/ }).click();
    await expect(page).toHaveURL(/#\/articles/);
    const articles = Object.values((await db(page)).articles);
    const anse = articles.find((a) => a.name === 'Anse cuir 60cm');
    expect(anse.ean).toMatch(/^200\d{10}$/); // le EAN « 3700000000017 » proposé par le modèle n'est pas repris
    expect(articles.some((a) => a.name === 'Fermoir magnétique')).toBe(true);
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  });

  test('clé révoquée (401) : effacée ; panne réseau : conservée', async ({ page }) => {
    let mode = 401;
    await mockApi(page, () => (mode === 401 ? { status: 401, json: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } } : { status: 529, json: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } }));
    await page.evaluate((k) => localStorage.setItem('mode_anthropic_api_key', k), KEY);
    await go(page, '#/photo');
    await page.locator('#photo-file').setInputFiles({ name: 'a.png', mimeType: 'image/png', buffer: PNG });
    await page.getByRole('button', { name: 'Analyser le produit' }).click();
    await expect(page.locator('#photo-body')).toContainText('invalide ou révoquée');
    expect(await page.evaluate(() => localStorage.getItem('mode_anthropic_api_key'))).toBeNull();

    mode = 529;
    await page.evaluate((k) => localStorage.setItem('mode_anthropic_api_key', k), KEY);
    await go(page, '#/home');
    await go(page, '#/photo');
    await page.locator('#photo-file').setInputFiles({ name: 'a.png', mimeType: 'image/png', buffer: PNG });
    await page.getByRole('button', { name: 'Analyser le produit' }).click();
    await expect(page.locator('#photo-body')).toContainText('surchargé');
    expect(await page.evaluate(() => localStorage.getItem('mode_anthropic_api_key'))).toBe(KEY);
    void toastText;
  });
});
