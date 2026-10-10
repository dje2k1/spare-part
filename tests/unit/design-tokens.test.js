// Jetons de design : contrastes WCAG 2.1 AA vérifiés par le calcul, thèmes clair et sombre cohérents.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../css/tokens.css'), 'utf8');

const block = (re) => {
  const m = re.exec(css);
  assert.ok(m, `bloc introuvable : ${re}`);
  return Object.fromEntries([...m[1].matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\b/g)].map((x) => [x[1], x[2].toLowerCase()]));
};
const light = block(/:root\s*\{([\s\S]*?)\n\}/);
const darkAuto = block(/prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme='light'\]\)\s*\{([\s\S]*?)\n  \}/);
const darkForced = block(/:root\[data-theme='dark'\]\s*\{([\s\S]*?)\n\}/);

const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

// [premier plan, arrière-plan, minimum] : 4,5 pour le texte, 3 pour les éléments d'interface
const TEXT = 4.5, UI = 3;
const PAIRS = [
  ['ink', 'bg', TEXT], ['ink-2', 'bg', TEXT], ['ink-3', 'bg', TEXT], ['ink-3', 'bg-soft', TEXT], ['ink-3', 'bg-sunken', TEXT], ['ink-3', 'surface', TEXT],
  ['on-ink', 'ink', TEXT], ['gold-ink', 'bg', TEXT], ['gold-ink', 'gold-bg', TEXT],
  ['red', 'bg', TEXT], ['red', 'red-bg', TEXT], ['green', 'bg', TEXT], ['green', 'green-bg', TEXT],
  ['amber', 'bg', TEXT], ['amber', 'amber-bg', TEXT], ['blue', 'bg', TEXT], ['blue', 'blue-bg', TEXT],
  ['control', 'bg', UI], ['control', 'surface', UI], ['gold', 'bg', UI],
];

for (const [name, tokens] of [['clair', light], ['sombre', darkAuto]]) {
  test(`contrastes AA — thème ${name}`, () => {
    const t = name === 'sombre' ? { ...light, ...tokens } : tokens;
    const fails = PAIRS.map(([fg, bg, min]) => ({ fg, bg, min, r: ratio(t[fg], t[bg]) })).filter((p) => p.r < p.min).map((p) => `${p.fg} sur ${p.bg} : ${p.r.toFixed(2)} < ${p.min}`);
    assert.deepEqual(fails, []);
  });
}

test('thème sombre : le mode automatique et le mode forcé portent exactement les mêmes valeurs', () => {
  assert.ok(Object.keys(darkAuto).length >= 20, 'jetons sombres introuvables');
  assert.deepEqual(darkForced, darkAuto);
});

test('chaque jeton de couleur du thème clair a son équivalent sombre', () => {
  assert.deepEqual(Object.keys(darkAuto).sort(), Object.keys(light).sort());
});

// ── Familles de teintes (en-têtes, tuiles, icônes) et monogrammes ──
const famBlock = /\nhtml\s*\{([\s\S]*?)\n\}/.exec(css);
const fams = famBlock ? Object.fromEntries([...famBlock[1].matchAll(/--([a-z]+)-(1|2|3|ink):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [`${m[1]}-${m[2]}`, m[3].toLowerCase()])) : {};
const famNames = [...new Set(Object.keys(fams).map((k) => k.split('-')[0]))];
const mix = (a, b, t) => '#' + [1, 3, 5].map((i) => Math.round(parseInt(a.slice(i, i + 2), 16) * t + parseInt(b.slice(i, i + 2), 16) * (1 - t)).toString(16).padStart(2, '0')).join('');

test('familles : texte blanc lisible sur tout le dégradé (profond → vif)', () => {
  assert.ok(famNames.length >= 8, 'familles introuvables');
  const fails = [];
  for (const f of famNames) for (const k of ['1', '2']) { const r = ratio('#ffffff', fams[`${f}-${k}`]); if (r < TEXT) fails.push(`blanc sur ${f}-${k} : ${r.toFixed(2)}`); }
  assert.deepEqual(fails, []);
});

test('familles : texte d\'accent lisible en clair (fond, surface, teinte douce) et en sombre (lumière)', () => {
  const fails = [];
  for (const f of famNames) {
    const ink = fams[`${f}-ink`], vivid = fams[`${f}-2`], glow = fams[`${f}-3`];
    for (const bg of [light.bg, light.surface, light['bg-soft'], mix(vivid, light.surface, 0.11)]) { const r = ratio(ink, bg); if (r < TEXT) fails.push(`${f}-ink sur ${bg} : ${r.toFixed(2)}`); }
    for (const bg of [darkAuto.bg, darkAuto.surface, mix(glow, darkAuto.surface, 0.13)]) { const r = ratio(glow, bg); if (r < TEXT) fails.push(`${f}-3 sur ${bg} (sombre) : ${r.toFixed(2)}`); }
  }
  assert.deepEqual(fails, []);
});

test('monogrammes et avatars : initiales blanches lisibles sur les 10 teintes', () => {
  const hues = [...css.matchAll(/\.hue-\d\s*\{\s*--h1:\s*(#[0-9a-fA-F]{6});\s*--h2:\s*(#[0-9a-fA-F]{6});/g)];
  assert.equal(hues.length, 10);
  const fails = hues.flatMap(([, a, b]) => [a, b].filter((c) => ratio('#ffffff', c) < TEXT).map((c) => `blanc sur ${c}`));
  assert.deepEqual(fails, []);
});
