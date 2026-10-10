import test from 'node:test';
import assert from 'node:assert/strict';
import { esc, html, raw, SafeHtml, fold, matches, toInt, intIn, toMoney, fmtRelative, fmtInt, initials, plural, clamp } from '../../js/lib/text.js';

test('esc échappe & < > " \' et `', () => {
  assert.equal(esc(`<img src="x" onerror='a'>&\``), '&lt;img src=&quot;x&quot; onerror=&#39;a&#39;&gt;&amp;&#96;');
  assert.equal(esc(null), '');
  assert.equal(esc(undefined), '');
  assert.equal(esc(0), '0');
});

test('html`` échappe toute valeur interpolée', () => {
  const evil = '<script>alert(1)</script>';
  assert.equal(html`<b>${evil}</b>`.value, '<b>&lt;script&gt;alert(1)&lt;/script&gt;</b>');
  assert.equal(html`<a title="${'" onmouseover="x'}">`.value, '<a title="&quot; onmouseover=&quot;x">');
});

test('html`` : imbrication sans double échappement, tableaux, valeurs ignorées', () => {
  const inner = html`<i>${'a&b'}</i>`;
  assert.equal(html`<p>${inner}</p>`.value, '<p><i>a&amp;b</i></p>');
  assert.equal(html`${['<', html`<br>`, 'x']}`.value, '&lt;<br>x');
  assert.equal(html`[${false}${null}${undefined}${true}]`.value, '[]');
  assert.equal(html`${0}`.value, '0');
});

test('raw() produit un SafeHtml ; une simple chaîne n\'en est pas un', () => {
  assert.ok(raw('<b>') instanceof SafeHtml);
  assert.ok(!(('<b>') instanceof SafeHtml));
  assert.equal(html`${raw('<b>')}`.value, '<b>');
});

test('fold : insensible à la casse, aux accents, œ/æ', () => {
  assert.equal(fold('Bandoulière CUIR'), 'bandouliere cuir');
  assert.equal(fold('Œillet pression – Or'), 'oeillet pression – or');
  assert.equal(fold(null), '');
});

test('matches : tous les mots, dans n\'importe quel ordre', () => {
  assert.ok(matches('bandouliere cuir', 'Bandoulière cuir naturel 120cm', 'BND-CN-120'));
  assert.ok(matches('cuir band', 'Bandoulière cuir naturel'));
  assert.ok(!matches('cuir zip', 'Bandoulière cuir naturel'));
  assert.ok(matches('', 'x'));
  assert.ok(matches('   ', 'x'));
  assert.ok(matches('bnd-cn', 'Bandoulière', 'BND-CN-120'));
});

test('toInt strict', () => {
  assert.equal(toInt('3'), 3);
  assert.equal(toInt(' 12 '), 12);
  assert.equal(toInt('-5'), -5);
  assert.equal(toInt(7), 7);
  for (const bad of ['3.5', '1e3', '', ' ', 'abc', null, undefined, NaN, 2.5, '0x10', '12abc']) {
    assert.ok(Number.isNaN(toInt(bad)), `devrait refuser ${JSON.stringify(bad)}`);
  }
});

test('intIn : bornes et repli', () => {
  assert.equal(intIn('5', 1, 10), 5);
  assert.ok(Number.isNaN(intIn('0', 1, 10)));
  assert.equal(intIn('11', 1, 10, 1), 1);
  assert.equal(intIn('x', 1, 10, 3), 3);
});

test('toMoney : virgule française, refuse négatif et texte', () => {
  assert.equal(toMoney('2,5'), 2.5);
  assert.equal(toMoney('1 234,56'), 1234.56);
  assert.equal(toMoney('3.999'), 4);
  assert.ok(Number.isNaN(toMoney('-1')));
  assert.ok(Number.isNaN(toMoney('12€')));
  assert.ok(Number.isNaN(toMoney('')));
});

test('fmtRelative', () => {
  const now = new Date('2026-10-10T12:00:00Z');
  assert.equal(fmtRelative(new Date(now - 10_000), now), "à l'instant");
  assert.equal(fmtRelative(new Date(now - 5 * 60_000), now), 'il y a 5 min');
  assert.equal(fmtRelative(new Date(now - 3 * 3600_000), now), 'il y a 3 h');
  assert.equal(fmtRelative(new Date(now - 2 * 86400_000), now), 'il y a 2 j');
  assert.match(fmtRelative(new Date(now - 30 * 86400_000), now), /^\d{2}\/\d{2}\/\d{2}$/);
  assert.equal(fmtRelative('pas une date', now), '—');
});

test('formats et petits utilitaires', () => {
  assert.match(fmtInt(1045), /^1\s?045$/);
  assert.equal(fmtInt(1045), '1\u00a0045', 'espace insécable visible dans toutes les polices');
  assert.equal(initials('Sophie Martin'), 'SM');
  assert.equal(initials('  '), '?');
  assert.equal(initials('cher'), 'C');
  assert.match(plural(2, 'article'), /^2 articles$/);
  assert.match(plural(1, 'article'), /^1 article$/);
  assert.equal(clamp(5, 0, 3), 3);
});
