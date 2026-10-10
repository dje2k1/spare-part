// Serveur statique minimal pour les tests : sert le dépôt sous le préfixe /spare-part/ (comme GitHub Pages),
// avec les types MIME corrects pour les modules ES, le manifeste, les polices et le service worker.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PREFIX = process.env.PREFIX ?? '/spare-part/';
const PORT = Number(process.env.PORT || 4173);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

export function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (!url.pathname.startsWith(PREFIX)) { res.writeHead(url.pathname === '/' ? 302 : 404, { Location: PREFIX }); return res.end(); }
      let rel = decodeURIComponent(url.pathname.slice(PREFIX.length)) || 'index.html';
      if (rel.endsWith('/')) rel += 'index.html';
      const file = normalize(join(root, rel));
      if (!file.startsWith(root) || /(^|\/)(node_modules|\.git|tests)(\/|$)/.test(rel)) { res.writeHead(403); return res.end(); }
      if (!(await stat(file)).isFile()) throw new Error('not a file');
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
      let body = await readFile(file);
      // Hook de test : le cookie « swv=x.y.z » fait annoncer une autre version par sw.js (simule un déploiement, sans toucher aux autres tests).
      const swv = /(?:^|;\s*)swv=([\w.-]+)/.exec(req.headers.cookie ?? '')?.[1];
      if (swv && rel === 'sw.js') body = Buffer.from(body.toString().replace(/const VERSION = '[^']*'/, `const VERSION = '${swv}'`));
      res.end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createServer().listen(PORT, '127.0.0.1', () => console.log(`http://127.0.0.1:${PORT}${PREFIX}`));
}
