'use strict';
const CACHE = 'gpu-observatory-public-v7';
// An explicit public-only allowlist: never cache dashboard HTML, sessions or APIs.
const PUBLIC = ['/offline.html', '/pwa.css', '/icons/app-192.png', '/i18n.js'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(PUBLIC)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});
self.addEventListener('fetch', event => {
  const request = event.request, url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (request.mode === 'navigate') {
    // Even an authenticated HTML response is network-only. HTTP errors are not cached.
    event.respondWith(fetch(request).catch(async () => {
      const cache = await caches.open(CACHE);
      return await cache.match('/offline.html') || new Response('暂时离线 / Offline. Reconnect to view live monitoring.', {status:503,headers:{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'}});
    }));
  } else if (PUBLIC.includes(url.pathname) && !url.search) {
    event.respondWith(fetch(request).catch(async () => {
      const cache = await caches.open(CACHE);
      return await cache.match(url.pathname) || Response.error();
    }));
  }
});
