/* Checks on sw.js - the part of the app that saves a copy on the phone so it
   opens with no signal. It had no checks of its own, yet it decides whether
   the app opens on a morning with no signal, and what happens when an upload
   lands half-finished.

   Run: node tools/sw_test.js

   The worker is run the way bundle.py ships it: a cache name that carries a
   build id, and the flattened asset list. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const BASE = 'https://phone.test/ops-report/';
const NEW = 'aaaaaaaaaaaa';
const OLD = 'bbbbbbbbbbbb';

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${extra !== undefined ? ' :: ' + extra : ''}`);
  }
}

function worker(build) {
  let src = fs.readFileSync(path.join(__dirname, '..', 'www', 'sw.js'), 'utf8');
  const cache = /const CACHE = '[^']*';/;
  const assets = /const ASSETS = \[[^\]]*\];/;
  if (!cache.test(src) || !assets.test(src)) throw new Error('bundle.py could not rewrite sw.js');
  if (build) src = src.replace(cache, `const CACHE = 'ops-report-${build}';`);
  return src.replace(assets,
    "const ASSETS = ['./', 'index.html', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];");
}

const page = (build) => `<html><head><meta name="build-id" content="${build}"></head></html>`;
const serverOf = (build) => ({
  online: true,
  files: { '': page(build), 'index.html': page(build), 'manifest.webmanifest': '{}',
    'icon-192.png': 'x', 'icon-512.png': 'x' }
});

/* A stand-in phone: cache stores that match the way the real ones do, a server
   that can be switched off, and the events the worker listens for. */
function phone(build, server, preset) {
  const stores = new Map(preset || []);
  const handlers = {};
  const log = { skip: 0, claim: 0, fetched: [] };

  class Req extends Request {
    constructor(input, init) { super(typeof input === 'string' ? new URL(input, BASE).href : input, init); }
  }
  const norm = (r, noSearch) => {
    const u = new URL(typeof r === 'string' ? new URL(r, BASE).href : r.url);
    if (noSearch) u.search = '';
    return u.href;
  };
  const cacheOf = (map) => ({
    async add(r) {
      const req = typeof r === 'string' ? new Req(r) : r;
      const res = await sb.fetch(req);
      if (!res.ok) throw new TypeError('bad status ' + res.status);
      map.set(norm(req), res);
    },
    async put(r, res) { map.set(norm(r), res); },
    async match(r, o) {
      const want = norm(r, o && o.ignoreSearch);
      for (const [k, v] of map) if (norm(k, o && o.ignoreSearch) === want) return v.clone();
      return undefined;
    }
  });
  const sb = {
    console: { warn() {}, log() {}, error() {} },
    Request: Req, Response, Headers, URL, Promise, Error, TypeError, JSON, Math, Array, Object, String, RegExp,
    caches: {
      async open(n) { if (!stores.has(n)) stores.set(n, new Map()); return cacheOf(stores.get(n)); },
      async keys() { return Array.from(stores.keys()); },
      async delete(n) { return stores.delete(n); },
      async match(r, o) {
        for (const m of stores.values()) { const hit = await cacheOf(m).match(r, o); if (hit) return hit; }
        return undefined;
      }
    },
    fetch: async (req) => {
      const url = norm(req, true);
      log.fetched.push(url);
      if (!server.online) throw new TypeError('Failed to fetch');
      const body = server.files[url.replace(BASE, '')];
      if (body === undefined) return new Response('not found', { status: 404 });
      const res = new Response(body, { status: 200 });
      Object.defineProperty(res, 'type', { value: 'basic' });
      return res;
    },
    registration: { scope: BASE },
    clients: { claim: async () => { log.claim++; } },
    skipWaiting: async () => { log.skip++; },
    addEventListener: (t, fn) => { handlers[t] = fn; }
  };
  sb.self = sb;
  vm.createContext(sb);
  vm.runInContext(worker(build), sb, { filename: 'sw.js' });

  const fire = async (type) => {
    let pending;
    handlers[type]({ waitUntil: (p) => { pending = p; } });
    await pending;
  };
  return {
    stores, log, caches: sb.caches,
    install: () => fire('install'),
    activate: () => fire('activate'),
    async open(url, navigate = true) {
      const req = { method: 'GET', url: new URL(url, BASE).href, mode: navigate ? 'navigate' : 'no-cors',
        headers: new Headers(navigate ? { accept: 'text/html' } : {}) };
      let answer;
      handlers.fetch({ request: req, respondWith: (p) => { answer = p; } });
      try { return await answer; } catch { return 'ERROR'; }
    }
  };
}

const tryInstall = async (p) => { try { await p.install(); return null; } catch (e) { return e; } };

