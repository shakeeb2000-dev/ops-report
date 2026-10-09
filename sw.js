/* Offline cache. The plant has patchy signal, so every asset the app
   needs is precached and served cache-first. */

const CACHE = 'ops-report-6f839fe20fa5';

const ASSETS = ['./', 'index.html', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];

/* Fetches one asset and stores it, preferring a copy straight from the server.

   `cache: 'reload'` bypasses the browser's own HTTP cache, without which the
   install can store the stale copy the browser already had and the phone keeps
   showing the previous build. But that needs the network, so a flaky morning
   would fail the whole install - and an install that never completes leaves
   nothing cached to open offline. The browser's own copy is the fallback. */
async function cacheOne(cache, url) {
  try {
    await cache.add(new Request(url, { cache: 'reload' }));
    return true;
  } catch (err) {
    try {
      await cache.add(url);
      return true;
    } catch {
      return false;
    }
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const done = await Promise.all(ASSETS.map(u => cacheOne(cache, u)));
    // The page itself is the one asset that cannot be done without.
    const shell = await cache.match('index.html', { ignoreSearch: true });
    if (!shell) throw new Error('index.html could not be cached');
    if (done.some(ok => !ok)) console.warn('some assets were not cached');
    await self.skipWaiting();
  })());
});

/* A new worker normally waits for the old one to let go, which on a phone can
   mean never: the app is rarely closed properly. Settings asks for this so an
   update can be taken on demand. */
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  /* Opening the app must never depend on the network.

     Any navigation is answered with the cached page, whatever address was
     used - a bare address without its trailing slash, a shortcut carrying a
     query string, anything. Those used to miss the cache and fall through to
     the network, which on a morning with no signal is a blank screen. */
  const isNavigation = req.mode === 'navigate'
    || (req.headers.get('accept') || '').includes('text/html');

  event.respondWith((async () => {
    const hit = await caches.match(req, { ignoreSearch: true });
    if (hit) return hit;

    try {
      const res = await fetch(req);
      // Keep the cache warm for anything new we successfully fetch.
      if (res && res.status === 200 && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
      }
      return res;
    } catch (err) {
      const shell = await caches.match('index.html', { ignoreSearch: true });
      if (isNavigation && shell) return shell;
      if (shell && !isNavigation) {
        // Not a page and not cached: say so plainly rather than hang.
        return new Response('', { status: 504, statusText: 'Offline' });
      }
      throw err;
    }
  })());
});
