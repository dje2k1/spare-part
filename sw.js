// Service worker MODE Stock — fonctionnement hors-ligne.
// Toute l'application est pré-chargée à l'installation dans un cache versionné : les fichiers servis sont
// toujours d'une MÊME version (jamais de mélange ancien/nouveau). Une mise à jour est proposée à
// l'utilisateur (bandeau « Mettre à jour ») au lieu d'être imposée en pleine saisie.
//
// ⚠ La liste PRECACHE est générée : `npm run sw` (vérifiée par tests/unit/pwa.test.js).
const VERSION = '3.1.0-350b4dbd';
const CACHE = `mode-stock-${VERSION}`;

// <PRECACHE>
const PRECACHE = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/base.css',
  'css/components.css',
  'css/print.css',
  'css/tokens.css',
  'css/views.css',
  'css/work.css',
  'fonts/jost-variable.woff2',
  'fonts/playfair-display-400-italic.woff2',
  'fonts/playfair-display-400.woff2',
  'fonts/playfair-display-500.woff2',
  'icons/apple-touch-icon.png',
  'icons/favicon-32.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'js/core/ai.js',
  'js/core/auth.js',
  'js/core/config.js',
  'js/core/ops-kit.js',
  'js/core/ops-orders.js',
  'js/core/ops.js',
  'js/core/planning.js',
  'js/core/queries.js',
  'js/core/recorder.js',
  'js/core/registry.js',
  'js/core/schema.js',
  'js/core/seed.js',
  'js/core/store.js',
  'js/core/sync-engine.js',
  'js/lib/charts.js',
  'js/lib/csv.js',
  'js/lib/ean.js',
  'js/lib/id.js',
  'js/lib/image.js',
  'js/lib/labels.js',
  'js/lib/qr.js',
  'js/lib/text.js',
  'js/main.js',
  'js/ui/briefing.js',
  'js/ui/codebar.js',
  'js/ui/components.js',
  'js/ui/dialogs.js',
  'js/ui/dom.js',
  'js/ui/feedback.js',
  'js/ui/idb.js',
  'js/ui/keypad.js',
  'js/ui/look.js',
  'js/ui/menu.js',
  'js/ui/net.js',
  'js/ui/print.js',
  'js/ui/router.js',
  'js/ui/routes.js',
  'js/ui/scanner.js',
  'js/ui/session.js',
  'js/ui/state.js',
  'js/ui/sync-ui.js',
  'js/ui/toast.js',
  'js/ui/views/admin.js',
  'js/ui/views/article-sheet.js',
  'js/ui/views/articles.js',
  'js/ui/views/dashboard.js',
  'js/ui/views/home.js',
  'js/ui/views/inventory.js',
  'js/ui/views/journal.js',
  'js/ui/views/labels.js',
  'js/ui/views/levels.js',
  'js/ui/views/login.js',
  'js/ui/views/order-cart.js',
  'js/ui/views/orders.js',
  'js/ui/views/photo.js',
  'js/ui/views/pick.js',
  'js/ui/views/plan.js',
  'js/ui/views/purchases.js',
  'js/ui/views/receive.js',
  'js/ui/views/reports.js',
  'js/ui/views/scan.js',
  'js/ui/views/transfers.js',
  'vendor/html5-qrcode.min.js',
  'vendor/qrcode.js',
];
// </PRECACHE>

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // `reload` : contourne le cache HTTP (GitHub Pages met les fichiers en cache ~10 min)
    await Promise.all(PRECACHE.map(async (url) => {
      const res = await fetch(new Request(url, { cache: 'reload' }));
      if (!res.ok) throw new Error(`Précache impossible : ${url} (${res.status})`);
      await cache.put(url, res);
    }));
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('mode-stock-') && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // API Anthropic et tout tiers : jamais interceptés
  if (url.pathname.startsWith(new URL('api/', self.registration.scope).pathname)) return; // serveur de synchronisation : toujours en direct
  event.respondWith((async () => {
    const hit = await caches.match(request, { ignoreSearch: true });
    if (hit) return hit;
    try { return await fetch(request); } catch {
      if (request.mode === 'navigate') return (await caches.match('index.html')) || Response.error();
      return Response.error();
    }
  })());
});
