import test from 'node:test';
import assert from 'node:assert/strict';
import { detectSeparator, parseRecords, parse, stringify, safeCell, normHeader } from '../../js/lib/csv.js';

test('détection du séparateur', () => {
  assert.equal(detectSeparator('a;b;c\n1;2;3'), ';');
  assert.equal(detectSeparator('a,b,c\n1,2,3'), ',');
  assert.equal(detectSeparator('a\tb\tc'), '\t');
  assert.equal(detectSeparator('"a;b",c,d'), ',');
  assert.equal(detectSeparator('seul'), ';');
  assert.equal(detectSeparator('﻿a;b'), ';');
});

test('guillemets, guillemets échappés, retour ligne dans un champ', () => {
  const r = parseRecords('a;b\n"x;y";"dit ""oui"""\n"ligne1\nligne2";z', ';');
  assert.deepEqual(r, [['a', 'b'], ['x;y', 'dit "oui"'], ['ligne1\nligne2', 'z']]);
});

test('CRLF, CR seul, BOM, lignes vides, dernière ligne sans saut', () => {
  assert.deepEqual(parseRecords('﻿a;b\r\n1;2\r\n\r\n3;4', ';'), [['a', 'b'], ['1', '2'], ['3', '4']]);
  assert.deepEqual(parseRecords('a;b\r1;2', ';'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseRecords('', ';'), []);
  assert.deepEqual(parseRecords('\n\n', ';'), []);
});

test('champ vide entre séparateurs et espaces rognés', () => {
  assert.deepEqual(parseRecords(' a ; ;c', ';'), [['a', '', 'c']]);
});

test('parse : en-têtes normalisés (accents, casse, ponctuation) et numéros de ligne', () => {
  const { headers, rows } = parse('EAN13;Désignation;Prix (€)\n3700089690011;Zip;2,5\n\n3700089690012;Bouton;1');
  assert.deepEqual(headers, ['ean13', 'designation', 'prix']);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].designation, 'Zip');
  assert.equal(rows[0]._line, 2);
  assert.equal(rows[1]._line, 4);
  assert.equal(normHeader('Référence '), 'reference');
});

test('parse : ligne plus courte → champs manquants vides, jamais undefined', () => {
  const { rows } = parse('a;b;c\n1');
  assert.equal(rows[0].b, '');
  assert.equal(rows[0].c, '');
});

test('safeCell neutralise l\'injection de formules mais pas les nombres négatifs', () => {
  assert.equal(safeCell('=SUM(A1:A9)'), "'=SUM(A1:A9)");
  assert.equal(safeCell('+33 1 23'), "'+33 1 23");
  assert.equal(safeCell('@cmd'), "'@cmd");
  assert.equal(safeCell('-1'), '-1');
  assert.equal(safeCell('-2,5'), '-2,5');
  assert.equal(safeCell('Zip YKK'), 'Zip YKK');
  assert.equal(safeCell(null), '');
});

test('stringify : séparateur, quotage, BOM, CRLF, aller-retour avec parse', () => {
  const cols = [{ key: 'ean', label: 'EAN' }, { key: 'name', label: 'Désignation' }, { key: 'qty', label: 'Qté', get: (r) => r.q }];
  const rows = [{ ean: '123', name: 'Zip; "or"', q: 4 }, { ean: '456', name: '=HYPERLINK("x")', q: -2 }];
  const out = stringify(rows, cols);
  assert.ok(out.startsWith('﻿'));
  assert.ok(out.endsWith('\r\n'));
  const back = parse(out);
  assert.equal(back.rows[0].designation, 'Zip; "or"');
  assert.equal(back.rows[1].designation, `'=HYPERLINK("x")`);
  assert.equal(back.rows[1].qte, '-2');
  assert.equal(stringify([], cols, { bom: false }), 'EAN;Désignation;Qté\r\n');
});
