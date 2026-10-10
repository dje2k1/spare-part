// Contrôles statiques du code source : hygiène (imports inutilisés) et sécurité (XSS, CSP).
// Ils échouent dès qu'une règle d'équipe est enfreinte — avant même d'ouvrir un navigateur.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const jsFiles = walk(join(root, 'js')).filter((f) => f.endsWith('.js'));
const serverFiles = readdirSync(join(root, 'server')).filter((n) => n.endsWith('.js')).map((n) => join(root, 'server', n));
const rel = (f) => relative(root, f);
const src = (f) => readFileSync(f, 'utf8');
const esc = (n) => n.replace(/[$]/g, '\\$&');
/** Nombre d'occurrences d'un identifiant (bornes correctes y compris pour `$`). */
const count = (text, name) => text.split(new RegExp(`(?<![\\w$])${esc(name)}(?![\\w$])`)).length - 1;
const code = (s) => s;

test('syntaxe valide de tous les modules (application et serveur), sans navigateur', () => {
  const bad = [];
  for (const f of [...jsFiles, ...serverFiles, join(root, 'sw.js')]) {
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    if (r.status !== 0) bad.push(`${rel(f)} : ${r.stderr.split('\n').find((l) => /Error/.test(l)) ?? r.stderr}`);
  }
  assert.deepEqual(bad, []);
});

test('aucun import inutilisé', () => {
  const bad = [];
  for (const f of jsFiles) {
    const text = code(src(f));
    for (const m of text.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"][^'"]+['"]/g)) {
      for (const raw of m[1].split(',')) {
        const name = raw.trim().split(/\s+as\s+/).pop().trim();
        if (!name) continue;
        if (count(text, name) < 2) bad.push(`${rel(f)} : « ${name} » importé mais jamais utilisé`);
      }
    }
    for (const m of text.matchAll(/import\s+(\w+)\s+from/g)) {
      if (count(text, m[1]) < 2) bad.push(`${rel(f)} : import par défaut « ${m[1]} » inutilisé`);
    }
  }
  assert.deepEqual(bad, []);
});

test('aucun export de simple ré-export d\'imports (réflexe de masquage d\'imports inutiles)', () => {
  const bad = [];
  for (const f of jsFiles) {
    const text = code(src(f));
    const imported = new Set([...text.matchAll(/import\s*\{([^}]+)\}/g)].flatMap((m) => m[1].split(',').map((s) => s.trim().split(/\s+as\s+/).pop())));
    for (const m of text.matchAll(/^export\s*\{([^}]+)\}\s*;?\s*$/gm)) {
      const names = m[1].split(',').map((s) => s.trim());
      if (names.some((n) => imported.has(n))) bad.push(`${rel(f)} : export { ${names.join(', ')} } ré-exporte des imports`);
    }
  }
  // Ré-exports volontaires (façades) : liste blanche explicite
  const allowed = new Set(['js/ui/dom.js : export { html, raw } ré-exporte des imports']);
  assert.deepEqual(bad.filter((b) => !allowed.has(b)), []);
});

test('aucun gestionnaire en ligne ni style en ligne dans les gabarits JS', () => {
  const bad = [];
  for (const f of jsFiles) {
    const text = src(f);
    if (/\bon(click|input|change|submit|keydown|keyup|load|error)\s*=\s*["'`]/.test(text)) bad.push(`${rel(f)} : gestionnaire en ligne`);
    // Seules les variables CSS (--w, --h…) sont tolérées : elles portent une donnée, pas de la mise en forme.
    for (const m of text.matchAll(/style="([^"]*)"/g)) if (!/^(--[a-z-]+:[^;"]*;?)+$/.test(m[1]) && !/^\$\{cssVars\(/.test(m[1])) bad.push(`${rel(f)} : style en ligne « ${m[1].slice(0, 40)} » (utiliser une classe)`);
  }
  assert.deepEqual(bad, []);
});

test('index.html : aucun script/style/gestionnaire en ligne, CSP présente', () => {
  const html = src(join(root, 'index.html'));
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'script en ligne');
  assert.ok(!/\son[a-z]+\s*=/i.test(html.replace(/<!--[\s\S]*?-->/g, '')), 'gestionnaire en ligne');
  assert.ok(!/<style[\s>]/i.test(html), 'balise <style>');
  const csp = /Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1] ?? '';
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'self'(;|$)/, 'script-src doit être \'self\' seul (pas d\'unsafe-inline/eval)');
  assert.ok(!/unsafe-eval|script-src[^;]*unsafe-inline/.test(csp));
  assert.match(csp, /connect-src 'self' https:\/\/api\.anthropic\.com/);
  assert.ok(!/https?:\/\/(?!api\.anthropic\.com)[^"'\s]+\.(js|css|woff2?)/i.test(html), 'ressource tierce');
});

test('aucune interpolation d\'attribut non quotée dans les gabarits html``', () => {
  const bad = [];
  for (const f of jsFiles) {
    for (const m of src(f).matchAll(/\s[a-z-]+=\$\{/g)) bad.push(`${rel(f)} : attribut non quoté « ${m[0].trim()} »`);
  }
  assert.deepEqual(bad, []);
});

test('attributs ARIA d\'état : html`` ignore les booléens, il faut String(…)', () => {
  const bad = [];
  for (const f of jsFiles) {
    for (const m of src(f).matchAll(/aria-(pressed|selected|checked|expanded|current|busy)="\$\{(?!String\()([^}]*)\}"/g)) bad.push(`${rel(f)} : aria-${m[1]}="\${${m[2]}}" rendrait un attribut vide`);
  }
  assert.deepEqual(bad, []);
});

test('accessibilité : pas d\'aria-label sur un <span> sans rôle (attribut interdit, ignoré par les lecteurs d\'écran)', () => {
  const bad = [];
  for (const f of jsFiles) for (const m of src(f).matchAll(/<span(?![^>]*\srole=)[^>]*\saria-label=/g)) bad.push(`${rel(f)} : ${m[0].slice(0, 60)}`);
  assert.deepEqual(bad, []);
});

test('innerHTML : uniquement via setHtml (SafeHtml), jamais avec une chaîne', () => {
  const bad = [];
  for (const f of jsFiles) {
    const text = code(src(f));
    for (const m of text.matchAll(/\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML\s*\(|document\.write\s*\(/g)) {
      if (rel(f) !== 'js/ui/dom.js') bad.push(`${rel(f)} : ${m[0]}`);
    }
    if (/\beval\s*\(|new Function\s*\(/.test(text)) bad.push(`${rel(f)} : eval/new Function`);
  }
  assert.deepEqual(bad, []);
});

test('toute action data-action utilisée dans les gabarits est enregistrée', () => {
  const used = new Set(), defined = new Set();
  for (const f of jsFiles) {
    const text = src(f);
    for (const m of text.matchAll(/data-(?:action|input|change|submit|enter)="([a-z.]+)"/g)) used.add(m[1]);
    for (const m of text.matchAll(/^\s+(?:async\s+)?['"]([a-z]+\.[a-z.]+)['"]\s*[:(]/gm)) defined.add(m[1]);
  }
  const missing = [...used].filter((u) => !defined.has(u));
  assert.deepEqual(missing, [], `actions utilisées mais non définies : ${missing}`);
});
