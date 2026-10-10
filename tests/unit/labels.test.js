import test from 'node:test';
import assert from 'node:assert/strict';
import { LABEL_FORMATS, PRINTER_TYPES, normalizePrinter, sheetPages, expandCopies, toZpl, zplText } from '../../js/lib/labels.js';

const art = (i) => ({ kind: 'article', ean: '3700089690011', name: `Pièce ${i}`, ref: 'REF-1', loc: 'R1-A1' });

test('formats : chaque type d\'imprimante pointe vers des formats existants et cohérents', () => {
  for (const t of Object.values(PRINTER_TYPES)) for (const f of t.formats) assert.ok(LABEL_FORMATS[f], f);
  for (const [k, f] of Object.entries(LABEL_FORMATS)) {
    if (f.kind !== 'sheet') continue;
    assert.ok(f.left + f.cols * f.w + (f.cols - 1) * f.gapX <= 210.01, `${k} : trop large pour A4`);
    assert.ok(f.top + f.rows * f.h + (f.rows - 1) * f.gapY <= 297.01, `${k} : trop haut pour A4`);
  }
});

test('profil d\'impression : valeurs absurdes ramenées à des valeurs sûres', () => {
  assert.deepEqual(normalizePrinter(null), { type: 'office', format: 'a4-3x8', dpi: 203, output: 'print', offsetX: 0, offsetY: 0 });
  assert.deepEqual(normalizePrinter({ type: 'thermal', format: 'a4-3x8', dpi: 999, output: 'zpl', offsetX: 50 }), { type: 'thermal', format: 'roll-50x25', dpi: 203, output: 'zpl', offsetX: 10, offsetY: 0 });
  assert.equal(normalizePrinter({ type: 'office', output: 'zpl' }).output, 'print', 'ZPL réservé aux thermiques');
});

test('planche A4 : positions, pages, cases déjà utilisées', () => {
  const pages = sheetPages(Array.from({ length: 30 }, (_, i) => art(i)), 'a4-3x8');
  assert.equal(pages.length, 2);
  assert.equal(pages[0].cells.length, 24);
  assert.deepEqual([pages[0].cells[1].x, pages[0].cells[3].y], [70, 37.125]);
  const skipped = sheetPages([art(1), art(2)], 'a4-3x8', { skip: 23 });
  assert.equal(skipped.length, 2, 'dernière case de la planche entamée, puis nouvelle planche');
  assert.deepEqual([skipped[0].cells[0].x, skipped[0].cells[0].y], [140, 7 * 37.125]);
  assert.deepEqual([skipped[1].cells[0].x, skipped[1].cells[0].y], [0, 0]);
  const off = sheetPages([art(1)], 'a4-3x7', { offsetX: 1, offsetY: -1 });
  assert.deepEqual([off[0].cells[0].x, off[0].cells[0].y], [8.25, 14.15], 'calibrage appliqué');
  assert.throws(() => sheetPages([], 'roll-50x25'), /planche/);
});

test('copies : développées et plafonnées', () => {
  assert.equal(expandCopies([{ item: 1, copies: 3 }, { item: 2, copies: '2' }, { item: 3, copies: -1 }]).length, 5);
  assert.equal(expandCopies([{ item: 1, copies: 1e9 }]).length, 500);
});

test('ZPL : structure, code-barres EAN-13, QR d\'emplacement, quantité, champs neutralisés', () => {
  const z = toZpl([{ item: art(1), copies: 3 }, { item: { kind: 'location', code: 'R1-A2-E3', desc: 'Zips', payload: 'MODE-LOC:R1-A2-E3' }, copies: 1 }, { item: art(2), copies: 0 }], { format: 'roll-50x25', dpi: 203 });
  const blocks = z.split('^XZ').filter((b) => b.trim());
  assert.equal(blocks.length, 2, 'une étiquette à 0 exemplaire n\'est pas émise');
  assert.match(blocks[0], /\^XA\n\^CI28\n\^PW400\n\^LL200/);
  assert.match(blocks[0], /\^BEN,\d+,Y,N\^FD370008969001\^FS/, 'EAN-13 : 12 chiffres, clé calculée par l\'imprimante');
  assert.match(blocks[0], /\^PQ3,0,1,Y/);
  assert.match(blocks[1], /\^BQN,2,\d+\^FDMA,MODE-LOC:R1-A2-E3\^FS/);
  assert.match(toZpl([{ item: { ...art(1), ean: '20000017' }, copies: 1 }]), /\^B8N/);
  assert.match(toZpl([{ item: { ...art(1), ean: '12345678901' }, copies: 1 }]), /\^BCN/, 'autres longueurs : Code 128');
  assert.match(toZpl([{ item: art(1), copies: 1 }], { dpi: 300 }), /\^PW591/);
  assert.equal(zplText('a^XZ~JA\\b\nc'), 'a XZ JA b c', 'aucune injection de commande');
  const evil = toZpl([{ item: { ...art(1), name: 'x^XZ^XA^FDpirate' }, copies: 1 }]);
  assert.equal((evil.match(/\^XA/g) || []).length, 1);
  assert.throws(() => toZpl([], { format: 'a4-3x8' }), /rouleau/);
});
