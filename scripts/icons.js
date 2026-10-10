// Génère les icônes PWA (PNG) avec la vraie police de la marque, via Chromium (Playwright).
//   npm run icons            (nécessite `npm install` + `npm run vendor` au préalable)
import { chromium } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const font = readFileSync(join(root, 'fonts/playfair-display-500.woff2')).toString('base64');
const INK = '#111111', GOLD = '#a08947';

// scale = part du carré occupée par le motif (0,72 pour « maskable » : zone de sécurité Android).
const page = (size, scale) => `<!doctype html><meta charset="utf-8"><style>
@font-face{font-family:PF;src:url(data:font/woff2;base64,${font}) format("woff2");font-weight:500}
html,body{margin:0;background:${INK}}
.i{width:${size}px;height:${size}px;display:flex;flex-direction:column;align-items:center;justify-content:center;background:${INK}}
.m{font:500 ${Math.round(size * 0.6 * scale)}px/1 PF,Georgia,serif;color:#fff;margin-top:${Math.round(-size * 0.04 * scale)}px}
.b{width:${Math.round(size * 0.3 * scale)}px;height:${Math.max(2, Math.round(size * 0.014 * scale))}px;background:${GOLD};margin-top:${Math.round(size * 0.035 * scale)}px}
</style><div class="i"><div class="m">M</div><div class="b"></div></div>`;

const OUT = [
  ['icons/icon-192.png', 192, 1],
  ['icons/icon-512.png', 512, 1],
  ['icons/icon-maskable-512.png', 512, 0.72],
  ['icons/apple-touch-icon.png', 180, 1],
  ['icons/favicon-32.png', 32, 1],
];

mkdirSync(join(root, 'icons'), { recursive: true });
const exe = process.env.CHROMIUM_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const browser = await chromium.launch({ executablePath: exe });
for (const [file, size, scale] of OUT) {
  const p = await browser.newPage({ viewport: { width: size, height: size } });
  await p.setContent(page(size, scale));
  await p.evaluate(() => document.fonts.ready);
  writeFileSync(join(root, file), await p.screenshot({ clip: { x: 0, y: 0, width: size, height: size } }));
  await p.close();
  console.log('✓', file);
}
await browser.close();
