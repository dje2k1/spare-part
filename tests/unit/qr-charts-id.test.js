import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { qrMatrix, qrSvg, locationPayload, parseLocationPayload } from '../../js/lib/qr.js';
import { niceTicks, lineChart, sparkline } from '../../js/lib/charts.js';
import { uid, isUid, randomB64, bytesToB64, b64ToBytes } from '../../js/lib/id.js';

const require = createRequire(import.meta.url);

test('QR : sans bibliothèque → repli explicite (pas d\'exception)', () => {
  delete globalThis.qrcode;
  assert.equal(qrMatrix('x'), null);
  assert.match(qrSvg('x').value, /QR indisponible/);
});

test('QR : motifs de repérage et de synchronisation conformes à la norme', () => {
  globalThis.qrcode = require('../../vendor/qrcode.js');
  const m = qrMatrix('LOC:R1-A2-E1-C1:abcd1234');
  const n = m.length;
  assert.equal((n - 17) % 4, 0, 'taille = 17 + 4×version');
  const finder = ['1111111', '1000001', '1011101', '1011101', '1011101', '1000001', '1111111'];
  const at = (r0, c0) => finder.every((row, dr) => [...row].every((ch, dc) => m[r0 + dr][c0 + dc] === (ch === '1')));
  assert.ok(at(0, 0), 'repère haut-gauche');
  assert.ok(at(0, n - 7), 'repère haut-droite');
  assert.ok(at(n - 7, 0), 'repère bas-gauche');
  for (let i = 8; i < n - 8; i++) {
    assert.equal(m[6][i], i % 2 === 0, `synchro horizontale ${i}`);
    assert.equal(m[i][6], i % 2 === 0, `synchro verticale ${i}`);
  }
  const svg = qrSvg('LOC:R1-A2-E1-C1:abcd1234', { label: 'LOC:R1-A2-E1-C1' }).value;
  assert.match(svg, /^<svg[^>]+viewBox="0 0 \d+ \d+"/);
  assert.ok(!svg.includes('NaN'));
  assert.match(svg, /aria-label="LOC:R1-A2-E1-C1"/);
});

test('QR : le libellé ARIA ne peut pas injecter d\'attribut', () => {
  globalThis.qrcode = require('../../vendor/qrcode.js');
  const svg = qrSvg('x', { label: '"><script>alert(1)</script>' }).value;
  assert.ok(!svg.includes('<script'));
  assert.ok(!svg.includes('">'.repeat(2)));
});

test('contenu des QR d\'emplacement : format historique conservé', () => {
  assert.equal(locationPayload('R1-A2-E1-C1', 'abc12345'), 'LOC:R1-A2-E1-C1:abc12345');
  assert.deepEqual(parseLocationPayload('LOC:R1-A2-E1-C1:abc12345'), { code: 'R1-A2-E1-C1', depotId: 'abc12345' });
  assert.deepEqual(parseLocationPayload('LOC:r1-a1'), { code: 'R1-A1', depotId: null });
  for (const bad of ['3700089690011', 'LOC:', 'LOC:<script>', 'LOC:R1:xx yy', 'loc2:R1', null, '']) {
    assert.equal(parseLocationPayload(bad), null, `refuser ${JSON.stringify(bad)}`);
  }
});

test('niceTicks', () => {
  const t = niceTicks(0, 1045);
  assert.equal(t.min, 0);
  assert.ok(t.max >= 1045);
  assert.ok(t.ticks.length >= 3 && t.ticks.length <= 8);
  // Courbe quasi plate : la plage doit s'élargir au lieu de répéter la même graduation
  const flat = niceTicks(1044, 1045);
  assert.equal(new Set(flat.ticks).size, flat.ticks.length);
  const same = niceTicks(5, 5);
  assert.ok(same.max > same.min);
  assert.deepEqual(niceTicks(NaN, 3).ticks, [0, 1]);
});

test('lineChart : jamais de NaN/undefined (série vide, 1 point, plate, aléatoire)', () => {
  const series = [
    [], [{ label: '1/1', value: 5 }],
    Array.from({ length: 30 }, (_, i) => ({ label: `${i}`, value: 1045 })),
    Array.from({ length: 30 }, (_, i) => ({ label: `${i}`, value: (i * 37) % 11 })),
    Array.from({ length: 2 }, (_, i) => ({ label: `${i}`, value: 0 })),
  ];
  for (const s of series) {
    const out = lineChart(s, { title: 'Test' }).value;
    assert.ok(out.startsWith('<svg'), 'svg');
    assert.ok(!/NaN|undefined|Infinity/.test(out), out.slice(0, 200));
    assert.match(out, /aria-label="Test/);
  }
});

test('lineChart : axe Y gradué sans doublon sur une courbe presque plate', () => {
  const out = lineChart([{ label: 'a', value: 1044 }, { label: 'b', value: 1045 }]).value;
  const labels = [...out.matchAll(/class="chart__label" x="[\d.]+" y="[\d.]+" text-anchor="end">([^<]+)</g)].map((m) => m[1]);
  assert.equal(new Set(labels).size, labels.length, `graduations en double : ${labels}`);
});

test('sparkline', () => {
  assert.equal(sparkline([1]).value, '');
  assert.ok(!sparkline([3, 3, 3]).value.includes('NaN'));
});

test('uid : unique, caractères sûrs, triable dans le temps', () => {
  const seen = new Set();
  for (let i = 0; i < 5000; i++) {
    const u = uid();
    assert.match(u, /^[0-9a-z]{20}$/);
    seen.add(u);
  }
  assert.equal(seen.size, 5000);
  assert.ok(uid(1_000_000) < uid(2_000_000));
  assert.ok(isUid(uid()));
  for (const bad of ['', 'AB', 'a b', '<x>', null, 'x'.repeat(50)]) assert.ok(!isUid(bad));
});

test('base64 : aller-retour d\'octets et sels distincts', () => {
  const bytes = Uint8Array.from([0, 1, 2, 250, 255]);
  assert.deepEqual([...b64ToBytes(bytesToB64(bytes))], [...bytes]);
  assert.notEqual(randomB64(16), randomB64(16));
});
