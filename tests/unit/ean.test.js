import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isCode, checkDigit, hasValidCheck, internalEan, nextInternalEan, ean13Modules, ean13Svg,
  binarizeRow, runLengths, decodeEan13, decodeEan13Any,
} from '../../js/lib/ean.js';

test('isCode : 8 à 14 chiffres uniquement', () => {
  for (const ok of ['12345678', '3700089690011', '12345678901234']) assert.ok(isCode(ok), ok);
  for (const bad of ['1234567', '123456789012345', '12345678a', '', null, undefined, "1234'); alert(1);//", ' 12345678', '1234 5678']) {
    assert.ok(!isCode(bad), `devrait refuser ${JSON.stringify(bad)}`);
  }
});

test('clé GS1 : vecteurs de référence EAN-13 / EAN-8 / UPC-A / GTIN-14', () => {
  assert.equal(hasValidCheck('4006381333931'), true);
  assert.equal(hasValidCheck('5901234123457'), true);
  assert.equal(hasValidCheck('96385074'), true);
  assert.equal(hasValidCheck('036000291452'), true);
  assert.equal(hasValidCheck('10012345678902'), true);
  assert.equal(hasValidCheck('4006381333932'), false);
  assert.equal(hasValidCheck('12345679'), false);
  assert.equal(hasValidCheck('123456789'), null); // 9 chiffres : pas de clé GS1
  assert.equal(hasValidCheck('abc'), null);
  assert.equal(checkDigit('400638133393'), 1);
});

test('codes internes : préfixe 200, 13 chiffres, clé valide, incrément', () => {
  const a = internalEan(1);
  assert.match(a, /^200\d{10}$/);
  assert.equal(hasValidCheck(a), true);
  assert.equal(internalEan(1), a);
  assert.notEqual(internalEan(2), a);
  assert.equal(nextInternalEan([]), internalEan(1));
  assert.equal(nextInternalEan([internalEan(1), internalEan(7), '4006381333931']), internalEan(8));
  assert.equal(nextInternalEan([internalEan(5).slice(0, 12) + '0' /* clé fausse ? */]).length, 13);
});

test('EAN-13 : 95 modules, gardes, rejet des entrées invalides', () => {
  const m = ean13Modules('4006381333931');
  assert.equal(m.length, 95);
  assert.equal(m.slice(0, 3), '101');
  assert.equal(m.slice(45, 50), '01010');
  assert.equal(m.slice(-3), '101');
  assert.throws(() => ean13Modules('123'));
  assert.throws(() => ean13Modules('12345678901ab'));
});

test('ean13Svg : SVG autonome sans NaN', () => {
  const svg = ean13Svg('4006381333931').value;
  assert.match(svg, /^<svg[^>]+viewBox="0 0 \d+ 48"/);
  assert.ok(!svg.includes('NaN'));
  assert.match(svg, /aria-label="Code-barres 4006381333931"/);
});

/** Rend un EAN-13 en RGBA sur une ligne (module = px par module), marges blanches incluses. */
function rowFor(code, module = 3, quiet = 12) {
  const bits = '0'.repeat(quiet) + ean13Modules(code) + '0'.repeat(quiet);
  const px = [];
  for (const b of bits) for (let k = 0; k < module; k++) px.push(b === '1' ? 25 : 235);
  const rgba = new Uint8ClampedArray(px.length * 4);
  px.forEach((v, i) => { rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = v; rgba[i * 4 + 3] = 255; });
  return { rgba, width: px.length };
}

test('aller-retour : encodage → binarisation → décodage (plusieurs tailles de module)', () => {
  for (const code of ['4006381333931', '5901234123457', '3760170192806']) {
    if (!hasValidCheck(code)) continue;
    for (const module of [2, 3, 4, 6]) {
      const { rgba, width } = rowFor(code, module);
      assert.equal(decodeEan13(binarizeRow(rgba, width)), code, `${code} @${module}px`);
    }
  }
});

test('codes internes générés : décodables', () => {
  for (const n of [1, 42, 999]) {
    const code = internalEan(n);
    const { rgba, width } = rowFor(code, 3);
    assert.equal(decodeEan13(binarizeRow(rgba, width)), code);
  }
});

test('code présenté à l\'envers : decodeEan13Any le lit', () => {
  const { rgba, width } = rowFor('4006381333931', 3);
  const bits = [...binarizeRow(rgba, width)].reverse();
  assert.equal(decodeEan13(bits), null);
  assert.equal(decodeEan13Any(bits), '4006381333931');
});

/** PRNG déterministe (tests reproductibles). */
const prng = (seed) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

test('lecture malgré flou optique et bruit de capteur', () => {
  const rnd = prng(7);
  for (const module of [3, 4, 6]) {
    const { rgba, width } = rowFor('4006381333931', module);
    const blurred = new Uint8ClampedArray(rgba.length);
    for (let x = 0; x < width; x++) {
      const a = Math.max(0, x - 1), b = Math.min(width - 1, x + 1);
      const v = (rgba[a * 4] + rgba[x * 4] + rgba[b * 4]) / 3 + (rnd() - 0.5) * 36;
      blurred[x * 4] = blurred[x * 4 + 1] = blurred[x * 4 + 2] = v;
      blurred[x * 4 + 3] = 255;
    }
    assert.equal(decodeEan13(binarizeRow(blurred, width)), '4006381333931', `module ${module}px`);
  }
});

test('aucun faux positif : bruit binaire, plages aléatoires, ligne vide, clé invalide', () => {
  assert.equal(decodeEan13([]), null);
  assert.equal(decodeEan13(new Array(500).fill(0)), null);
  assert.equal(decodeEan13(new Array(500).fill(1)), null);
  const rnd = prng(12345);
  let hits = 0;
  for (let t = 0; t < 500; t++) { // bruit binaire
    if (decodeEan13Any(Array.from({ length: 700 }, () => (rnd() > 0.5 ? 1 : 0)))) hits++;
  }
  for (let t = 0; t < 500; t++) { // alternance de plages de 1 à 6 px (texte, motifs)
    const bits = [];
    let v = 0;
    while (bits.length < 700) { const n = 1 + Math.floor(rnd() * 6); for (let k = 0; k < n; k++) bits.push(v); v ^= 1; }
    if (decodeEan13Any(bits)) hits++;
  }
  assert.equal(hits, 0, `${hits} faux positifs sur 1000 lignes de bruit`);
  // Code à clé invalide : refusé même si la structure est parfaite
  const toBits = (mm) => [...('0'.repeat(12) + mm + '0'.repeat(12))].map(Number);
  assert.equal(decodeEan13(toBits(ean13Modules('4006381333932'))), null);
  assert.equal(decodeEan13(toBits(ean13Modules('4006381333931'))), '4006381333931');
  // Sans zone de silence : refusé
  assert.equal(decodeEan13([...ean13Modules('4006381333931')].map(Number)), null);
});

test('runLengths', () => {
  assert.deepEqual(runLengths([1, 1, 0, 1, 0, 0, 0]), [2, 1, 1, 3]);
  assert.deepEqual(runLengths([]), []);
  assert.deepEqual(runLengths([1]), [1]);
});
