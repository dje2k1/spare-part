// Génère les icônes PWA (PNG) avec la vraie police de la marque, via Chromium (Playwright).
//   npm run icons            (nécessite `npm install` + `npm run vendor` au préalable)
// Motif : une plaque émaillée — aplat bleu émail, liseré blanc intérieur, « M » en Archivo étroit et gras.
import { chromium } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const font = readFileSync(join(root, 'fonts/archivo-variable.woff2')).toString('base64');
const ENAMEL = '#1b3d93';

// scale = part du carré occupée par la plaque (0,72 pour « maskable » : zone de sécurité Android).
const page = (size, scale) => {
  const plate = Math.round(size * scale);
  const inset = Math.round(plate * 0.11);
  const line = Math.max(2, Math.round(plate * 0.035));
  return `<!doctype html><meta charset="utf-8"><style>
@font-face{font-family:AR;src:url(data:font/woff2;base64,${font}) format("woff2");font-weight:100 900;font-stretch:62% 125%}
html,body{margin:0;background:${ENAMEL}}
.i{width:${size}px;height:${size}px;display:grid;place-items:center;background:${ENAMEL}}
.p{position:relative;width:${plate}px;height:${plate}px;display:grid;place-items:center}
.p::before{content:'';position:absolute;inset:${inset}px;border:${line}px solid #fff;border-radius:${Math.round(plate * 0.13)}px}
.m{font:800 ${Math.round(plate * 0.56)}px/1 AR,system-ui,sans-serif;font-stretch:70%;color:#fff;will-change:transform;margin-top:${Math.round(plate * 0.02)}px}
</style><div class="i"><div class="p"><div class="m">M</div></div></div>`;
};

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
