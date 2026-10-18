// package 88e1f2236e16c0ab
const SCOPE = new URL(self.registration.scope);
const BASE = SCOPE.pathname;
const NAMESPACE = BASE === '/' ? 'delta' : `delta-scope-${encodeURIComponent(BASE)}`;
const META = `${NAMESPACE}-offline-meta`;
const PACKAGE_PREFIX = `${NAMESPACE}-package-`;
const scopedPath = path => `${BASE}${path}`;
let installedPackage;
async function activeCache() {
  const marker = await (await caches.open(META)).match(scopedPath('__delta_active'));
  return marker ? marker.text() : null;
}
async function preparePackage() {
  const response = await fetch(scopedPath('offline-manifest.json'), { cache: 'no-store' });
  if (!response.ok) throw Error('Offline package manifest is unavailable.');
  const manifest = await response.json();
  if (!manifest.version || !Array.isArray(manifest.files) || !manifest.files.some(file => file.url === scopedPath('index.html'))) throw Error('Offline package manifest is incomplete.');
  const name = `${PACKAGE_PREFIX}${manifest.version}`;
  // An already committed version is immutable; never damage it during a retry.
  if (name === await activeCache()) return name;
  try {
    await caches.delete(name);
    const cache = await caches.open(name);
    for (const file of manifest.files) {
      const url = new URL(file.url, location.origin);
      if (url.origin !== SCOPE.origin || !url.pathname.startsWith(BASE) || url.search || url.hash || !file.sha256) throw Error('Invalid offline package entry.');
      const res = await fetch(file.url, { cache: 'no-store' });
      if (!res.ok) throw Error(`Download failed: ${file.url}`);
      const bytes = await res.clone().arrayBuffer();
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
      if (digest !== file.sha256) throw Error(`Offline package checksum failed: ${file.url}`);
      await cache.put(file.url, res);
    }
    await cache.put(BASE, await cache.match(scopedPath('index.html')));
    await cache.put(scopedPath('__delta_complete'), new Response('ready'));
    return name;
  } catch (error) {
    await caches.delete(name);
    throw error;
  }
}
async function commitPackage(name) {
  const previous = await activeCache();
  if (previous && previous !== name) await (await caches.open(previous)).put(scopedPath('__delta_complete'), new Response('ready'));
  await (await caches.open(META)).put(scopedPath('__delta_active'), new Response(name));
  // Keep earlier versions for open tabs that still request their hashed chunks.
}
self.addEventListener('install', event => event.waitUntil((async () => {
  installedPackage = await preparePackage();
  await (await caches.open(META)).put(scopedPath('__delta_pending'), new Response(installedPackage));
  await self.skipWaiting();
})()));
self.addEventListener('activate', event => event.waitUntil((async () => {
  const pending = await (await caches.open(META)).match(scopedPath('__delta_pending'));
  if (pending) await commitPackage(await pending.text());
  await self.clients.claim();
})()));
self.addEventListener('message', event => event.waitUntil((async () => {
  try {
    if (event.data?.type === 'STATUS') {
      event.ports?.[0]?.postMessage({ ok: !!await activeCache() });
    } else if (event.data?.type === 'CACHE_OFFLINE') {
      await commitPackage(await preparePackage());
      event.ports?.[0]?.postMessage({ ok: true });
    }
  } catch (error) {
    event.ports?.[0]?.postMessage({ ok: false, error: error.message });
  }
})()));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== SCOPE.origin || !url.pathname.startsWith(BASE)) return;
  event.respondWith((async () => {
    const active = await activeCache();
    if (active) {
      const cached = await (await caches.open(active)).match(event.request, { ignoreSearch: true, ignoreVary: true });
      if (cached) return cached;
      // Incomplete downloads never appear as fallbacks.
      for (const name of (await caches.keys()).filter(name => name.startsWith(PACKAGE_PREFIX) && name !== active)) {
        const cache = await caches.open(name);
        if (!await cache.match(scopedPath('__delta_complete'))) continue;
        const old = await cache.match(event.request, { ignoreSearch: true, ignoreVary: true });
        if (old) return old;
      }
    }
    return fetch(event.request);
  })());
});
