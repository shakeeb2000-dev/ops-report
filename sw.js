/* Offline cache. The plant has patchy signal, so every asset the app
   needs is precached and served cache-first. */

const CACHE = 'ops-report-9adcbc8fa5fe';

const ASSETS = ['./', 'index.html', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];

/* What a phone shows when it has no saved copy of the app and no signal to get
   one. Without this the browser puts up its own error page, which says nothing
   about what to do next. It lives inside this file because it cannot depend on
   anything that might be the very thing that is missing. */
const OFFLINE_PAGE = '<!doctype html><html lang="en"><head><meta charset="utf-8">'
  + '<meta name="viewport" content="width=device-width, initial-scale=1">'
  + '<title>Ops Report - not ready</title></head>'
  + '<body style="margin:0;padding:28px 22px;font:17px/1.5 -apple-system,Roboto,Arial,sans-serif;'
  + 'color:#1a202c;background:#f4f6f8">'
  + '<h1 style="margin:0 0 12px;font-size:1.3rem;color:#1e3a5f">The app cannot open yet</h1>'
  + '<p>This phone has not saved its own copy of the app, and there is no signal to get it.</p>'
  + '<p><strong>What to do:</strong> get some signal (move outside, or use Wi-Fi), then tap the button below. '
  + 'Once it opens it saves itself again, and from then on it works with no signal.</p>'
  + '<p>Your saved reports are kept inside the app. If they are missing once it opens, '
  + 'use <strong>Settings &rarr; Backup &rarr; Load a backup</strong>.</p>'
  + '<p><button onclick="location.reload()" style="font:inherit;font-weight:700;color:#fff;'
  + 'background:#1e3a5f;border:0;border-radius:11px;padding:14px 22px">Try again</button></p>'
  + '</body></html>';

/* The build a worker was made for is the last part of its cache name, and the
   same twelve characters sit in the build-id tag of the page it belongs with.
   (Run straight from the source folder there is no build id, and the check
   below steps aside.) */
function buildOf(cacheName) {
  const m = /-([0-9a-f]{12})$/.exec(cacheName);
  return m ? m[1] : null;
}

function isThisBuild(html, build) {
  return html.indexOf(`name="build-id" content="${build}"`) !== -1;
}

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

/* Does the page on the server belong with this worker?

   After an upload GitHub can hand out the new sw.js a moment before the new
   index.html. A worker installed in that gap saved the OLD page under the NEW
   name, and then nothing ever corrected it: the phone sat on the old version,
   said it was up to date, and only another upload shook it loose.

   Asked BEFORE anything is saved, so a "no" cannot disturb the copy the phone
   is relying on - that matters when only sw.js changed and the new worker
   shares the old one's cache name. Only a clear "that is a different build"
   counts as no. With no signal to ask with, or an answer that is not a page,
   the normal install carries on and does what it always did. */
async function pageMatchesBuild(build) {
  try {
    const res = await fetch(new Request(self.registration.scope, { cache: 'reload' }));
    if (!res.ok) return true;
    return isThisBuild(await res.text(), build);
  } catch {
    return true;
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    /* Refusing the install leaves the previous worker, and the page it saved,
       in charge. The app asks again every time it opens with signal, by which
       time both files have arrived. (Run straight from the source folder there
       is no build id, and this steps aside.) */
    const build = buildOf(CACHE);
    if (build && !(await pageMatchesBuild(build))) {
      throw new Error(`the page on the server is not build ${build} yet - will try again`);
    }

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

     Any navigation inside this folder is answered with the cached page,
     whatever it carries on the end - a shortcut with a query string, the bare
     folder, index.html itself. Those used to miss the cache and fall through
     to the network, which on a morning with no signal is a blank screen.

     (An address typed without the final "/" is outside this folder as far as
     the browser is concerned, so nothing here can answer it. That one needs
     the app's own icon, or the address ending in a slash.) */
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
      // A page that cannot be opened at all: say what to do, not "ERR_FAILED".
      if (isNavigation) {
        return new Response(OFFLINE_PAGE, {
          status: 503,
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
        });
      }
      if (shell) {
        // Not a page and not cached: say so plainly rather than hang.
        return new Response('', { status: 504, statusText: 'Offline' });
      }
      throw err;
    }
  })());
});
