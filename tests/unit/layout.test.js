// Mise en page : règles CSS dont dépend le comportement sur iPhone (WebKit), que les tests sous Chromium ne
// peuvent pas révéler. Chaque règle est vérifiée dans le texte de la feuille de style.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../css/components.css'), 'utf8');
const rule = (selector) => {
  const m = new RegExp(`(?:^|\\n)${selector.replace(/[.[\]]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(css);
  assert.ok(m, `règle introuvable : ${selector}`);
  return m[1];
};

test('feuille : le corps prend la hauteur de son contenu (flex-basis auto, jamais 0 %)', () => {
  // Sans hauteur fixe, WebKit applique `flex: 1` (base 0 %) à la lettre : le corps s'écrase à son rembourrage et la
  // feuille reste coincée en bas de l'écran (en-tête seul visible). Chromium, lui, part du contenu.
  const body = rule('.sheet__body');
  assert.match(body, /flex:\s*1 1 auto/);
  assert.match(body, /min-height:\s*0/);
  assert.match(rule('.sheet'), /max-height:\s*92dvh/);
});

test('feuille : la poignée et l\'en-tête captent le geste (pas de défilement de la page sous le doigt)', () => {
  assert.match(rule('.sheet__grab'), /touch-action:\s*none/);
  assert.match(rule('.sheet__head'), /touch-action:\s*none/);
  assert.match(rule('.sheet'), /translateY\(var\(--drag\)\)/);
});