async function main() {
  console.log('\n1. Saving a copy on the phone');
  {
    const p = phone(NEW, serverOf(NEW));
    await p.install();
    const saved = await p.caches.open(`ops-report-${NEW}`);
    check('the page is saved', !!(await saved.match('index.html')));
    check('so is the plain address, which is how most opens arrive', !!(await saved.match(BASE)));
    check('and the manifest and both icons',
      !!(await saved.match('manifest.webmanifest')) && !!(await saved.match('icon-192.png'))
      && !!(await saved.match('icon-512.png')));
    check('the new copy takes over straight away', p.log.skip === 1);
    await p.activate();
    check('and the phone hands the page to it', p.log.claim === 1);
  }

  console.log('\n2. Opening with no signal');
  {
    const server = serverOf(NEW);
    const p = phone(NEW, server);
    await p.install();
    server.online = false;
    p.log.fetched.length = 0;
    for (const [what, url] of [['the plain address', BASE], ['index.html', BASE + 'index.html'],
      ['an address with ?from=shortcut on it', BASE + '?from=shortcut'], ['index.html?x=1', BASE + 'index.html?x=1']]) {
      const res = await p.open(url);
      check(`${what} opens the app`, res !== 'ERROR' && res.status === 200 && (await res.text()).includes(NEW));
    }
    check('and none of them went to the internet', p.log.fetched.length === 0, p.log.fetched.join(','));
    const odd = await p.open(BASE + 'never-saved');
    check('a page that was never saved still lands on the app, not an error',
      odd !== 'ERROR' && (await odd.text()).includes(NEW));
    check('a file that was never saved answers "offline" instead of hanging',
      (await p.open(BASE + 'photo.jpg', false)).status === 504);
  }

  console.log('\n3. A phone with no saved copy and no signal');
  {
    const server = serverOf(NEW);
    server.online = false;
    const res = await phone(NEW, server).open(BASE);
    check('gets a message instead of the browser\'s error page', res !== 'ERROR');
    const text = res === 'ERROR' ? '' : await res.text();
    check('that says what is wrong', /not saved its own copy/.test(text));
    check('and what to do', /get some signal/i.test(text) && /Try again/.test(text));
    check('and where saved reports can be recovered from', /Load a backup/.test(text));
    check('and is never stored as if it were the app',
      res.status === 503 && /no-store/.test(res.headers.get('Cache-Control')));
  }

  console.log('\n4. An upload that lands half-finished');
  {
    // The phone holds the old build. The new sw.js reaches it first; the page on
    // the server is still the old one.
    const server = serverOf(OLD);
    const old = phone(OLD, server);
    await old.install();
    const held = new Map([[`ops-report-${OLD}`, old.stores.get(`ops-report-${OLD}`)]]);

    const early = phone(NEW, server, held);
    const refused = await tryInstall(early);
    check('a new worker refuses to install while the page is still the old build', !!refused);
    check('so it never takes over', early.log.skip === 0);
    check('and saves nothing under the new name', !early.stores.has(`ops-report-${NEW}`),
      Array.from(early.stores.keys()).join(','));
    const kept = await early.caches.match(BASE + 'index.html');
    check('the copy the phone was relying on is untouched', !!kept && (await kept.text()).includes(OLD));

    // Only sw.js changed, so the new worker shares the old cache's name.
    const sameName = phone(OLD, serverOf(NEW), held);
    const refused2 = await tryInstall(sameName);
    const kept2 = await sameName.caches.match(BASE + 'index.html');
    check('refusing never wipes a cache of the same name',
      !!refused2 && !!kept2 && (await kept2.text()).includes(OLD));

    // A moment later the page has arrived.
    server.files[''] = page(NEW);
    server.files['index.html'] = page(NEW);
    const later = phone(NEW, server, held);
    check('once both files are up, the next try installs the new build',
      (await tryInstall(later)) === null && later.log.skip === 1);
  }

  console.log('\n5. When it cannot tell');
  {
    const offline = serverOf(NEW);
    offline.online = false;
    const p = phone(NEW, offline);
    check('an install with no signal fails, so the old copy stays in charge',
      !!(await tryInstall(p)) && p.log.skip === 0);

    const lost = serverOf(NEW);
    delete lost.files[''];
    check('a server that cannot show the folder page does not block the install',
      (await tryInstall(phone(NEW, lost))) === null);

    check('run straight from the source folder (no build id) the version check steps aside',
      (await tryInstall(phone(null, serverOf(OLD)))) === null);
  }

  console.log('\n6. Tidying up');
  {
    const p = phone(NEW, serverOf(NEW), new Map([[`ops-report-${OLD}`, new Map()]]));
    await p.install();
    await p.activate();
    const names = await p.caches.keys();
    check('an activated worker clears out the old copies', names.length === 1 && names[0] === `ops-report-${NEW}`,
      names.join(','));
  }

  console.log('\n' + '='.repeat(52));
  if (failures) {
    console.log(`FAILED ${failures} check(s)`);
    process.exit(1);
  }
  console.log('All offline-copy tests passed.');
}

main().catch(e => {
  console.error('\nHARNESS CRASHED:', e);
  process.exit(1);
});
